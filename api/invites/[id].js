// PATCH /api/invites/:id — revoke a pending invite. Requires edit on User Management.
// Only works while the invite is still unaccepted (the user never set a
// password); once accepted, they're a real user and should be removed via
// DELETE /api/users/:id instead.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

module.exports = withErrorHandling(async (req, res) => {
  if (req.method !== 'PATCH') throw new HttpError(405, 'Method not allowed.');
  const { id } = req.query;

  const { profile: actor } = await requireModulePermission(req, 'User Management', 'edit');

  const { data: invite, error: findErr } = await supabaseAdmin
    .from('invites').select('*').eq('id', id).single();
  if (findErr || !invite) throw new HttpError(404, 'Invite not found.');
  if (invite.status !== 'pending') throw new HttpError(400, 'Invite is not pending.');

  const { data: authList } = await supabaseAdmin.auth.admin.listUsers();
  const authUser = authList?.users?.find((u) => u.email === invite.email);

  if (authUser) {
    if (authUser.email_confirmed_at) {
      throw new HttpError(400, 'This user already accepted the invite — remove them from Users instead.');
    }
    await supabaseAdmin.auth.admin.deleteUser(authUser.id).catch((e) => console.error(e));
    await supabaseAdmin.from('profiles').delete().eq('id', authUser.id);
  }

  const { error } = await supabaseAdmin.from('invites').update({ status: 'revoked' }).eq('id', id);
  if (error) throw new HttpError(500, error.message);

  await writeAudit({
    profile: actor, action: 'delete', entity: 'User',
    detail: `Revoked invite for ${invite.email}`,
  });

  res.status(200).json({ data: { id } });
});
