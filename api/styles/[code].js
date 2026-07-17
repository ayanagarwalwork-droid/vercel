// GET /api/styles/:code — one style. Requires view on Styles.
// PATCH /api/styles/:code — edit name/status/hsn/mrp/cost/description/images/sizes
//   (category and colors are not editable, matching the prototype's edit
//   mode — see saveStyleEdit() in public/desktop.html). Requires edit.
// DELETE /api/styles/:code — requires edit. (Not exposed in the UI yet — the
//   prototype has no delete-style button, only reactivate/deactivate — but
//   the capability is here for completeness.)
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

module.exports = withErrorHandling(async (req, res) => {
  const { code } = req.query;
  if (!code) throw new HttpError(400, 'Missing style code.');

  if (req.method === 'GET') {
    await requireModulePermission(req, 'Styles', 'view');
    const { data, error } = await supabaseAdmin.from('styles').select('*').eq('code', code).single();
    if (error || !data) throw new HttpError(404, 'Style not found.');
    return res.status(200).json({ data });
  }

  const { profile: actor } = await requireModulePermission(req, 'Styles', 'edit');

  const { data: existing, error: findErr } = await supabaseAdmin
    .from('styles').select('*').eq('code', code).single();
  if (findErr || !existing) throw new HttpError(404, 'Style not found.');

  if (req.method === 'PATCH') {
    const { name, status, hsn_code, mrp, cost_price, description, images, sizes } = req.body || {};
    if (name !== undefined && !String(name).trim()) throw new HttpError(400, 'Style name is required.');
    if (sizes !== undefined && (!Array.isArray(sizes) || !sizes.length)) {
      throw new HttpError(400, 'Select at least one size.');
    }
    if (images !== undefined && Array.isArray(images) && images.length > 4) {
      throw new HttpError(400, 'A style can have at most 4 images.');
    }

    const patch = {};
    if (name !== undefined) patch.name = String(name).trim();
    if (status !== undefined) patch.status = status;
    if (hsn_code !== undefined) patch.hsn_code = hsn_code;
    if (mrp !== undefined) patch.mrp = mrp || null;
    if (cost_price !== undefined) patch.cost_price = cost_price || null;
    if (description !== undefined) patch.description = description;
    if (images !== undefined) patch.images = images;
    if (sizes !== undefined) patch.sizes = sizes;
    patch.updated_at = new Date().toISOString();

    const { data: updated, error } = await supabaseAdmin
      .from('styles').update(patch).eq('code', code).select().single();
    if (error) throw new HttpError(500, error.message);

    await writeAudit({
      profile: actor, action: 'update', entity: 'Style',
      detail: `Updated style ${code} — ${updated.name}`,
    });

    return res.status(200).json({ data: updated });
  }

  if (req.method === 'DELETE') {
    const { error } = await supabaseAdmin.from('styles').delete().eq('code', code);
    if (error) throw new HttpError(500, error.message);

    await writeAudit({
      profile: actor, action: 'delete', entity: 'Style',
      detail: `Deleted style ${code} — ${existing.name}`,
    });

    return res.status(200).json({ data: { code } });
  }

  throw new HttpError(405, 'Method not allowed.');
});
