// POST /api/copilot/chat { message, history }
// Builds a compact stats snapshot of the live catalog (not a raw dump of
// every row — keeps token cost bounded) and asks Claude to answer grounded
// in that data. Requires view on AI Copilot. ANTHROPIC_API_KEY is read only
// in this file and never sent to the client.
const Anthropic = require('@anthropic-ai/sdk');
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');

const MODEL = 'claude-haiku-4-5';
const MAX_HISTORY_TURNS = 6;

let anthropic;
function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new HttpError(500, 'AI Copilot is not configured yet (missing ANTHROPIC_API_KEY).');
  }
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

async function buildCatalogContext() {
  const [
    { count: totalStyles },
    { count: activeStyles },
    { count: totalListings },
    { count: liveListings },
    { count: unassignedEan },
    { data: styleRows },
    { data: listingRows },
    { data: recentImports },
  ] = await Promise.all([
    supabaseAdmin.from('styles').select('*', { count: 'exact', head: true }),
    supabaseAdmin.from('styles').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabaseAdmin.from('listings').select('*', { count: 'exact', head: true }),
    supabaseAdmin.from('listings').select('*', { count: 'exact', head: true }).eq('status', 'live'),
    supabaseAdmin.from('listings').select('*', { count: 'exact', head: true }).eq('ean_status', 'unassigned'),
    supabaseAdmin.from('styles').select('category, status, images'),
    supabaseAdmin.from('listings').select('marketplace, status'),
    supabaseAdmin.from('import_history').select('type, row_count, date').order('created_at', { ascending: false }).limit(5),
  ]);

  const byCategory = {};
  for (const s of styleRows || []) {
    const c = (byCategory[s.category] = byCategory[s.category] || { total: 0, active: 0, missingImages: 0 });
    c.total++;
    if (s.status === 'active') c.active++;
    if (!s.images || !s.images.length) c.missingImages++;
  }

  const byMarketplace = {};
  for (const l of listingRows || []) {
    const m = (byMarketplace[l.marketplace] = byMarketplace[l.marketplace] || { total: 0, live: 0, pending: 0 });
    m.total++;
    if (l.status === 'live') m.live++;
    if (l.status === 'pending') m.pending++;
  }

  return {
    totalStyles, activeStyles, totalListings, liveListings, unassignedEan,
    byCategory, byMarketplace, recentImports,
  };
}

module.exports = withErrorHandling(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');

  await requireModulePermission(req, 'AI Copilot', 'view');

  const message = String(req.body?.message || '').trim();
  if (!message) throw new HttpError(400, 'Message is required.');
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-MAX_HISTORY_TURNS) : [];

  const context = await buildCatalogContext();
  const client = getAnthropicClient();

  const systemPrompt =
    "You are AOBA PMOS's Copilot, an assistant for AOBA's internal fashion catalog management " +
    'tool. Answer concisely and cite real numbers from the catalog data given below — never ' +
    'invent SKUs, styles, or figures that aren\'t present in it. If something isn\'t covered by ' +
    "this data, say so rather than guessing.\n\nLive catalog data:\n" + JSON.stringify(context);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    system: systemPrompt,
    messages: [...history, { role: 'user', content: message }],
  });

  const reply = response.content?.find((b) => b.type === 'text')?.text || "I couldn't generate a response.";

  res.status(200).json({ data: { reply } });
});
