// PATCH /api/listings/:id — edit style_code/marketplace_sku/status/type/mrp/listing_url
//   (sku and marketplace are immutable once created, matching the prototype's
//   edit mode where those fields are disabled inputs). Requires edit.
// DELETE /api/listings/:id — requires edit. (No delete button in the UI yet,
//   included for completeness.)
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

module.exports = withErrorHandling(async (req, res) => {
  const { id } = req.query;
  if (!id) throw new HttpError(400, 'Missing listing id.');

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
});
