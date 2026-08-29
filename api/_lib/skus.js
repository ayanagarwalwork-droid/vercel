// Keeps the skus table (one row per style+color+size) in sync with a
// style's colors/sizes. Only ever adds missing rows — never deletes —
// so shrinking a style's size list can't silently drop a SKU that already
// has an EAN assigned to it. Colors are fixed at style creation, so the
// only case that adds combinations post-creation is a sizes change.
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

// For the one-row-per-color style codes real catalog practice actually uses
// (AISW-208A, AISW-208B… — see api/_lib/styleCodes.js) the color letter is
// already the last character of styleCode itself, so appending it again
// would double it up (AISW-208BB/L). The SKU is just styleCode + '/' +
// size; `color` is still stored on the row (for filtering/EAN lookups) but
// isn't repeated into the SKU string.
async function syncSkusForColorCodedStyle(styleCode, color, sizes) {
  const rows = sizes.map((size) => ({ sku: `${styleCode}/${size}`, style_code: styleCode, color, size }));
  if (!rows.length) return;
  const { error } = await supabaseAdmin.from('skus').upsert(rows, { onConflict: 'sku', ignoreDuplicates: true });
  if (error) throw error;
}

module.exports = { syncSkusForStyle, syncSkusForColorCodedStyle };
