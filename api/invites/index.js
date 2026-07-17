// POST /api/invites { email, role } — invites a new team member.
// Creates the Supabase Auth user (unconfirmed, emailed a magic link to set
// their password), the matching `profiles` row, and an `invites` tracking
// row for the Pending Invites UI section. Requires edit on User Management.
//
// This replaces the prototype's "admin types a password directly" flow —
// real backends shouldn't handle plaintext passwords that way.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

const VALID_ROLES = new Set([
  'Founder', 'Admin', 'Merchandising', 'Catalog Team',
  'Marketplace Team', 'Designer', 'Accounts', 'Warehouse',
]);

module.exports = withErrorHandling(async (req, res) => {
  if (req.method === 'GET') {
    await requireModulePermission(req, 'User Management', 'view');
    const { data, error } = await supabaseAdmin
      .from('invites').select('*').eq('status', 'pending').order('invited_at', { ascending: false });
    if (error) throw new HttpError(500, error.message);
    return res.status(200).json({ data });
  }

  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');

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
  const name = email.split('@')[0]; // placeholder display name until they set one, if ever exposed

  const { data: newProfile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .insert({ id: authUser.id, name, email, role, status: 'active' })
    .select().single();
  if (profileErr) {
    // Roll back the orphaned auth user so a retry doesn't hit "already exists".
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

  res.status(201).json({ data: { profile: newProfile, invite } });
});
