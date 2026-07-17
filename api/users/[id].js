// PATCH /api/users/:id — edit name/email/role/status/two_fa. Requires edit on User Management.
// DELETE /api/users/:id — remove a user entirely (profile + auth account).
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

module.exports = withErrorHandling(async (req, res) => {
  const { id } = req.query;
  if (!id) throw new HttpError(400, 'Missing user id.');

  const { profile: actor } = await requireModulePermission(req, 'User Management', 'edit');

  const { data: target, error: findErr } = await supabaseAdmin
    .from('profiles').select('*').eq('id', id).single();
  if (findErr || !target) throw new HttpError(404, 'User not found.');

  if (req.method === 'PATCH') {
    const { name, email, role, status, two_fa } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = String(name).trim();
    if (role !== undefined) patch.role = role;
    if (status !== undefined) patch.status = status;
    if (two_fa !== undefined) patch.two_fa = !!two_fa;

    if (email !== undefined && email !== target.email) {
      const { error: emailErr } = await supabaseAdmin.auth.admin.updateUserById(id, { email });
      if (emailErr) throw new HttpError(400, emailErr.message);
      patch.email = email;
    }

    if (!Object.keys(patch).length) throw new HttpError(400, 'No fields to update.');

    const { data: updated, error } = await supabaseAdmin
      .from('profiles').update(patch).eq('id', id).select().single();
    if (error) throw new HttpError(500, error.message);

    await writeAudit({
      profile: actor, action: 'update', entity: 'User',
      detail: `Updated user ${updated.name} (${updated.email})`,
    });

    return res.status(200).json({ data: updated });
  }

  if (req.method === 'DELETE') {
    const { error: delProfileErr } = await supabaseAdmin.from('profiles').delete().eq('id', id);
    if (delProfileErr) throw new HttpError(500, delProfileErr.message);

    const { error: delAuthErr } = await supabaseAdmin.auth.admin.deleteUser(id);
    if (delAuthErr) console.error('Profile deleted but auth user removal failed:', delAuthErr);

    await writeAudit({
      profile: actor, action: 'delete', entity: 'User',
      detail: `Removed user ${target.name} (${target.email})`,
    });

    return res.status(200).json({ data: { id } });
  }

  throw new HttpError(405, 'Method not allowed.');
});
