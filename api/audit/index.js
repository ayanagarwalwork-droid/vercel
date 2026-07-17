// GET /api/audit — most recent audit log entries. Requires view on Audit Trail.
// Intentionally GET-only: there is no POST/PATCH/DELETE route here, by
// design — audit rows can only ever be written as a side effect of another
// mutating endpoint (see api/_lib/audit.js), never directly by a client.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');

const DEFAULT_LIMIT = 500;

module.exports = withErrorHandling(async (req, res) => {
  if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');

  await requireModulePermission(req, 'Audit Trail', 'view');

  const limit = Math.min(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 2000);
  const offset = parseInt(req.query.offset, 10) || 0;

  const { data, error } = await supabaseAdmin
    .from('audit_log')
    .select('*')
    .order('ts', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new HttpError(500, error.message);

  res.status(200).json({ data });
});
