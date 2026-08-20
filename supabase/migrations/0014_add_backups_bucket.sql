-- AOBA PMOS — Storage bucket for automated weekly backups (api/backup.js,
-- triggered by Vercel Cron). Private, unlike style-images: a backup file is
-- a full dump of the catalog and must never be publicly readable. Interim
-- storage location until an external destination (Drive, email, S3, etc.)
-- is chosen — everything api/backup.js produces is a single portable JSON
-- file, so only the final upload call needs to change when that happens.
insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do nothing;
