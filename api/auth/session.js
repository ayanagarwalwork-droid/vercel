// GET /api/auth/session
// Returns the caller's profile plus their role's full permission map, e.g.
// { profile: {...}, permissions: { Dashboard: 'view', Styles: 'edit', ... } }
// The frontend calls this right after supabase.auth signs someone in, to
// populate `me` and gate the sidebar nav.
const { requireModulePermission, getPermissionsForRole, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');

module.exports = withErrorHandling(async (req, res) => {
  if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');

  const { profile } = await requireModulePermission(req); // auth only, no module check

  const permissions = await getPermissionsForRole(profile.role);

  // Best-effort last_active bump — not critical if it fails.
  await supabaseAdmin
    .from('profiles')
    .update({ last_active: new Date().toISOString() })
    .eq('id', profile.id);

  res.status(200).json({ profile, permissions });
});
