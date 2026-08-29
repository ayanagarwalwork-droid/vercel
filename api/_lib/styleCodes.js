// Real catalog practice bakes the color letter directly into the style
// CODE itself (e.g. AISW-208A, AISW-208B, AISW-208C as separate style rows)
// rather than the documented "one row, colors:[] array" model — see
// PROGRESS.md's "SKU naming rule mismatch" note. These helpers find which
// letters are already taken for a given category+number, so a new sibling
// row (a new color, or the same pattern moved into a new category) can pick
// a free one instead of colliding.
const { supabaseAdmin } = require('./supabaseAdmin');

// Splits a real style code into { number, letter } given its category (the
// category itself isn't parsed out of the string — it's already known from
// the caller's own DB row, which is more reliable than guessing where the
// category code ends).
function splitCode(code, category) {
  const rest = code.slice(category.length + 1); // +1 for the '-'
  const m = /^(\d+)([A-Za-z]?)$/.exec(rest);
  if (!m) return null;
  return { number: m[1], letter: m[2] || '' };
}

// Every existing letter used for this exact category+number, including ''
// for a style code with no letter at all (the older, documented format).
async function usedLettersFor(category, number) {
  const prefix = `${category}-${number}`;
  const { data, error } = await supabaseAdmin
    .from('styles').select('code').ilike('code', `${prefix}%`);
  if (error) throw error;
  const exact = new RegExp(`^${prefix}([A-Za-z]?)$`);
  const used = new Set();
  for (const row of data || []) {
    const m = exact.exec(row.code);
    if (m) used.add((m[1] || '').toUpperCase());
  }
  return used;
}

// preferredLetter: pass the source's own letter (possibly '') to carry it
// over when free — used by "same pattern, new category". Omit entirely
// (undefined) to always get a fresh, never-used letter — used by "new
// color on an existing SKU", which must never reuse the source's own slot.
async function nextAvailableCode(category, number, preferredLetter) {
  const used = await usedLettersFor(category, number);
  if (preferredLetter !== undefined && !used.has(preferredLetter)) {
    return { code: `${category}-${number}${preferredLetter}`, letter: preferredLetter };
  }
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    if (!used.has(letter)) return { code: `${category}-${number}${letter}`, letter };
  }
  throw new Error(`No available color letter left for ${category}-${number}.`);
}

module.exports = { splitCode, usedLettersFor, nextAvailableCode };
