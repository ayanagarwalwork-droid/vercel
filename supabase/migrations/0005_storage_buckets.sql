-- AOBA PMOS — Storage bucket for style product photos.
-- Public read (product photos are meant to be viewed on listings/marketplace
-- pages), but no public write policies: uploads only happen via short-lived
-- signed upload URLs minted server-side by api/styles/upload-image.js using
-- the service-role key, which bypasses the need for a client-facing INSERT
-- policy on storage.objects entirely.
insert into storage.buckets (id, name, public)
values ('style-images', 'style-images', true)
on conflict (id) do nothing;
