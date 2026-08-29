-- AOBA PMOS — relisting support: a listing can now exist up to 3 times for
-- the same SKU+marketplace (original + 2 relists), distinguished by a
-- Marketplace-SKU/barcode prefix. Rule given by the user 2026-08-25 (see
-- PROGRESS.md "Relisting prefix rule" and the matching memory file):
--   1st listing (master):    no prefix — relist_prefix = ''
--   2nd listing (1st relist): prefix M — relist_prefix = 'M'
--   3rd listing (2nd relist): prefix T — relist_prefix = 'T'
-- Capped at 3 for now; no rule exists yet for a 4th, so the check constraint
-- deliberately only allows these three values rather than any letter.
alter table listings add column relist_prefix text not null default '';
alter table listings add constraint listings_relist_prefix_check check (relist_prefix in ('', 'M', 'T'));

-- The old unique(sku, marketplace) made a second row for the same pair
-- physically impossible — that's exactly what a relisting needs to be.
-- Replace it with a 3-way key so each of the (at most) 3 variants per
-- SKU+marketplace stays unique, but all 3 can coexist.
alter table listings drop constraint listings_sku_marketplace_key;
alter table listings add constraint listings_sku_marketplace_prefix_key unique (sku, marketplace, relist_prefix);
