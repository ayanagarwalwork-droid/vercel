// POST /api/import/listings { headers, dataRows, filename, rawCsv }
// Mirrors confirmImport()'s 'listings' branch exactly: skips rows whose
// (sku, marketplace) pair already exists, defaults type to 'master' and
// status to 'draft'. Requires edit on Import.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

module.exports = withErrorHandling(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');

  const { profile: actor } = await requireModulePermission(req, 'Import', 'edit');

  const { headers, dataRows, filename, rawCsv } = req.body || {};
  if (!Array.isArray(headers) || !Array.isArray(dataRows)) throw new HttpError(400, 'Missing headers/dataRows.');

  const skuIdx  = headers.indexOf('AOBA SKU');
  const sidIdx  = headers.indexOf('Style ID');
  const mktIdx  = headers.indexOf('Marketplace');
  const mktSkuIdx = headers.indexOf('Marketplace SKU');
  const statIdx = headers.indexOf('Status');

  const { data: existing } = await supabaseAdmin.from('listings').select('sku, marketplace');
  const existingKeys = new Set((existing || []).map((l) => `${l.sku}::${l.marketplace}`));

  let imported = 0;
  const rowsToInsert = [];
  for (const row of dataRows) {
    const sku = row[skuIdx];
    const marketplace = row[mktIdx] || '';
    if (!sku) continue;
    const key = `${sku}::${marketplace}`;
    if (existingKeys.has(key)) continue;

    const styleId = row[sidIdx] || '';
    rowsToInsert.push({
      sku, style_code: styleId || null, marketplace,
      marketplace_sku: mktSkuIdx >= 0 ? row[mktSkuIdx] || null : null,
      type: 'master', status: row[statIdx] || 'draft',
      launch_date: row[statIdx] === 'live' ? new Date().toISOString().slice(0, 10) : null,
    });
    existingKeys.add(key);
    imported++;
  }

  if (rowsToInsert.length) {
    const { error } = await supabaseAdmin.from('listings').insert(rowsToInsert);
    if (error) throw new HttpError(500, error.message);
  }

  const { data: historyRow, error: histErr } = await supabaseAdmin
    .from('import_history')
    .insert({
      type: 'listings', filename: filename || 'import.csv', row_count: imported,
      status: 'success', imported_by: actor.id, raw_csv: rawCsv || null,
    })
    .select().single();
  if (histErr) throw new HttpError(500, histErr.message);

  await writeAudit({
    profile: actor, action: 'import', entity: 'Catalog',
    detail: `Imported ${imported} rows from ${filename || 'import.csv'} (listings)`,
  });

  res.status(200).json({ data: { imported, importHistory: historyRow } });
});
