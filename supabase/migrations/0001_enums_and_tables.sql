-- AOBA PMOS — core schema (enums + tables)
-- Run against a fresh Supabase project's SQL editor, or via `supabase db push`.

-- ── ENUMS ────────────────────────────────────────────────────────────────
create type user_status      as enum ('active','inactive');
create type perm_level       as enum ('edit','view','none');
create type style_status     as enum ('active','inactive');
create type listing_type     as enum ('master','relisting');
create type listing_status   as enum ('draft','pending','live');
create type ean_status       as enum ('unassigned','assigned','printed');
create type marketplace_enum as enum ('Myntra','Nykaa','Amazon','Ajio','Flipkart');
create type import_type      as enum ('styles','listings','ean');
create type import_status    as enum ('success','failed','partial');
create type audit_action     as enum ('create','update','delete','login','export','permission','import','assign');
create type invite_status    as enum ('pending','revoked','accepted');

create type app_role as enum (
  'Founder','Admin','Merchandising','Catalog Team',
  'Marketplace Team','Designer','Accounts','Warehouse'
);

create type app_module as enum (
  'Dashboard','Styles','Listings','EAN / Barcode','Reports','Search',
  'Audit Trail','AI Copilot','Import','User Management',
  'Roles & Permissions','Settings','Guide'
);

-- ── PROFILES (1:1 with auth.users) ──────────────────────────────────────
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null,
  email       text not null unique,
  role        app_role not null,
  status      user_status not null default 'active',
  two_fa      boolean not null default false,
  last_active timestamptz,
  added_at    date not null default current_date
);
create index idx_profiles_role on profiles(role);
create index idx_profiles_status on profiles(status);

-- ── ROLE PERMISSIONS (roles are fixed; this matrix is editable) ────────
create table role_permissions (
  role   app_role   not null,
  module app_module not null,
  level  perm_level not null default 'none',
  primary key (role, module)
);

-- ── CATEGORIES (fixed lookup, seeded in 0002, not user-editable) ───────
create table categories (
  code         text primary key,
  name         text not null,
  group_number int  -- null = standalone category (own SKU counter)
);

-- ── STYLE NUMBER COUNTERS — backs the SKU Engine (RPC added in 0004) ───
-- One row per group (1-5) and one per standalone category code.
create table style_number_counters (
  counter_key text primary key,  -- 'group:1' .. 'group:5', or 'cat:AILS' etc for standalone
  next_number int not null default 1
);

-- ── STYLES ───────────────────────────────────────────────────────────────
create table styles (
  code        text primary key,       -- e.g. 'AILW-1', server-generated (Phase B)
  name        text not null,
  category    text not null references categories(code),
  status      style_status not null default 'active',
  colors      text[] not null default '{}',
  sizes       text[] not null default '{}',
  sku_count   int generated always as (
                coalesce(array_length(colors,1),0) * coalesce(array_length(sizes,1),0)
              ) stored,
  mrp         numeric(10,2),
  cost_price  numeric(10,2),
  hsn_code    text,
  description text,
  images      text[] not null default '{}',  -- up to 4 Supabase Storage public URLs
  added_at    date not null default current_date,
  created_by  uuid references profiles(id),
  updated_at  timestamptz not null default now()
);
create index idx_styles_category on styles(category);
create index idx_styles_status on styles(status);

-- ── LISTINGS ─────────────────────────────────────────────────────────────
create table listings (
  id              uuid primary key default gen_random_uuid(),
  sku             text not null,           -- AOBA SKU e.g. AILW-1A/M
  style_code      text not null references styles(code),
  marketplace     marketplace_enum not null,
  marketplace_sku text,
  type            listing_type not null default 'master',
  status          listing_status not null default 'draft',
  mrp             numeric(10,2),
  listing_url     text,
  launch_date     date,
  ean             text,
  ean_status      ean_status not null default 'unassigned',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (sku, marketplace)
);
create index idx_listings_style on listings(style_code);
create index idx_listings_marketplace on listings(marketplace);
create index idx_listings_status on listings(status);
create index idx_listings_ean_status on listings(ean_status);

-- ── IMPORT HISTORY ───────────────────────────────────────────────────────
create table import_history (
  id          uuid primary key default gen_random_uuid(),
  date        date not null default current_date,
  type        import_type not null,
  filename    text not null,
  row_count   int not null default 0,
  status      import_status not null default 'success',
  imported_by uuid references profiles(id),
  raw_csv     text,   -- stored for re-download
  created_at  timestamptz not null default now()
);

-- ── AUDIT LOG (append-only; written only as a side effect of mutating
-- endpoints — there is intentionally no client-callable "log this" route) ─
create table audit_log (
  id         bigint generated always as identity primary key,
  ts         timestamptz not null default now(),
  actor      uuid references profiles(id),
  actor_name text not null,   -- denormalized snapshot in case the profile is later deleted
  role       app_role,
  action     audit_action not null,
  entity     text not null,   -- 'Style','Listing','User','EAN','Catalog','Permissions', etc.
  detail     text not null
);
create index idx_audit_ts on audit_log(ts desc);
create index idx_audit_actor on audit_log(actor);

-- ── INVITES ──────────────────────────────────────────────────────────────
create table invites (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  role       app_role not null,
  invited_by uuid references profiles(id),
  invited_at timestamptz not null default now(),
  status     invite_status not null default 'pending'
);
create unique index idx_invites_pending_email on invites(email) where status = 'pending';

-- ── ACCESS MODEL ─────────────────────────────────────────────────────────
-- All application access goes through the /api/* serverless functions using the
-- service-role key (which bypasses RLS by design). The Edit/View/None-per-module
-- permission matrix is keyed by (role, module), not row ownership, so it does not
-- map cleanly onto Postgres RLS policies — enforcement lives in api/_lib/auth.js
-- instead. To make sure nobody can bypass that by hitting PostgREST directly with
-- their own JWT, explicitly revoke the default grants Supabase adds to new tables:
revoke all on profiles, role_permissions, categories, style_number_counters,
  styles, listings, import_history, audit_log, invites
  from anon, authenticated;
