-- AOBA PMOS — decouple EAN from Listings: EAN is a property of a SKU (one
-- specific style+color+size combination), not of a marketplace listing. The
-- old model required a Listing to exist before an EAN could be assigned,
-- but Listings model "this SKU is live on Marketplace X" — a separate,
-- optional, later step. In practice Listings were never created for most of
-- the catalog, so EAN assignment silently had nothing to attach to.
--
-- listings.ean / listings.ean_status are left in place (unused going
-- forward, not dropped) rather than deleted outright, so no historical data
-- is destroyed by this migration.

create table skus (
  sku         text primary key,             -- e.g. 'AILW-1A/M' = style_code + color + '/' + size
  style_code  text not null references styles(code) on delete cascade,
  color       text not null,
  size        text not null,
  ean         text,
  ean_status  ean_status not null default 'unassigned',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (style_code, color, size)
);
create index idx_skus_style on skus(style_code);
create index idx_skus_ean_status on skus(ean_status);

revoke all on skus from anon, authenticated;

-- Backfill one SKU row per existing style x color x size combination.
insert into skus (sku, style_code, color, size)
select s.code || c || '/' || sz, s.code, c, sz
from styles s,
     unnest(s.colors) as c,
     unnest(s.sizes) as sz
on conflict (sku) do nothing;

-- Carry over any EAN that was already recorded on a listing (belt and
-- braces — this database has none, but a fresh environment restoring older
-- data might).
update skus k set
  ean = l.ean,
  ean_status = l.ean_status
from listings l
where l.sku = k.sku and l.ean is not null;
