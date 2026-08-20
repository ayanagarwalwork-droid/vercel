// Weekly automated backup — dumps every real business table into one JSON
// bundle and stores it in a private Supabase Storage bucket. Triggered by
// Vercel Cron (see vercel.json's "crons" entry); Vercel automatically sends
// `Authorization: Bearer $CRON_SECRET` on cron-triggered requests when that
// env var is set, so checking it here is enough to keep this endpoint from
// being triggered (or its contents read) by anyone else hitting the URL.
//
// Storage location is an interim choice, not the final one: Supabase
// Storage, in a bucket separate from live data, so a corrupted or
// accidentally-deleted row is at least recoverable. This does NOT protect
// against losing the whole Supabase account — swap the upload step below for
// an external destination once one is chosen; everything above it already
// produces a single portable JSON file.
//
// profiles/invites are deliberately exported as a count only, not full rows
// — a leaked backup file shouldn't also leak every teammate's name/email.
const { withErrorHandling, HttpError } = require('./_lib/auth');
const { supabaseAdmin } = require('./_lib/supabaseAdmin');
const { writeAudit } = require('./_lib/audit');

const TABLES = ['styles', 'skus', 'listings', 'style_costing_items', 'role_permissions', 'import_history', 'audit_log'];

module.exports = withErrorHandling(async (req, res) => {
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    throw new HttpError(401, 'Unauthorized.');
  }

  const [tableResults, profileCount] = await Promise.all([
    Promise.all(TABLES.map((table) => supabaseAdmin.from(table).select('*'))),
    supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }),
  ]);

  const bundle = { generated_at: new Date().toISOString(), tables: {} };
  TABLES.forEach((table, i) => {
    const { data, error } = tableResults[i];
    if (error) throw new HttpError(500, `Failed exporting ${table}: ${error.message}`);
    bundle.tables[table] = data || [];
  });
  bundle.tables.profiles_count = profileCount.count || 0;

  const json = JSON.stringify(bundle, null, 2);
  const path = `backup-${bundle.generated_at.slice(0, 10)}-${Date.now()}.json`;
  const { error: upErr } = await supabaseAdmin.storage.from('backups').upload(path, json, {
    contentType: 'application/json', upsert: false,
  });
  if (upErr) throw new HttpError(500, `Failed to store backup: ${upErr.message}`);

  const summary = Object.entries(bundle.tables)
    .map(([t, v]) => `${t}: ${Array.isArray(v) ? v.length : v}`).join(', ');
  await writeAudit({
    profile: null, action: 'export', entity: 'Backup',
    detail: `Automated backup created: ${path} (${summary})`,
  });

  return res.status(200).json({ data: { path, tables: Object.keys(bundle.tables) } });
});
