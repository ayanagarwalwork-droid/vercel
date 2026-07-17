// POST /api/styles/upload-image { filename, styleCode } — mints a short-lived
// signed upload URL for the style-images bucket. The browser then uploads
// the file bytes directly to Supabase Storage using that token (not proxied
// through this function, so we're not subject to Vercel's request body size
// limits). Requires edit on Styles.
const { requireModulePermission, withErrorHandling, HttpError } = require('../_lib/auth');
const { supabaseAdmin } = require('../_lib/supabaseAdmin');

module.exports = withErrorHandling(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');

  await requireModulePermission(req, 'Styles', 'edit');

  const { filename, styleCode } = req.body || {};
  if (!filename) throw new HttpError(400, 'Missing filename.');

  const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${styleCode || 'draft'}/${Date.now()}-${safeName}`;

  const { data, error } = await supabaseAdmin.storage.from('style-images').createSignedUploadUrl(path);
  if (error) throw new HttpError(500, error.message);

  res.status(200).json({ data: { signedUrl: data.signedUrl, token: data.token, path } });
});
