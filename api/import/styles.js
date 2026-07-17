// POST /api/import/styles { headers, dataRows, filename, rawCsv }
// Bulk-creates styles from an already-parsed CSV (parsing/header-validation
// stays client-side in parseCSV()/processImportFile() — this endpoint only
// does the actual data mutation). Requires edit on Import.
//
// Mirrors confirmImport()'s 'styles' branch in public/desktop.html exactly:
// uses the Style ID column as the code directly (no SKU Engine RPC call —
// that's only for the New Style modal), skips rows whose code already
// exists, and derives colors as a single-letter array from the code's last
// character, matching the prototype's `colors: [code.slice(-1)]` heuristic.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

module.exports = withErrorHandling(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');

  const { profile: actor } = await requireModulePermission(req, 'Import', 'edit');

  const { headers, dataRows, filename, rawCsv } = req.body || {};
  if (!Array.isArray(headers) || !Array.isArray(dataRows)) throw new HttpError(400, 'Missing headers/dataRows.');

  const idIdx   = headers.indexOf('Style ID');
  const nameIdx = headers.indexOf('Style Name');
  const sizeIdx = headers.indexOf('Sizes (comma-sep)');
  const statIdx = headers.indexOf('Status');
  const hsnIdx  = headers.indexOf('HSN Code');
  const mrpIdx  = headers.indexOf('MRP');
  const cpIdx   = headers.indexOf('Cost Price');
  const descIdx = headers.indexOf('Description');
  const imgIdx  = [1, 2, 3, 4].map((n) => headers.indexOf(`Image URL ${n}`));

  const { data: existing } = await supabaseAdmin.from('styles').select('code');
  const existingCodes = new Set((existing || []).map((s) => s.code));

  let imported = 0;
  const rowsToInsert = [];
  for (const row of dataRows) {
    const code = row[idIdx];
    if (!code || existingCodes.has(code)) continue;

    const prefix = code.replace(/-\d.*$/, '');
    const sizes = (row[sizeIdx] || 'S,M,L').split(',').map((s) => s.trim()).filter(Boolean);
    const images = imgIdx.map((i) => (i >= 0 ? (row[i] || '').trim() : '')).filter(Boolean);

    rowsToInsert.push({
      code, name: row[nameIdx] || code, category: prefix,
      status: row[statIdx] || 'active',
      hsn_code: hsnIdx >= 0 ? row[hsnIdx] || null : null,
      mrp: mrpIdx >= 0 ? row[mrpIdx] || null : null,
      cost_price: cpIdx >= 0 ? row[cpIdx] || null : null,
      description: descIdx >= 0 ? row[descIdx] || null : null,
      images, colors: [code.slice(-1)], sizes, created_by: actor.id,
    });
    existingCodes.add(code); // guard against dupes within the same file
    imported++;
  }

  if (rowsToInsert.length) {
    const { error } = await supabaseAdmin.from('styles').insert(rowsToInsert);
    if (error) throw new HttpError(500, error.message);
  }

  const { data: historyRow, error: histErr } = await supabaseAdmin
    .from('import_history')
    .insert({
      type: 'styles', filename: filename || 'import.csv', row_count: imported,
      status: 'success', imported_by: actor.id, raw_csv: rawCsv || null,
    })
    .select().single();
  if (histErr) throw new HttpError(500, histErr.message);

  await writeAudit({
    profile: actor, action: 'import', entity: 'Catalog',
    detail: `Imported ${imported} rows from ${filename || 'import.csv'} (styles)`,
  });

  res.status(200).json({ data: { imported, importHistory: historyRow } });
});
