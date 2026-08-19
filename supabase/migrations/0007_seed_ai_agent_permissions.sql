-- AOBA PMOS — seed permissions for the new "AI Agent" module.
-- Defaults to 'none' for every role except Founder/Admin, who get 'edit'
-- (edit = can also invoke the agent's whitelisted write actions; view would
-- be read-only chat once granted via Roles & Permissions). Deliberately
-- conservative since this module can call tools that mutate catalog data —
-- grant it to other roles explicitly from the Roles & Permissions page.

insert into role_permissions (role, module, level)
select r.role, 'AI Agent'::app_module, 'none'::perm_level
from unnest(enum_range(null::app_role)) as r(role)
on conflict (role, module) do nothing;

update role_permissions set level = 'edit'
  where module = 'AI Agent' and role in ('Founder','Admin');
