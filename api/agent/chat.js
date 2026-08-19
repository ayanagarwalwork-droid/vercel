// POST /api/agent/chat { message, history }
// A real tool-using agent: Claude decides which read/write tools to call, we
// execute them against Supabase, and loop until it has a final answer.
// Requires view on "Stitch" to chat at all; the write-action tools
// additionally require edit — enforced per-call in executeTool(), not just
// at the door, since a view-level caller could otherwise ask the model to
// invoke one and get an error instead of a silent bypass.
const Anthropic = require('@anthropic-ai/sdk');
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

const MODEL = 'claude-sonnet-5';
const MAX_HISTORY_TURNS = 6;
const MAX_TOOL_ROUNDS = 6;
const MAX_ROWS = 100;

let anthropic;
function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new HttpError(500, 'Stitch is not configured yet (missing ANTHROPIC_API_KEY).');
  }
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

// ── TOOL DEFINITIONS ────────────────────────────────────────────────────
// Read tools query live tables directly (capped row counts, no free-form
// SQL). Write tools are a small allowlist that mirrors exactly what the
// corresponding manual UI action does, including its own validation and
// audit logging — the agent has no path to anything outside this list.
const TOOLS = [
  {
    name: 'search_styles',
    description: 'Search the styles catalog. Any filter can be omitted to not filter on it.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category code, e.g. AILW' },
        status: { type: 'string', enum: ['active', 'inactive'] },
        missing_images: { type: 'boolean', description: 'true = only styles with zero images' },
        limit: { type: 'integer', description: `Max rows, default 20, capped at ${MAX_ROWS}` },
      },
    },
  },
  {
    name: 'search_listings',
    description: 'Search marketplace listings. Any filter can be omitted to not filter on it.',
    input_schema: {
      type: 'object',
      properties: {
        sku: { type: 'string' },
        style_code: { type: 'string' },
        marketplace: { type: 'string', enum: ['Myntra', 'Nykaa', 'Amazon', 'Ajio', 'Flipkart'] },
        status: { type: 'string', enum: ['draft', 'pending', 'live'] },
        limit: { type: 'integer', description: `Max rows, default 20, capped at ${MAX_ROWS}` },
      },
    },
  },
  {
    name: 'search_skus',
    description: 'Search SKUs (style+color+size) and their EAN/barcode status. EAN lives on the SKU, not the listing.',
    input_schema: {
      type: 'object',
      properties: {
        style_code: { type: 'string' },
        ean_status: { type: 'string', enum: ['unassigned', 'assigned', 'printed'] },
        limit: { type: 'integer', description: `Max rows, default 20, capped at ${MAX_ROWS}` },
      },
    },
  },
  {
    name: 'get_audit_log',
    description: 'Recent audit trail entries, most recent first.',
    input_schema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: "e.g. 'Style', 'Listing', 'EAN'" },
        limit: { type: 'integer', description: `Max rows, default 20, capped at ${MAX_ROWS}` },
      },
    },
  },
  {
    name: 'get_import_history',
    description: 'Recent CSV import runs, most recent first.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: `Max rows, default 10, capped at ${MAX_ROWS}` } },
    },
  },
  {
    name: 'get_catalog_health_summary',
    description: 'One-shot aggregate snapshot of catalog data quality and recent activity — counts for missing images/EANs/costing, listing status breakdown, and how long since the last import. Use this first when asked for feedback, a health check, or "what should I improve" — it is cheaper and more complete than piecing the picture together from several search_* calls.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'assign_ean',
    description: 'Assign an EAN/barcode to a SKU. Requires edit access.',
    input_schema: {
      type: 'object',
      required: ['sku', 'ean'],
      properties: {
        sku: { type: 'string' },
        ean: { type: 'string', description: '8, 12, 13 or 14 digit barcode' },
      },
    },
  },
  {
    name: 'update_listing_status',
    description: 'Change a listing\'s status (draft/pending/live). Requires edit access.',
    input_schema: {
      type: 'object',
      required: ['sku', 'marketplace', 'status'],
      properties: {
        sku: { type: 'string' },
        marketplace: { type: 'string', enum: ['Myntra', 'Nykaa', 'Amazon', 'Ajio', 'Flipkart'] },
        status: { type: 'string', enum: ['draft', 'pending', 'live'] },
      },
    },
  },
  {
    name: 'update_style_status',
    description: 'Mark a style active or inactive. Requires edit access.',
    input_schema: {
      type: 'object',
      required: ['style_code', 'status'],
      properties: {
        style_code: { type: 'string' },
        status: { type: 'string', enum: ['active', 'inactive'] },
      },
    },
  },
];

const WRITE_TOOLS = new Set(['assign_ean', 'update_listing_status', 'update_style_status']);

function clampLimit(n, fallback) {
  return Math.min(Math.max(parseInt(n, 10) || fallback, 1), MAX_ROWS);
}

async function executeTool(name, input, actor, level) {
  if (WRITE_TOOLS.has(name) && level !== 'edit') {
    return { error: 'This action requires edit access to Stitch, which your role does not have.' };
  }

  if (name === 'search_styles') {
    let q = supabaseAdmin.from('styles')
      .select('code, name, category, status, colors, sizes, sku_count, images')
      .limit(clampLimit(input.limit, 20));
    if (input.category) q = q.eq('category', input.category);
    if (input.status) q = q.eq('status', input.status);
    const { data, error } = await q;
    if (error) return { error: error.message };
    const rows = input.missing_images ? (data || []).filter((s) => !s.images || !s.images.length) : data;
    return { rows };
  }

  if (name === 'search_listings') {
    let q = supabaseAdmin.from('listings')
      .select('sku, style_code, marketplace, marketplace_sku, type, status, mrp, launch_date')
      .limit(clampLimit(input.limit, 20));
    if (input.sku) q = q.eq('sku', input.sku);
    if (input.style_code) q = q.eq('style_code', input.style_code);
    if (input.marketplace) q = q.eq('marketplace', input.marketplace);
    if (input.status) q = q.eq('status', input.status);
    const { data, error } = await q;
    if (error) return { error: error.message };
    return { rows: data };
  }

  if (name === 'search_skus') {
    let q = supabaseAdmin.from('skus')
      .select('sku, style_code, color, size, ean, ean_status')
      .limit(clampLimit(input.limit, 20));
    if (input.style_code) q = q.eq('style_code', input.style_code);
    if (input.ean_status) q = q.eq('ean_status', input.ean_status);
    const { data, error } = await q;
    if (error) return { error: error.message };
    return { rows: data };
  }

  if (name === 'get_audit_log') {
    let q = supabaseAdmin.from('audit_log')
      .select('ts, actor_name, role, action, entity, detail')
      .order('ts', { ascending: false })
      .limit(clampLimit(input.limit, 20));
    if (input.entity) q = q.eq('entity', input.entity);
    const { data, error } = await q;
    if (error) return { error: error.message };
    return { rows: data };
  }

  if (name === 'get_import_history') {
    const { data, error } = await supabaseAdmin.from('import_history')
      .select('date, type, filename, row_count, status, imported_by')
      .order('created_at', { ascending: false })
      .limit(clampLimit(input.limit, 10));
    if (error) return { error: error.message };
    return { rows: data };
  }

  if (name === 'get_catalog_health_summary') {
    const [
      { count: totalStyles },
      { count: activeStyles },
      { count: totalSkus },
      { count: skusMissingEan },
      { count: totalListings },
      { count: liveListings },
      { count: pendingListings },
      { count: draftListings },
      { data: styleImageRows },
      { data: costedStyleCodes },
      { data: recentAudit },
      { data: recentImports },
    ] = await Promise.all([
      supabaseAdmin.from('styles').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('styles').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      supabaseAdmin.from('skus').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('skus').select('*', { count: 'exact', head: true }).eq('ean_status', 'unassigned'),
      supabaseAdmin.from('listings').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('listings').select('*', { count: 'exact', head: true }).eq('status', 'live'),
      supabaseAdmin.from('listings').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabaseAdmin.from('listings').select('*', { count: 'exact', head: true }).eq('status', 'draft'),
      supabaseAdmin.from('styles').select('images'),
      supabaseAdmin.from('style_costing_items').select('style_code'),
      supabaseAdmin.from('audit_log').select('ts, actor_name, action, entity, detail').order('ts', { ascending: false }).limit(8),
      supabaseAdmin.from('import_history').select('date, type, row_count, status').order('created_at', { ascending: false }).limit(5),
    ]);

    const stylesMissingImages = (styleImageRows || []).filter((s) => !s.images || !s.images.length).length;
    const codedStyles = new Set((costedStyleCodes || []).map((r) => r.style_code));
    const stylesMissingCosting = (totalStyles || 0) - codedStyles.size;
    const daysSinceLastImport = recentImports?.[0]
      ? Math.floor((Date.now() - new Date(recentImports[0].date)) / 86400000)
      : null;

    return {
      styles: { total: totalStyles, active: activeStyles, missingImages: stylesMissingImages, missingCosting: Math.max(stylesMissingCosting, 0) },
      skus: { total: totalSkus, missingEan: skusMissingEan },
      listings: { total: totalListings, live: liveListings, pending: pendingListings, draft: draftListings },
      daysSinceLastImport,
      recentAudit, recentImports,
    };
  }

  if (name === 'assign_ean') {
    const { sku, ean } = input;
    if (!/^\d{8}$|^\d{12,14}$/.test(String(ean || ''))) {
      return { error: 'EAN must be 8, 12, 13 or 14 digits.' };
    }
    const { data: updated, error } = await supabaseAdmin
      .from('skus')
      .update({ ean, ean_status: 'assigned', updated_at: new Date().toISOString() })
      .eq('sku', sku).select().maybeSingle();
    if (error) return { error: error.message };
    if (!updated) return { error: `SKU not found: ${sku}` };

    await writeAudit({
      profile: actor, action: 'assign', entity: 'EAN',
      detail: `Assigned EAN ${ean} to SKU ${sku} (via Stitch)`,
    });
    return { ok: true, sku: updated };
  }

  if (name === 'update_listing_status') {
    const { sku, marketplace, status } = input;
    const { data: existing, error: findErr } = await supabaseAdmin
      .from('listings').select('*').eq('sku', sku).eq('marketplace', marketplace).maybeSingle();
    if (findErr) return { error: findErr.message };
    if (!existing) return { error: `No listing found for SKU ${sku} on ${marketplace}.` };

    const patch = { status, updated_at: new Date().toISOString() };
    if (status === 'live' && !existing.launch_date) patch.launch_date = new Date().toISOString().slice(0, 10);

    const { data: updated, error } = await supabaseAdmin
      .from('listings').update(patch).eq('id', existing.id).select().single();
    if (error) return { error: error.message };

    await writeAudit({
      profile: actor, action: 'update', entity: 'Listing',
      detail: `Updated listing ${updated.sku} on ${updated.marketplace} — status: ${updated.status} (via Stitch)`,
    });
    return { ok: true, listing: updated };
  }

  if (name === 'update_style_status') {
    const { style_code, status } = input;
    const { data: existing, error: findErr } = await supabaseAdmin
      .from('styles').select('code').eq('code', style_code).maybeSingle();
    if (findErr) return { error: findErr.message };
    if (!existing) return { error: `Style not found: ${style_code}` };

    const { data: updated, error } = await supabaseAdmin
      .from('styles').update({ status, updated_at: new Date().toISOString() }).eq('code', style_code).select().single();
    if (error) return { error: error.message };

    await writeAudit({
      profile: actor, action: 'update', entity: 'Style',
      detail: `Marked style ${style_code} ${status} (via Stitch)`,
    });
    return { ok: true, style: updated };
  }

  return { error: `Unknown tool: ${name}` };
}

module.exports = withErrorHandling(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');

  const { profile: actor, level } = await requireModulePermission(req, 'Stitch', 'view');

  const message = String(req.body?.message || '').trim();
  if (!message) throw new HttpError(400, 'Message is required.');
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-MAX_HISTORY_TURNS) : [];

  const client = getAnthropicClient();
  const systemPrompt =
    "You are AOBA PMOS's Stitch. You can query the live catalog database yourself via " +
    'tools, and — for users with edit access — take a small set of ' +
    'well-defined actions (assign an EAN, change a listing status, change a style status). ' +
    'Always look up real data with a tool before answering factual questions; never guess at ' +
    "SKUs, styles, or counts. Before calling a write tool, briefly state what you're about to " +
    'do. If a write tool returns a permission error, tell the user plainly that their role ' +
    "lacks edit access rather than retrying.\n\n" +
    'When asked for feedback, a health check, or "what should I improve" — call ' +
    'get_catalog_health_summary first, then reply with a short, concrete, prioritized list ' +
    '(most urgent/highest-impact first). Cite real numbers from the tool, not estimates. ' +
    'For each point, name the specific screen/action to fix it (e.g. "12 SKUs have no EAN — ' +
    'assign them from the EAN / Barcode page or a bulk EAN import"). Skip categories that are ' +
    'already clean rather than padding the list. If nothing needs attention, say so plainly.';

  const messages = [...history, { role: 'user', content: message }];

  let finalText = "I couldn't generate a response.";
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    const textBlocks = response.content.filter((b) => b.type === 'text');
    finalText = textBlocks.map((b) => b.text).join('\n') || finalText;

    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: response.content });
    const toolResults = [];
    for (const use of toolUses) {
      const result = await executeTool(use.name, use.input || {}, actor, level);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(result),
        is_error: !!result.error,
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  res.status(200).json({ data: { reply: finalText } });
});
