// Keeps the skus table (one row per style+color+size) in sync with a
// style's colors/sizes. Only ever adds missing rows — never deletes —
// so shrinking a style's size list (or a style's colors list, e.g. via the
// "New Color of Existing Style" flow, PATCH /api/styles/:code) can't
// silently drop a SKU that already has an EAN assigned to it.
const { supabaseAdmin } = require('./supabaseAdmin');

async function syncSkusForStyle(styleCode, colors, sizes) {
  const rows = [];
  for (const color of colors) {
    for (const size of sizes) {
      rows.push({ sku: `${styleCode}${color}/${size}`, style_code: styleCode, color, size });
    }
  }
  if (!rows.length) return;
  const { error } = await supabaseAdmin.from('skus').upsert(rows, { onConflict: 'sku', ignoreDuplicates: true });
  if (error) throw error;
}

module.exports = { syncSkusForStyle };
