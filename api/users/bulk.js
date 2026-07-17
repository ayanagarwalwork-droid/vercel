// POST /api/users/bulk { ids: string[], action: 'activate'|'deactivate'|'remove' }
// Requires edit on User Management.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

const VALID_ACTIONS = new Set(['activate', 'deactivate', 'remove']);

module.exports = withErrorHandling(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');

  const { profile: actor } = await requireModulePermission(req, 'User Management', 'edit');

  const { ids, action } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'ids must be a non-empty array.');
  if (!VALID_ACTIONS.has(action)) throw new HttpError(400, 'Invalid action.');

  if (action === 'remove') {
    const { error } = await supabaseAdmin.from('profiles').delete().in('id', ids);
    if (error) throw new HttpError(500, error.message);
    await Promise.all(ids.map((id) => supabaseAdmin.auth.admin.deleteUser(id).catch((e) => console.error(e))));
  } else {
    const status = action === 'activate' ? 'active' : 'inactive';
    const { error } = await supabaseAdmin.from('profiles').update({ status }).in('id', ids);
    if (error) throw new HttpError(500, error.message);
  }

  await writeAudit({
    profile: actor, action: action === 'remove' ? 'delete' : 'update', entity: 'User',
    detail: `Bulk ${action} on ${ids.length} user(s)`,
  });

  res.status(200).json({ data: { ids, action } });
});
