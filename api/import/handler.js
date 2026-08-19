// Catch-all for /api/import/history, /api/import/styles, /api/import/listings,
// /api/import/ean — consolidated into one file (was 4 separate files) to stay
// under Vercel Hobby's 12 serverless function limit. URL paths the frontend
// calls are unchanged.
//
// GET  /api/import/history  — most recent import runs. Requires view on Import.
// POST /api/import/styles   — bulk-create styles from a parsed CSV. Requires edit.
// POST /api/import/listings — bulk-create listings from a parsed CSV. Requires edit.
// POST /api/import/ean      — bulk-update SKUs' EAN from a parsed CSV. Requires edit.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');
const { syncSkusForStyle } = require('../_lib/skus');

// Google Drive "share" links (drive.google.com/file/d/ID/view or
// drive.google.com/open?id=ID) render an HTML viewer page, not an image, so
// they'd show as broken photos if stored as-is. Convert to Drive's direct-
// content URL instead — same logic as the manual "Add URLs" button in
// desktop.html's Style Detail edit mode, duplicated here since CSV import
// happens server-side, not through that client code path.
function normalizeImageUrl(url) {
  const fileMatch = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (fileMatch) return `https://drive.google.com/uc?export=view&id=${fileMatch[1]}`;
  const openMatch = url.match(/drive\.google\.com\/open\?id=([^&]+)/);
  if (openMatch) return `https://drive.google.com/uc?export=view&id=${openMatch[1]}`;
  return url;
}

async function writeImportHistory({ type, filename, imported, rawCsv, actor, note }) {
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
    detail: `Imported ${imported} rows from ${filename || 'import.csv'} (${type})${note || ''}`,
  });

  return historyRow;
}

async function importStyles(req, actor) {
  const { headers, dataRows, filename, rawCsv, updateExisting } = req.body || {};
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

  const { data: existing } = await supabaseAdmin.from('styles').select('code, colors');
  const existingCodes = new Set((existing || []).map((s) => s.code));
  const existingColors = new Map((existing || []).map((s) => [s.code, s.colors]));

  let created = 0;
  let updated = 0;
  const rowsToInsert = [];

  for (const row of dataRows) {
    const code = row[idIdx];
    if (!code) continue;

    const rawSizes = (row[sizeIdx] || '').trim();
    const images = imgIdx.map((i) => (i >= 0 ? (row[i] || '').trim() : '')).filter(Boolean).map(normalizeImageUrl);

    if (existingCodes.has(code)) {
      if (!updateExisting) continue;
      // Only touch fields this row actually provided -- a blank cell means
      // "didn't specify," not "clear this field," so partially-filled
      // re-imports (e.g. just adding photos) can't accidentally blank out
      // everything else. colors is intentionally never touched here: the
      // code.slice(-1) guess used for brand-new styles isn't reliable
      // enough to overwrite real existing color data.
      const patch = {};
      if (row[nameIdx]) patch.name = row[nameIdx];
      if (row[statIdx]) patch.status = row[statIdx];
      if (hsnIdx >= 0 && row[hsnIdx]) patch.hsn_code = row[hsnIdx];
      if (mrpIdx >= 0 && row[mrpIdx]) patch.mrp = row[mrpIdx];
      if (cpIdx >= 0 && row[cpIdx]) patch.cost_price = row[cpIdx];
      if (descIdx >= 0 && row[descIdx]) patch.description = row[descIdx];
      if (rawSizes) patch.sizes = rawSizes.split(',').map((s) => s.trim()).filter(Boolean);
      if (images.length) patch.images = images;
      if (!Object.keys(patch).length) continue;

      patch.updated_at = new Date().toISOString();
      const { error } = await supabaseAdmin.from('styles').update(patch).eq('code', code);
      if (error) throw new HttpError(500, error.message);
      if (patch.sizes) await syncSkusForStyle(code, existingColors.get(code) || [], patch.sizes);
      updated++;
      continue;
    }

    const prefix = code.replace(/-\d.*$/, '');
    const sizes = (rawSizes || 'S,M,L').split(',').map((s) => s.trim()).filter(Boolean);
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
    created++;
  }

  if (rowsToInsert.length) {
    const { error } = await supabaseAdmin.from('styles').insert(rowsToInsert);
    if (error) throw new HttpError(500, error.message);
    for (const row of rowsToInsert) await syncSkusForStyle(row.code, row.colors, row.sizes);
  }

  const imported = created + updated;
  const historyRow = await writeImportHistory({ type: 'styles', filename, imported, rawCsv, actor });
  return { imported, created, updated, importHistory: historyRow };
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
  let skipped = 0;
  for (const row of dataRows) {
    const sku = row[skuIdx];
    const ean = row[eanIdx];
    if (!sku || !/^\d{8}$|^\d{12,14}$/.test(String(ean || ''))) { skipped++; continue; }

    const { data: updated, error } = await supabaseAdmin
      .from('skus')
      .update({ ean, ean_status: row[statIdx] || 'assigned', updated_at: new Date().toISOString() })
      .eq('sku', sku)
      .select('sku');
    if (error) throw new HttpError(500, error.message);
    if (!updated.length) { skipped++; continue; }
    imported++;
  }

  const historyRow = await writeImportHistory({
    type: 'ean', filename, imported, rawCsv, actor,
    note: skipped ? ` (${skipped} skipped — SKU not found or invalid EAN)` : '',
  });
  return { imported, skipped, importHistory: historyRow };
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
