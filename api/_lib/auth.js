// The single chokepoint every API handler uses to authenticate the caller and
// check their role's permission level for a module before allowing a request.
// This is the server-side enforcement layer — the client also hides/disables
// UI for modules a user can't access, but that's UX only; this is what's
// actually authoritative.
const { supabaseAdmin } = require('./supabaseAdmin');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const RANK = { none: 0, view: 1, edit: 2 };

/**
 * Verifies the bearer token, loads the caller's profile, and (if a module is
 * given) checks their role has at least `minLevel` on that module.
 *
 * @param {import('http').IncomingMessage} req
 * @param {string} [module] - one of the app_module enum values. Omit to just
 *   authenticate without a permission check (e.g. GET /api/auth/session).
 * @param {'view'|'edit'} [minLevel]
 * @returns {Promise<{ user: object, profile: object, level: string }>}
 */
async function requireModulePermission(req, module, minLevel) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) throw new HttpError(401, 'Missing Authorization header.');

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) throw new HttpError(401, 'Invalid or expired session.');
  const user = userData.user;

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();
  if (profileErr || !profile) throw new HttpError(403, 'No profile found for this account.');
  if (profile.status !== 'active') throw new HttpError(403, 'This account is inactive.');

  if (!module) return { user, profile, level: null };

  const { data: perm, error: permErr } = await supabaseAdmin
    .from('role_permissions')
    .select('level')
    .eq('role', profile.role)
    .eq('module', module)
    .single();
  if (permErr) throw new HttpError(500, 'Could not resolve permissions.');

  const level = perm?.level ?? 'none';
  if (minLevel && RANK[level] < RANK[minLevel]) {
    throw new HttpError(403, `${profile.role} lacks ${minLevel} access to ${module}.`);
  }

  return { user, profile, level };
}

/** Fetches the full (role, module) -> level matrix for one role, shaped as
 *  { [module]: 'edit'|'view'|'none' } — used by /api/auth/session. */
async function getPermissionsForRole(role) {
  const { data, error } = await supabaseAdmin
    .from('role_permissions')
    .select('module, level')
    .eq('role', role);
  if (error) throw new HttpError(500, 'Could not load role permissions.');
  const map = {};
  for (const row of data) map[row.module] = row.level;
  return map;
}

/** Wraps a Vercel serverless handler, catching HttpError and sending a clean
 *  JSON error response instead of a raw 500 stack trace. */
function withErrorHandling(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      res.status(status).json({ error: err.message || 'Internal server error.' });
    }
  };
}

module.exports = { HttpError, requireModulePermission, getPermissionsForRole, withErrorHandling };
