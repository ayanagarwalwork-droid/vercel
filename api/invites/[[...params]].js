// Catch-all for /api/invites, /api/invites/:id — consolidated into one file
// (was 2 separate files) to stay under Vercel Hobby's 12 serverless function
// limit. URL paths the frontend calls are unchanged.
//
// GET   /api/invites     — list pending invites. Requires view on User Management.
// POST  /api/invites     — { email, role }. Requires edit.
// PATCH /api/invites/:id — revoke a pending invite. Requires edit.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

const VALID_ROLES = new Set([
  'Founder', 'Admin', 'Merchandising', 'Catalog Team',
  'Marketplace Team', 'Designer', 'Accounts', 'Warehouse',
]);

module.exports = withErrorHandling(async (req, res) => {
  const params = req.query.params || [];

  // GET/POST /api/invites
  if (params.length === 0) {
    if (req.method === 'GET') {
      await requireModulePermission(req, 'User Management', 'view');
      const { data, error } = await supabaseAdmin
        .from('invites').select('*').eq('status', 'pending').order('invited_at', { ascending: false });
      if (error) throw new HttpError(500, error.message);
      return res.status(200).json({ data });
    }

    if (req.method === 'POST') {
      const { profile: actor } = await requireModulePermission(req, 'User Management', 'edit');

      const email = String(req.body?.email || '').trim().toLowerCase();
      const role = req.body?.role;
      if (!email || !email.includes('@')) throw new HttpError(400, 'Enter a valid email address.');
      if (!VALID_ROLES.has(role)) throw new HttpError(400, 'Select a valid role.');

      const { data: existingProfile } = await supabaseAdmin
        .from('profiles').select('id').eq('email', email).maybeSingle();
      if (existingProfile) throw new HttpError(409, 'This email already has an account.');

      const { data: existingInvite } = await supabaseAdmin
        .from('invites').select('id').eq('email', email).eq('status', 'pending').maybeSingle();
      if (existingInvite) throw new HttpError(409, 'Invite already sent to this email.');

      const redirectTo = `${process.env.SITE_URL || ''}/desktop.html`;
      const { data: inviteData, error: inviteErr } =
        await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo });
      if (inviteErr) throw new HttpError(500, inviteErr.message);

      const authUser = inviteData.user;
      const name = email.split('@')[0];

      const { data: newProfile, error: profileErr } = await supabaseAdmin
        .from('profiles')
        .insert({ id: authUser.id, name, email, role, status: 'active' })
        .select().single();
      if (profileErr) {
        await supabaseAdmin.auth.admin.deleteUser(authUser.id).catch(() => {});
        throw new HttpError(500, profileErr.message);
      }

      const { data: invite, error: inviteRowErr } = await supabaseAdmin
        .from('invites')
        .insert({ email, role, invited_by: actor.id })
        .select().single();
      if (inviteRowErr) throw new HttpError(500, inviteRowErr.message);

      await writeAudit({
        profile: actor, action: 'create', entity: 'User',
        detail: `Invited ${email} as ${role}`,
      });

      return res.status(201).json({ data: { profile: newProfile, invite } });
    }

    throw new HttpError(405, 'Method not allowed.');
  }

  // PATCH /api/invites/:id
  if (params.length === 1) {
    if (req.method !== 'PATCH') throw new HttpError(405, 'Method not allowed.');
    const id = params[0];

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

    return res.status(200).json({ data: { id } });
  }

  throw new HttpError(404, 'Not found.');
});
