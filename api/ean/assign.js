// POST /api/ean/assign { sku, ean } — assigns an EAN to the first listing
// row matching that SKU (matches assignSingleEAN()'s exact behavior in the
// prototype: `LISTINGS_DATA.find(l => l.sku === sku)`, i.e. first match
// across marketplaces if the same SKU is listed on more than one). Requires
// edit on EAN / Barcode.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

module.exports = withErrorHandling(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');

  const { profile: actor } = await requireModulePermission(req, 'EAN / Barcode', 'edit');

  const { sku, ean } = req.body || {};
  if (!sku) throw new HttpError(400, 'Enter a SKU code.');
  if (!ean || !/^\d{8}$|^\d{12,14}$/.test(ean)) {
    throw new HttpError(400, 'EAN must be 8, 12, 13 or 14 digits.');
  }

  const { data: entry, error: findErr } = await supabaseAdmin
    .from('listings').select('id').eq('sku', sku).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (findErr) throw new HttpError(500, findErr.message);
  if (!entry) throw new HttpError(404, `SKU not found: ${sku}`);

  const { data: updated, error } = await supabaseAdmin
    .from('listings')
    .update({ ean, ean_status: 'assigned', updated_at: new Date().toISOString() })
    .eq('id', entry.id)
    .select().single();
  if (error) throw new HttpError(500, error.message);

  await writeAudit({
    profile: actor, action: 'assign', entity: 'EAN',
    detail: `Assigned EAN ${ean} to SKU ${sku}`,
  });

  res.status(200).json({ data: updated });
});
