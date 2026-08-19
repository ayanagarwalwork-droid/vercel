-- AOBA PMOS — Costing: a bill-of-materials cost breakdown per style
-- (Fabric, Cups, Buckle, Stitching, etc. — item x consumption x rate =
-- amount), rolling up to SKU Cost + Overhead% = Total Cost. Modeled after
-- the team's existing per-style Excel costing sheets.
--
-- Total Cost is NOT wired into styles.cost_price yet — that's a deliberate
-- open question (does the computed Total Cost replace the manually-entered
-- Cost Price, or stay separate?) to revisit later, not an oversight.

create table style_costing_items (
  id          uuid primary key default gen_random_uuid(),
  style_code  text not null references styles(code) on delete cascade,
  item        text not null,
  consumption numeric not null default 0,
  rate        numeric not null default 0,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index idx_costing_items_style on style_costing_items(style_code);

revoke all on style_costing_items from anon, authenticated;

-- Overhead % is per-style (editable), defaulting to 15% to match the
-- existing costing sheets. Existing rows get the same default.
alter table styles add column overhead_pct numeric not null default 15;

-- Seed permissions for the new module — conservative default (none),
-- Founder/Admin get edit. Grant more roles from Roles & Permissions in-app.
insert into role_permissions (role, module, level)
select r.role, 'Costing'::app_module, 'none'::perm_level
from unnest(enum_range(null::app_role)) as r(role)
on conflict (role, module) do nothing;

update role_permissions set level = 'edit'
  where module = 'Costing' and role in ('Founder','Admin');
