// POST /api/import/ean { headers, dataRows, filename, rawCsv }
// Mirrors confirmImport()'s 'ean' branch: only updates listings that already
// exist (matched by SKU) — does not create new rows. Requires edit on Import.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

module.exports = withErrorHandling(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');

  const { profile: actor } = await requireModulePermission(req, 'Import', 'edit');

  const { headers, dataRows, filename, rawCsv } = req.body || {};
  if (!Array.isArray(headers) || !Array.isArray(dataRows)) throw new HttpError(400, 'Missing headers/dataRows.');

  const skuIdx  = headers.indexOf('AOBA SKU');
  const eanIdx  = headers.indexOf('EAN (13 digits)');
  const statIdx = headers.indexOf('Status');

  let imported = 0;
  for (const row of dataRows) {
    const sku = row[skuIdx];
    if (!sku) continue;
    const { data: match } = await supabaseAdmin.from('listings').select('id').eq('sku', sku).limit(1).maybeSingle();
    if (!match) continue;

    const { error } = await supabaseAdmin
      .from('listings')
      .update({ ean: row[eanIdx], ean_status: row[statIdx] || 'assigned', updated_at: new Date().toISOString() })
      .eq('id', match.id);
    if (error) throw new HttpError(500, error.message);
    imported++;
  }

  const { data: historyRow, error: histErr } = await supabaseAdmin
    .from('import_history')
    .insert({
      type: 'ean', filename: filename || 'import.csv', row_count: imported,
      status: 'success', imported_by: actor.id, raw_csv: rawCsv || null,
    })
    .select().single();
  if (histErr) throw new HttpError(500, histErr.message);

  await writeAudit({
    profile: actor, action: 'import', entity: 'Catalog',
    detail: `Imported ${imported} rows from ${filename || 'import.csv'} (ean)`,
  });

  res.status(200).json({ data: { imported, importHistory: historyRow } });
});
