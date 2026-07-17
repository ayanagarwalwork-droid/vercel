-- AOBA PMOS — seed the role/permission matrix.
-- Exact defaults read directly from prototype-3.html's ROLES array
-- (perms = has any access, editPerms = subset with edit rights;
--  view-only = perms minus editPerms).

-- Step 1: every (role, module) combination defaults to 'none' so the
-- Roles & Permissions UI always has a guaranteed row per cell.
insert into role_permissions (role, module, level)
select r.role, m.module, 'none'::perm_level
from unnest(enum_range(null::app_role))   as r(role)
cross join unnest(enum_range(null::app_module)) as m(module);

-- Step 2: override with the exact prototype defaults.

-- Founder — edit everything
update role_permissions set level = 'edit' where role = 'Founder';

-- Admin — edit everything except Guide (view-only there, even for Admin)
update role_permissions set level = 'edit' where role = 'Admin' and module <> 'Guide';
update role_permissions set level = 'view' where role = 'Admin' and module = 'Guide';

-- Merchandising
update role_permissions set level = 'edit'
  where role = 'Merchandising' and module in ('Styles','Listings');
update role_permissions set level = 'view'
  where role = 'Merchandising' and module in ('Dashboard','Reports','Search','AI Copilot');

-- Catalog Team
update role_permissions set level = 'edit'
  where role = 'Catalog Team' and module in ('Styles','Listings','EAN / Barcode','Import');
update role_permissions set level = 'view'
  where role = 'Catalog Team' and module in ('Dashboard','Search');

-- Marketplace Team
update role_permissions set level = 'edit'
  where role = 'Marketplace Team' and module = 'Listings';
update role_permissions set level = 'view'
  where role = 'Marketplace Team' and module in ('Dashboard','Reports','Search');

-- Designer
update role_permissions set level = 'edit'
  where role = 'Designer' and module = 'Styles';
update role_permissions set level = 'view'
  where role = 'Designer' and module in ('Dashboard','Listings','Search');

-- Accounts — view only, nowhere to edit
update role_permissions set level = 'view'
  where role = 'Accounts' and module in ('Dashboard','Reports','Audit Trail');

-- Warehouse
update role_permissions set level = 'edit'
  where role = 'Warehouse' and module in ('Listings','Import');
update role_permissions set level = 'view'
  where role = 'Warehouse' and module = 'Dashboard';
