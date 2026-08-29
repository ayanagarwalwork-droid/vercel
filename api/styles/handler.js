// Catch-all for /api/styles, /api/styles/upload-image, /api/styles/:code —
// consolidated into one file (was 3 separate files) to stay under Vercel
// Hobby's 12 serverless function limit. URL paths the frontend calls are
// unchanged.
//
// GET    /api/styles              — full list. Requires view on Styles.
// POST   /api/styles              — create via the SKU Engine RPC. Requires edit.
// POST   /api/styles/upload-image — mint a signed Storage upload URL. Requires edit.
// POST   /api/styles/same-pattern    — create a style reusing an existing style's pattern
//                                       number in a new category (no counter draw). Requires edit.
// POST   /api/styles/add-color-variant — create a new sibling style row for another color
//                                       of an existing pattern (same category+number, next
//                                       free letter). Requires edit.
// GET    /api/styles/costing         — every style's cost-breakdown line items, flat. Requires view on Costing.
// POST   /api/styles/costing         — replace one style's line items + its overhead %; always sets draft status. Requires edit on Costing.
// POST   /api/styles/costing-approve — mark a style's costing approved/live. Founder only, regardless of Costing permission.
// GET    /api/styles/:code        — one style. Requires view.
// PATCH  /api/styles/:code        — edit name/status/hsn/mrp/cost/description/images/sizes. Requires edit.
// DELETE /api/styles/:code        — requires edit.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');
const { syncSkusForStyle, syncSkusForColorCodedStyle } = require('../_lib/skus');
const { fetchAll } = require('../_lib/fetchAll');
const { splitCode, nextAvailableCode } = require('../_lib/styleCodes');

module.exports = withErrorHandling(async (req, res) => {
  // vercel.json rewrites /api/styles(/*) here, forwarding the sub-path (if
  // any) as ?path=... — a single string, since these routes never need
  // more than one segment (bare, /upload-image, or /:code).
  const params = req.query.path ? [req.query.path] : [];

  // GET/POST /api/styles
  if (params.length === 0) {
    if (req.method === 'GET') {
      await requireModulePermission(req, 'Styles', 'view');
      const data = await fetchAll(() =>
        supabaseAdmin.from('styles').select('*').order('added_at', { ascending: true }));
      return res.status(200).json({ data });
    }

    if (req.method === 'POST') {
      const { profile: actor } = await requireModulePermission(req, 'Styles', 'edit');

      const { category, name, status, colors, sizes, mrp, cost_price, hsn_code, description, images } = req.body || {};
      if (!category) throw new HttpError(400, 'Select a category.');
      if (!name || !String(name).trim()) throw new HttpError(400, 'Enter a style name.');
      if (!Array.isArray(sizes) || !sizes.length) throw new HttpError(400, 'Select at least one size.');
      const colorList = Array.isArray(colors) && colors.length ? colors : ['A'];

      const rpcArgs = {
        p_category: category, p_name: String(name).trim(), p_status: status || 'active',
        p_colors: colorList, p_sizes: sizes,
        p_mrp: mrp || null, p_cost_price: cost_price || null, p_hsn_code: hsn_code || null,
        p_description: description || null, p_images: images || [], p_created_by: actor.id,
      };

      let { data, error } = await supabaseAdmin.rpc('create_style_with_code', rpcArgs);
      if (error && error.code === '23505') {
        ({ data, error } = await supabaseAdmin.rpc('create_style_with_code', rpcArgs));
      }
      if (error) throw new HttpError(400, error.message);

      await syncSkusForStyle(data.code, colorList, sizes);

      await writeAudit({
        profile: actor, action: 'create', entity: 'Style',
        detail: `Created style ${data.code} — ${data.name}`,
      });

      return res.status(201).json({ data });
    }

    throw new HttpError(405, 'Method not allowed.');
  }

  // POST /api/styles/upload-image
  if (params.length === 1 && params[0] === 'upload-image') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    await requireModulePermission(req, 'Styles', 'edit');

    const { filename, styleCode } = req.body || {};
    if (!filename) throw new HttpError(400, 'Missing filename.');

    const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${styleCode || 'draft'}/${Date.now()}-${safeName}`;

    const { data, error } = await supabaseAdmin.storage.from('style-images').createSignedUploadUrl(path);
    if (error) throw new HttpError(500, error.message);

    return res.status(200).json({ data: { signedUrl: data.signedUrl, token: data.token, path } });
  }

  // POST /api/styles/same-pattern — reuse an existing style's pattern number
  // in a different category (e.g. AISW-208A's print, added to Beach Wear as
  // AIBW-208A). Deliberately does NOT call create_style_with_code / touch
  // style_number_counters — the number is reused, not drawn fresh. The name
  // is copied straight from the source (not asked for); the color always
  // follows the SKU Engine's own next-available-letter rule for that
  // category+number — same rule add-color-variant uses — never copied from
  // the source and never a hard "already exists" error.
  if (params.length === 1 && params[0] === 'same-pattern') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const { profile: actor } = await requireModulePermission(req, 'Styles', 'edit');

    const { source_code, category, description, sizes } = req.body || {};
    if (!source_code) throw new HttpError(400, 'Select a source style.');
    if (!category) throw new HttpError(400, 'Select a category.');
    if (!Array.isArray(sizes) || !sizes.length) throw new HttpError(400, 'Select at least one size.');

    const { data: source, error: srcErr } = await supabaseAdmin
      .from('styles').select('code, category, name').eq('code', source_code).maybeSingle();
    if (srcErr) throw new HttpError(500, srcErr.message);
    if (!source) throw new HttpError(404, `Source style not found: ${source_code}`);
    if (source.category === category) throw new HttpError(400, 'Pick a different category than the source style.');

    const split = splitCode(source.code, source.category);
    if (!split) throw new HttpError(500, `Could not read a number from source code ${source.code}.`);

    const { data: catRow } = await supabaseAdmin.from('categories').select('code').eq('code', category).maybeSingle();
    if (!catRow) throw new HttpError(400, `Unknown category: ${category}`);

    let data, error, newCode, letter;
    for (let attempt = 0; attempt < 26; attempt++) {
      ({ code: newCode, letter } = await nextAvailableCode(category, split.number));
      ({ data, error } = await supabaseAdmin
        .from('styles')
        .insert({
          code: newCode, name: source.name, category, status: 'active',
          colors: [letter], sizes, description: description || null, created_by: actor.id,
        })
        .select().single());
      if (!error || error.code !== '23505') break; // success, or a real (non-race) failure
    }
    if (error) throw new HttpError(500, error.message);

    await syncSkusForColorCodedStyle(newCode, letter, sizes);

    await writeAudit({
      profile: actor, action: 'create', entity: 'Style',
      detail: `Created style ${newCode} — same pattern as ${source_code}, new category`,
    });

    return res.status(201).json({ data });
  }

  // POST /api/styles/add-color-variant — a new color of an existing pattern.
  // Real catalog practice is one style row per color (AISW-208A, AISW-208B…),
  // so "adding a color" creates a new sibling row — never mutates the source
  // — copying category/sizes/MRP/cost/HSN/description across (images are
  // deliberately NOT copied; a different colorway usually needs its own
  // photos). The new color's own letter is always freshly picked, never the
  // source's own slot.
  if (params.length === 1 && params[0] === 'add-color-variant') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const { profile: actor } = await requireModulePermission(req, 'Styles', 'edit');

    const { source_code } = req.body || {};
    if (!source_code) throw new HttpError(400, 'Select a source style.');

    const { data: source, error: srcErr } = await supabaseAdmin
      .from('styles').select('*').eq('code', source_code).maybeSingle();
    if (srcErr) throw new HttpError(500, srcErr.message);
    if (!source) throw new HttpError(404, `Source style not found: ${source_code}`);

    const split = splitCode(source.code, source.category);
    if (!split) throw new HttpError(500, `Could not read a number from source code ${source.code}.`);

    let data, error, newCode, letter;
    for (let attempt = 0; attempt < 26; attempt++) {
      ({ code: newCode, letter } = await nextAvailableCode(source.category, split.number));
      ({ data, error } = await supabaseAdmin
        .from('styles')
        .insert({
          code: newCode, name: source.name, category: source.category, status: source.status,
          colors: [letter], sizes: source.sizes, mrp: source.mrp, cost_price: source.cost_price,
          hsn_code: source.hsn_code, description: source.description, created_by: actor.id,
        })
        .select().single());
      if (!error || error.code !== '23505') break;
    }
    if (error) throw new HttpError(500, error.message);

    await syncSkusForColorCodedStyle(newCode, letter, source.sizes);

    await writeAudit({
      profile: actor, action: 'create', entity: 'Style',
      detail: `Created style ${newCode} — new color of ${source_code}`,
    });

    return res.status(201).json({ data });
  }

  // GET/POST /api/styles/costing — bill-of-materials cost breakdown.
  // GET returns every style's line items flat (style_code on each row) so
  // the Costing overview page can compute per-style rollups client-side,
  // same pattern the rest of the app already uses. POST replaces the full
  // item set for one style (simplest correct semantics for a "save the
  // whole grid" editor — no per-row add/remove endpoints to keep in sync).
  if (params.length === 1 && params[0] === 'costing') {
    if (req.method === 'GET') {
      await requireModulePermission(req, 'Costing', 'view');
      const data = await fetchAll(() =>
        supabaseAdmin.from('style_costing_items').select('*').order('style_code').order('sort_order'));
      return res.status(200).json({ data });
    }

    if (req.method === 'POST') {
      const { profile: actor } = await requireModulePermission(req, 'Costing', 'edit');

      const { style_code, items, overhead_pct, mrp } = req.body || {};
      if (!style_code) throw new HttpError(400, 'style_code is required.');
      if (!Array.isArray(items)) throw new HttpError(400, 'items must be an array.');

      const { data: style, error: findErr } = await supabaseAdmin
        .from('styles').select('code').eq('code', style_code).maybeSingle();
      if (findErr) throw new HttpError(500, findErr.message);
      if (!style) throw new HttpError(404, `Style not found: ${style_code}`);

      const { error: delErr } = await supabaseAdmin.from('style_costing_items').delete().eq('style_code', style_code);
      if (delErr) throw new HttpError(500, delErr.message);

      const rows = items
        .filter((it) => it.item && String(it.item).trim())
        .map((it, i) => ({
          style_code, item: String(it.item).trim(),
          consumption: it.consumption || 0, rate: it.rate || 0, sort_order: i,
        }));
      if (rows.length) {
        const { error: insErr } = await supabaseAdmin.from('style_costing_items').insert(rows);
        if (insErr) throw new HttpError(500, insErr.message);
      }

      // Any save — Founder included — reverts approval status to draft.
      // Approval is a deliberate, separate action (see costing-approve
      // below), never implied by editing.
      const styleUpdate = { costing_status: 'draft', updated_at: new Date().toISOString() };
      if (overhead_pct !== undefined) styleUpdate.overhead_pct = overhead_pct || 0;
      // MRP-from-Costing is Founder-only, enforced here regardless of what a
      // client sends — mirrors costing-approve below, since this is the
      // field that ultimately reaches the storefront, not a routine edit.
      if (mrp !== undefined && actor.role === 'Founder') styleUpdate.mrp = mrp || null;
      const { error: ohErr } = await supabaseAdmin.from('styles').update(styleUpdate).eq('code', style_code);
      if (ohErr) throw new HttpError(500, ohErr.message);

      await writeAudit({
        profile: actor, action: 'update', entity: 'Costing',
        detail: `Updated costing for style ${style_code}${actor.role !== 'Founder' ? ' (pending Founder approval)' : ''}`,
      });

      const { data: refreshed, error: refErr } = await supabaseAdmin
        .from('style_costing_items').select('*').eq('style_code', style_code).order('sort_order');
      if (refErr) throw new HttpError(500, refErr.message);
      return res.status(200).json({ data: refreshed });
    }

    throw new HttpError(405, 'Method not allowed.');
  }

  // POST /api/styles/costing-approve — Founder-only. Marks a style's
  // costing as approved/live. Hardcoded to the Founder role rather than the
  // Costing edit permission, same pattern as Founder's permissions being
  // immutable elsewhere — this is a sign-off, not a data-edit right, so it
  // isn't something Roles & Permissions should be able to delegate away.
  if (params.length === 1 && params[0] === 'costing-approve') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const { profile: actor } = await requireModulePermission(req, 'Costing', 'view');
    if (actor.role !== 'Founder') throw new HttpError(403, 'Only the Founder can approve costing.');

    const { style_code } = req.body || {};
    if (!style_code) throw new HttpError(400, 'style_code is required.');

    const { data: updated, error } = await supabaseAdmin
      .from('styles').update({ costing_status: 'approved', updated_at: new Date().toISOString() })
      .eq('code', style_code).select('code, costing_status').maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!updated) throw new HttpError(404, `Style not found: ${style_code}`);

    await writeAudit({
      profile: actor, action: 'update', entity: 'Costing',
      detail: `Approved costing for style ${style_code}`,
    });

    return res.status(200).json({ data: updated });
  }

  // GET/PATCH/DELETE /api/styles/:code
  if (params.length === 1) {
    const code = params[0];

    if (req.method === 'GET') {
      await requireModulePermission(req, 'Styles', 'view');
      const { data, error } = await supabaseAdmin.from('styles').select('*').eq('code', code).single();
      if (error || !data) throw new HttpError(404, 'Style not found.');
      return res.status(200).json({ data });
    }

    const { profile: actor } = await requireModulePermission(req, 'Styles', 'edit');

    const { data: existing, error: findErr } = await supabaseAdmin
      .from('styles').select('*').eq('code', code).single();
    if (findErr || !existing) throw new HttpError(404, 'Style not found.');

    if (req.method === 'PATCH') {
      const { name, status, hsn_code, mrp, cost_price, description, images, sizes } = req.body || {};
      if (name !== undefined && !String(name).trim()) throw new HttpError(400, 'Style name is required.');
      if (sizes !== undefined && (!Array.isArray(sizes) || !sizes.length)) {
        throw new HttpError(400, 'Select at least one size.');
      }
      if (images !== undefined && Array.isArray(images) && images.length > 4) {
        throw new HttpError(400, 'A style can have at most 4 images.');
      }

      const patch = {};
      if (name !== undefined) patch.name = String(name).trim();
      if (status !== undefined) patch.status = status;
      if (hsn_code !== undefined) patch.hsn_code = hsn_code;
      if (mrp !== undefined) patch.mrp = mrp || null;
      if (cost_price !== undefined) patch.cost_price = cost_price || null;
      if (description !== undefined) patch.description = description;
      if (images !== undefined) patch.images = images;
      if (sizes !== undefined) patch.sizes = sizes;
      patch.updated_at = new Date().toISOString();

      const { data: updated, error } = await supabaseAdmin
        .from('styles').update(patch).eq('code', code).select().single();
      if (error) throw new HttpError(500, error.message);

      if (sizes !== undefined) await syncSkusForStyle(code, existing.colors, sizes);

      await writeAudit({
        profile: actor, action: 'update', entity: 'Style',
        detail: `Updated style ${code} — ${updated.name}`,
      });

      return res.status(200).json({ data: updated });
    }

    if (req.method === 'DELETE') {
      const { error } = await supabaseAdmin.from('styles').delete().eq('code', code);
      if (error) throw new HttpError(500, error.message);

      await writeAudit({
        profile: actor, action: 'delete', entity: 'Style',
        detail: `Deleted style ${code} — ${existing.name}`,
      });

      return res.status(200).json({ data: { code } });
    }

    throw new HttpError(405, 'Method not allowed.');
  }

  throw new HttpError(404, 'Not found.');
});
