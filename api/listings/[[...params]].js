// Catch-all for /api/listings, /api/listings/:id — consolidated into one
// file (was 2 separate files) to stay under Vercel Hobby's 12 serverless
// function limit. URL paths the frontend calls are unchanged.
//
// GET    /api/listings     — full list. Requires view on Listings.
// POST   /api/listings     — create a listing. Requires edit.
// PATCH  /api/listings/:id — edit style_code/marketplace_sku/status/type/mrp/listing_url. Requires edit.
// DELETE /api/listings/:id — requires edit.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

module.exports = withErrorHandling(async (req, res) => {
  const params = req.query.params || [];

  // GET/POST /api/listings
  if (params.length === 0) {
    if (req.method === 'GET') {
      await requireModulePermission(req, 'Listings', 'view');
      const { data, error } = await supabaseAdmin
        .from('listings').select('*').order('created_at', { ascending: true });
      if (error) throw new HttpError(500, error.message);
      return res.status(200).json({ data });
    }

    if (req.method === 'POST') {
      const { profile: actor } = await requireModulePermission(req, 'Listings', 'edit');

      const { sku, style_code, marketplace, marketplace_sku, type, status, mrp, listing_url } = req.body || {};
      if (!sku) throw new HttpError(400, 'AOBA SKU is required.');
      if (!marketplace) throw new HttpError(400, 'Select a marketplace.');

      const { data: existing } = await supabaseAdmin
        .from('listings').select('id').eq('sku', sku).eq('marketplace', marketplace).maybeSingle();
      if (existing) throw new HttpError(409, 'This SKU + marketplace combination already exists.');

      const finalStatus = status || 'draft';
      const { data, error } = await supabaseAdmin
        .from('listings')
        .insert({
          sku, style_code: style_code || null, marketplace,
          marketplace_sku: marketplace_sku || null, type: type || 'master',
          status: finalStatus, mrp: mrp || null, listing_url: listing_url || null,
          launch_date: finalStatus === 'live' ? new Date().toISOString().slice(0, 10) : null,
        })
        .select().single();
      if (error) throw new HttpError(500, error.message);

      await writeAudit({
        profile: actor, action: 'create', entity: 'Listing',
        detail: `Added listing ${sku} on ${marketplace}`,
      });

      return res.status(201).json({ data });
    }

    throw new HttpError(405, 'Method not allowed.');
  }

  // PATCH/DELETE /api/listings/:id
  if (params.length === 1) {
    const id = params[0];
    const { profile: actor } = await requireModulePermission(req, 'Listings', 'edit');

    const { data: existing, error: findErr } = await supabaseAdmin
      .from('listings').select('*').eq('id', id).single();
    if (findErr || !existing) throw new HttpError(404, 'Listing not found.');

    if (req.method === 'PATCH') {
      const { style_code, marketplace_sku, status, type, mrp, listing_url } = req.body || {};
      const patch = { updated_at: new Date().toISOString() };
      if (style_code !== undefined) patch.style_code = style_code;
      if (marketplace_sku !== undefined) patch.marketplace_sku = marketplace_sku;
      if (status !== undefined) patch.status = status;
      if (type !== undefined) patch.type = type;
      if (mrp !== undefined) patch.mrp = mrp || null;
      if (listing_url !== undefined) patch.listing_url = listing_url || null;
      if (status === 'live' && !existing.launch_date) {
        patch.launch_date = new Date().toISOString().slice(0, 10);
      }

      const { data: updated, error } = await supabaseAdmin
        .from('listings').update(patch).eq('id', id).select().single();
      if (error) throw new HttpError(500, error.message);

      await writeAudit({
        profile: actor, action: 'update', entity: 'Listing',
        detail: `Updated listing ${updated.sku} on ${updated.marketplace} — status: ${updated.status}`,
      });

      return res.status(200).json({ data: updated });
    }

    if (req.method === 'DELETE') {
      const { error } = await supabaseAdmin.from('listings').delete().eq('id', id);
      if (error) throw new HttpError(500, error.message);

      await writeAudit({
        profile: actor, action: 'delete', entity: 'Listing',
        detail: `Removed listing ${existing.sku} on ${existing.marketplace}`,
      });

      return res.status(200).json({ data: { id } });
    }

    throw new HttpError(405, 'Method not allowed.');
  }

  throw new HttpError(404, 'Not found.');
});
