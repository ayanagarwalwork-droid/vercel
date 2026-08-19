// Catch-all for /api/ean, /api/ean/assign — consolidated into one file
// (was 1, now serving 2 routes) to stay under Vercel Hobby's 12 serverless
// function limit as the app grows.
//
// GET  /api/ean        — every SKU with its EAN status, joined with style
//                         name/category for display. Requires view.
// POST /api/ean/assign — assign an EAN to one SKU. Requires edit.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

module.exports = withErrorHandling(async (req, res) => {
  const params = req.query.path ? [req.query.path] : [];

  // GET /api/ean
  if (params.length === 0) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    await requireModulePermission(req, 'EAN / Barcode', 'view');

    const { data, error } = await supabaseAdmin
      .from('skus')
      .select('sku, style_code, color, size, ean, ean_status, styles(name, category)')
      .order('sku', { ascending: true });
    if (error) throw new HttpError(500, error.message);

    const shaped = (data || []).map((row) => ({
      sku: row.sku, style_code: row.style_code, color: row.color, size: row.size,
      ean: row.ean, ean_status: row.ean_status,
      style_name: row.styles?.name || row.style_code,
      category: row.styles?.category || '',
    }));
    return res.status(200).json({ data: shaped });
  }

  // POST /api/ean/assign
  if (params.length === 1 && params[0] === 'assign') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const { profile: actor } = await requireModulePermission(req, 'EAN / Barcode', 'edit');

    const { sku, ean } = req.body || {};
    if (!sku) throw new HttpError(400, 'Enter a SKU code.');
    if (!ean || !/^\d{8}$|^\d{12,14}$/.test(ean)) {
      throw new HttpError(400, 'EAN must be 8, 12, 13 or 14 digits.');
    }

    const { data: updated, error } = await supabaseAdmin
      .from('skus')
      .update({ ean, ean_status: 'assigned', updated_at: new Date().toISOString() })
      .eq('sku', sku)
      .select().maybeSingle();
    if (error) throw new HttpError(500, error.message);
    if (!updated) throw new HttpError(404, `SKU not found: ${sku}`);

    await writeAudit({
      profile: actor, action: 'assign', entity: 'EAN',
      detail: `Assigned EAN ${ean} to SKU ${sku}`,
    });

    return res.status(200).json({ data: updated });
  }

  throw new HttpError(404, 'Not found.');
});
