// Catch-all for /api/import/history, /api/import/styles, /api/import/listings,
// /api/import/ean — consolidated into one file (was 4 separate files) to stay
// under Vercel Hobby's 12 serverless function limit. URL paths the frontend
// calls are unchanged.
//
// GET  /api/import/history  — most recent import runs. Requires view on Import.
// POST /api/import/styles   — bulk-create styles from a parsed CSV. Requires edit.
// POST /api/import/listings — bulk-create listings from a parsed CSV. Requires edit.
// POST /api/import/ean      — bulk-update listings' EAN from a parsed CSV. Requires edit.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

async function writeImportHistory({ type, filename, imported, rawCsv, actor }) {
  const { data: historyRow, error } = await supabaseAdmin
    .from('import_history')
    .insert({
      type, filename: filename || 'import.csv', row_count: imported,
      status: 'success', imported_by: actor.id, raw_csv: rawCsv || null,
    })
    .select().single();
  if (error) throw new HttpError(500, error.message);

  await writeAudit({
    profile: actor, action: 'import', entity: 'Catalog',
    detail: `Imported ${imported} rows from ${filename || 'import.csv'} (${type})`,
  });

  return historyRow;
}

async function importStyles(req, actor) {
  const { headers, dataRows, filename, rawCsv } = req.body || {};
  if (!Array.isArray(headers) || !Array.isArray(dataRows)) throw new HttpError(400, 'Missing headers/dataRows.');

  const idIdx = headers.indexOf('Style ID');
  const nameIdx = headers.indexOf('Style Name');
  const sizeIdx = headers.indexOf('Sizes (comma-sep)');
  const statIdx = headers.indexOf('Status');
  const hsnIdx = headers.indexOf('HSN Code');
  const mrpIdx = headers.indexOf('MRP');
  const cpIdx = headers.indexOf('Cost Price');
  const descIdx = headers.indexOf('Description');
  const imgIdx = [1, 2, 3, 4].map((n) => headers.indexOf(`Image URL ${n}`));

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
    existingCodes.add(code);
    imported++;
  }

  if (rowsToInsert.length) {
    const { error } = await supabaseAdmin.from('styles').insert(rowsToInsert);
    if (error) throw new HttpError(500, error.message);
  }

  const historyRow = await writeImportHistory({ type: 'styles', filename, imported, rawCsv, actor });
  return { imported, importHistory: historyRow };
}

async function importListings(req, actor) {
  const { headers, dataRows, filename, rawCsv } = req.body || {};
  if (!Array.isArray(headers) || !Array.isArray(dataRows)) throw new HttpError(400, 'Missing headers/dataRows.');

  const skuIdx = headers.indexOf('AOBA SKU');
  const sidIdx = headers.indexOf('Style ID');
  const mktIdx = headers.indexOf('Marketplace');
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

  const historyRow = await writeImportHistory({ type: 'listings', filename, imported, rawCsv, actor });
  return { imported, importHistory: historyRow };
}

async function importEan(req, actor) {
  const { headers, dataRows, filename, rawCsv } = req.body || {};
  if (!Array.isArray(headers) || !Array.isArray(dataRows)) throw new HttpError(400, 'Missing headers/dataRows.');

  const skuIdx = headers.indexOf('AOBA SKU');
  const eanIdx = headers.indexOf('EAN (13 digits)');
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

  const historyRow = await writeImportHistory({ type: 'ean', filename, imported, rawCsv, actor });
  return { imported, importHistory: historyRow };
}

module.exports = withErrorHandling(async (req, res) => {
  // vercel.json rewrites /api/import/* here, forwarding the sub-path as
  // ?path=... — always exactly one segment (history/styles/listings/ean).
  const params = req.query.path ? [req.query.path] : [];
  if (params.length !== 1) throw new HttpError(404, 'Not found.');
  const route = params[0];

  if (route === 'history') {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    await requireModulePermission(req, 'Import', 'view');
    const { data, error } = await supabaseAdmin
      .from('import_history').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) throw new HttpError(500, error.message);
    return res.status(200).json({ data });
  }

  if (!['styles', 'listings', 'ean'].includes(route)) throw new HttpError(404, 'Not found.');
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');

  const { profile: actor } = await requireModulePermission(req, 'Import', 'edit');

  let result;
  if (route === 'styles') result = await importStyles(req, actor);
  else if (route === 'listings') result = await importListings(req, actor);
  else result = await importEan(req, actor);

  res.status(200).json({ data: result });
});
