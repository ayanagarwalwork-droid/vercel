// GET /api/import/history — most recent import runs, for populating the
// Import page's history table. Requires view on Import.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');

module.exports = withErrorHandling(async (req, res) => {
  if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');

  await requireModulePermission(req, 'Import', 'view');

  const { data, error } = await supabaseAdmin
    .from('import_history').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) throw new HttpError(500, error.message);

  res.status(200).json({ data });
});
