// GET /api/roles/permissions — full (role, module) -> level matrix.
//   Requires view on Roles & Permissions.
// PATCH /api/roles/permissions { changes: [{ role, module, level }, ...] }
//   Applies a batch of cell changes in one call (matches the prototype's
//   "N permissions changed" staged-save UX). Requires edit on Roles & Permissions.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');
const { writeAudit } = require('../_lib/audit');

module.exports = withErrorHandling(async (req, res) => {
  if (req.method === 'GET') {
    await requireModulePermission(req, 'Roles & Permissions', 'view');
    const { data, error } = await supabaseAdmin.from('role_permissions').select('role, module, level');
    if (error) throw new HttpError(500, error.message);
    return res.status(200).json({ data });
  }

  if (req.method === 'PATCH') {
    const { profile: actor } = await requireModulePermission(req, 'Roles & Permissions', 'edit');

    const changes = req.body?.changes;
    if (!Array.isArray(changes) || !changes.length) throw new HttpError(400, 'changes must be a non-empty array.');
    for (const c of changes) {
      if (!c.role || !c.module || !['edit', 'view', 'none'].includes(c.level)) {
        throw new HttpError(400, 'Each change needs { role, module, level }.');
      }
    }

    // Founder is intentionally not user-editable — always full access — to
    // guarantee there is always at least one role that can undo a mistake.
    if (changes.some((c) => c.role === 'Founder')) {
      throw new HttpError(400, "Founder's permissions cannot be changed.");
    }

    for (const c of changes) {
      const { error } = await supabaseAdmin
        .from('role_permissions')
        .update({ level: c.level })
        .eq('role', c.role).eq('module', c.module);
      if (error) throw new HttpError(500, error.message);
    }

    await writeAudit({
      profile: actor, action: 'permission', entity: 'Permissions',
      detail: `Changed ${changes.length} permission${changes.length !== 1 ? 's' : ''}`,
    });

    return res.status(200).json({ data: { updated: changes.length } });
  }

  throw new HttpError(405, 'Method not allowed.');
});
