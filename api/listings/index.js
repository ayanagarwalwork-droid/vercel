// GET /api/listings — full listing list (client filters, matching the
//   prototype's renderListings()). Requires view on Listings.
// POST /api/listings — create a listing. Requires edit.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

module.exports = withErrorHandling(async (req, res) => {
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
});
