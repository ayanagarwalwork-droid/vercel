// Catch-all for /api/styles, /api/styles/upload-image, /api/styles/:code —
// consolidated into one file (was 3 separate files) to stay under Vercel
// Hobby's 12 serverless function limit. URL paths the frontend calls are
// unchanged.
//
// GET    /api/styles              — full list. Requires view on Styles.
// POST   /api/styles              — create via the SKU Engine RPC. Requires edit.
// POST   /api/styles/upload-image — mint a signed Storage upload URL. Requires edit.
// GET    /api/styles/:code        — one style. Requires view.
// PATCH  /api/styles/:code        — edit name/status/hsn/mrp/cost/description/images/sizes. Requires edit.
// DELETE /api/styles/:code        — requires edit.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

module.exports = withErrorHandling(async (req, res) => {
  // vercel.json rewrites /api/styles(/*) here, forwarding the sub-path (if
  // any) as ?path=... — a single string, since these routes never need
  // more than one segment (bare, /upload-image, or /:code).
  const params = req.query.path ? [req.query.path] : [];

  // GET/POST /api/styles
  if (params.length === 0) {
    if (req.method === 'GET') {
      await requireModulePermission(req, 'Styles', 'view');
      const { data, error } = await supabaseAdmin
        .from('styles').select('*').order('added_at', { ascending: true });
      if (error) throw new HttpError(500, error.message);
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
