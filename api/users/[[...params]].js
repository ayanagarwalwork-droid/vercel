// Catch-all for /api/users, /api/users/bulk, /api/users/:id — consolidated
// into one file (was 3 separate files) to stay under Vercel Hobby's 12
// serverless function limit. The URL paths the frontend calls are unchanged;
// only the file layout on the server changed.
//
// GET    /api/users        — list all users. Requires view on User Management.
// POST   /api/users/bulk   — { ids, action: 'activate'|'deactivate'|'remove' }. Requires edit.
// PATCH  /api/users/:id    — edit name/email/role/status/two_fa. Requires edit.
// DELETE /api/users/:id    — remove a user entirely (profile + auth account). Requires edit.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

const VALID_BULK_ACTIONS = new Set(['activate', 'deactivate', 'remove']);

module.exports = withErrorHandling(async (req, res) => {
  const params = req.query.params || [];

  // GET /api/users
  if (params.length === 0) {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    await requireModulePermission(req, 'User Management', 'view');
    const { data, error } = await supabaseAdmin
      .from('profiles').select('*').order('added_at', { ascending: true });
    if (error) throw new HttpError(500, error.message);
    return res.status(200).json({ data });
  }

  // POST /api/users/bulk
  if (params.length === 1 && params[0] === 'bulk') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const { profile: actor } = await requireModulePermission(req, 'User Management', 'edit');

    const { ids, action } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'ids must be a non-empty array.');
    if (!VALID_BULK_ACTIONS.has(action)) throw new HttpError(400, 'Invalid action.');

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

    return res.status(200).json({ data: { ids, action } });
  }

  // PATCH/DELETE /api/users/:id
  if (params.length === 1) {
    const id = params[0];
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
  }

  throw new HttpError(404, 'Not found.');
});
