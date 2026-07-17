// GET /api/styles — full style list (client does its own filtering, same as
//   the prototype already did over STYLES_DATA — see public/desktop.html's
//   renderStyles()). Requires view on Styles.
// POST /api/styles — create a style via the create_style_with_code RPC, which
//   generates the style code server-side (race-condition-safe SKU Engine —
//   see supabase/migrations/0004_sku_engine_function.sql). Requires edit.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

module.exports = withErrorHandling(async (req, res) => {
  if (req.method === 'GET') {
    await requireModulePermission(req, 'Styles', 'view');
    const { data, error } = await supabaseAdmin
      .from('styles').select('*').order('added_at', { ascending: true });
    if (error) throw new HttpError(500, error.message);
    return res.status(200).json({ data });
  }

  if (req.method === 'POST') {
    const { profile: actor } = await requireModulePermission(req, 'Styles', 'edit');

    const { category, name, status, colors, sizes, mrp, cost_price, hsn_code, description, images } = req.body || {};
    if (!category) throw new HttpError(400, 'Select a category.');
    if (!name || !String(name).trim()) throw new HttpError(400, 'Enter a style name.');
    if (!Array.isArray(sizes) || !sizes.length) throw new HttpError(400, 'Select at least one size.');
    const colorList = Array.isArray(colors) && colors.length ? colors : ['A'];

    const rpcArgs = {
      p_category: category, p_name: String(name).trim(), p_status: status || 'active',
      p_colors: colorList, p_sizes: sizes,
      p_mrp: mrp || null, p_cost_price: cost_price || null, p_hsn_code: hsn_code || null,
      p_description: description || null, p_images: images || [], p_created_by: actor.id,
    };

    let { data, error } = await supabaseAdmin.rpc('create_style_with_code', rpcArgs);
    if (error && error.code === '23505') {
      // Unique-violation backstop (see the migration's comment) — retry once.
      ({ data, error } = await supabaseAdmin.rpc('create_style_with_code', rpcArgs));
    }
    if (error) throw new HttpError(400, error.message);

    await writeAudit({
      profile: actor, action: 'create', entity: 'Style',
      detail: `Created style ${data.code} — ${data.name}`,
    });

    return res.status(201).json({ data });
  }

  throw new HttpError(405, 'Method not allowed.');
});
