// Writes an audit_log row. Called only from server-side mutating handlers —
// there is intentionally no client-callable "log this" endpoint, so every
// entry is guaranteed to reflect something that actually happened, performed
// by whoever the verified session says performed it (never a client-supplied
// actor name).
const { supabaseAdmin } = require('./supabaseAdmin');

/**
 * @param {object} params
 * @param {object} params.profile - the acting user's profile row (from requireModulePermission)
 * @param {'create'|'update'|'delete'|'login'|'export'|'permission'|'import'|'assign'} params.action
 * @param {string} params.entity - e.g. 'User', 'Style', 'Listing', 'Permissions'
 * @param {string} params.detail
 */
async function writeAudit({ profile, action, entity, detail }) {
  const { error } = await supabaseAdmin.from('audit_log').insert({
    actor: profile?.id ?? null,
    actor_name: profile?.name ?? 'System',
    role: profile?.role ?? null,
    action,
    entity,
    detail,
  });
  // Audit writes should never take down the primary request if they fail —
  // log and move on rather than throwing.
  if (error) console.error('Failed to write audit log:', error);
}

module.exports = { writeAudit };
