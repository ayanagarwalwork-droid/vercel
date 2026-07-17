// GET /api/users — list all users (profiles). Requires view+ on User Management.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');

module.exports = withErrorHandling(async (req, res) => {
  if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');

  await requireModulePermission(req, 'User Management', 'view');

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .order('added_at', { ascending: true });
  if (error) throw new HttpError(500, error.message);

  res.status(200).json({ data });
});
