// Catch-all for /api/import/history, /api/import/styles, /api/import/listings,
// /api/import/ean, /api/import/style-ean — consolidated into one file to stay
// under Vercel Hobby's 12 serverless function limit. URL paths the frontend
// calls are unchanged.
//
// GET  /api/import/history   — most recent import runs. Requires view on Import.
// POST /api/import/styles    — bulk-create styles from a parsed CSV. Requires edit.
// POST /api/import/listings  — bulk-create listings from a parsed CSV. Requires edit.
// POST /api/import/ean       — bulk-update SKUs' EAN from a parsed CSV. Requires edit.
// POST /api/import/style-ean — one row per SKU: creates/updates the style and
//                               assigns that row's EAN in a single pass. Requires edit.
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

// One row per SKU (style+color+size), unlike importStyles' one-row-per-style
// shape. Style-level fields (name/HSN/MRP/etc/images) are read off the first
// row seen for a given Style ID; colors/sizes are the distinct values seen
// across that style's rows rather than guessed, so — unlike importStyles,
// which deliberately never touches colors on an update because its
// single-letter guess isn't trustworthy — this path can safely set/update
// colors too, since the CSV states them explicitly.
//
// The SKU column bundles Style ID + Size into one field ('AOD-1A/S') rather
// than two separate columns, matching the format the team's own master
// sheet already uses, so that column can be pasted in directly. Split on the
// *last* '/' rather than the first, since a Style ID can itself contain one.
function splitBundledSku(bundled) {
  const lastSlash = bundled.lastIndexOf('/');
  if (lastSlash <= 0 || lastSlash === bundled.length - 1) return null;
  return { code: bundled.slice(0, lastSlash), size: bundled.slice(lastSlash + 1).trim() };
}

async function importStyleEan(req, actor) {
  const { headers, dataRows, filename, rawCsv, updateExisting } = req.body || {};
  if (!Array.isArray(headers) || !Array.isArray(dataRows)) throw new HttpError(400, 'Missing headers/dataRows.');

  const skuIdx = headers.indexOf('SKU');
  const nameIdx = headers.indexOf('Style Name');
  const colorIdx = headers.indexOf('Color');
  const statIdx = headers.indexOf('Status');
  const hsnIdx = headers.indexOf('HSN Code');
  const mrpIdx = headers.indexOf('MRP');
  const cpIdx = headers.indexOf('Cost Price');
  const descIdx = headers.indexOf('Description');
  const imgIdx = [1, 2, 3, 4].map((n) => headers.indexOf(`Image URL ${n}`));
  const eanIdx = headers.indexOf('EAN (13 digits)');

  const groups = new Map(); // code -> { rows: [...] }
  for (const row of dataRows) {
    const bundled = (row[skuIdx] || '').trim();
    if (!bundled) continue;
    const split = splitBundledSku(bundled);
    if (!split) continue;
    const { code, size } = split;
    const color = (row[colorIdx] || '').trim();
    if (!color || !size) continue;
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push({ row, color, size });
  }

  const { data: existing } = await supabaseAdmin.from('styles').select('code');
  const existingCodes = new Set((existing || []).map((s) => s.code));

  let stylesCreated = 0;
  let stylesUpdated = 0;
  let skusWithEan = 0;
  let skipped = 0;

  for (const [code, entries] of groups) {
    const first = entries[0].row;
    const colors = [...new Set(entries.map((e) => e.color))];
    const sizes = [...new Set(entries.map((e) => e.size))];
    const images = imgIdx.map((i) => (i >= 0 ? (first[i] || '').trim() : '')).filter(Boolean).map(normalizeImageUrl);

    if (existingCodes.has(code)) {
      if (updateExisting) {
        const patch = { colors, sizes };
        if (nameIdx >= 0 && first[nameIdx]) patch.name = first[nameIdx];
        if (statIdx >= 0 && first[statIdx]) patch.status = first[statIdx];
        if (hsnIdx >= 0 && first[hsnIdx]) patch.hsn_code = first[hsnIdx];
        if (mrpIdx >= 0 && first[mrpIdx]) patch.mrp = first[mrpIdx];
        if (cpIdx >= 0 && first[cpIdx]) patch.cost_price = first[cpIdx];
        if (descIdx >= 0 && first[descIdx]) patch.description = first[descIdx];
        if (images.length) patch.images = images;
        patch.updated_at = new Date().toISOString();
        const { error } = await supabaseAdmin.from('styles').update(patch).eq('code', code);
        if (error) throw new HttpError(500, error.message);
        stylesUpdated++;
      }
      await syncSkusForStyle(code, colors, sizes);
    } else {
      const prefix = code.replace(/-\d.*$/, '');
      const { error } = await supabaseAdmin.from('styles').insert({
        code, name: (nameIdx >= 0 && first[nameIdx]) || code, category: prefix,
        status: (statIdx >= 0 && first[statIdx]) || 'active',
        hsn_code: hsnIdx >= 0 ? first[hsnIdx] || null : null,
        mrp: mrpIdx >= 0 ? first[mrpIdx] || null : null,
        cost_price: cpIdx >= 0 ? first[cpIdx] || null : null,
        description: descIdx >= 0 ? first[descIdx] || null : null,
        images, colors, sizes, created_by: actor.id,
      });
      if (error) throw new HttpError(500, error.message);
      existingCodes.add(code);
      stylesCreated++;
      await syncSkusForStyle(code, colors, sizes);
    }

    for (const { row, color, size } of entries) {
      const ean = eanIdx >= 0 ? row[eanIdx] : '';
      if (!ean) continue;
      if (!/^\d{8}$|^\d{12,14}$/.test(String(ean))) { skipped++; continue; }
      const sku = `${code}${color}/${size}`;
      const { data: updated, error } = await supabaseAdmin
        .from('skus')
        .update({ ean, ean_status: 'assigned', updated_at: new Date().toISOString() })
        .eq('sku', sku).select('sku');
      if (error) throw new HttpError(500, error.message);
      if (!updated.length) { skipped++; continue; }
      skusWithEan++;
    }
  }

  const imported = stylesCreated + stylesUpdated;
  const historyRow = await writeImportHistory({
    type: 'style_ean', filename, imported, rawCsv, actor,
    note: ` — ${stylesCreated} styles created, ${stylesUpdated} updated, ${skusWithEan} EANs assigned${skipped ? `, ${skipped} skipped` : ''}`,
  });
  return { imported, stylesCreated, stylesUpdated, skusWithEan, skipped, importHistory: historyRow };
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

  if (!['styles', 'listings', 'ean', 'style-ean'].includes(route)) throw new HttpError(404, 'Not found.');
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');

  const { profile: actor } = await requireModulePermission(req, 'Import', 'edit');

  let result;
  if (route === 'styles') result = await importStyles(req, actor);
  else if (route === 'listings') result = await importListings(req, actor);
  else if (route === 'style-ean') result = await importStyleEan(req, actor);
  else result = await importEan(req, actor);

  res.status(200).json({ data: result });
});
