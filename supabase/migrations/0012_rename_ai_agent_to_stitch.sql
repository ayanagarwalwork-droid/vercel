-- AOBA PMOS — rename the "AI Agent" module to "Stitch" (the agent's chosen
-- name/brand). Renaming an existing enum value (as opposed to adding a new
-- one) updates every role_permissions row that references it in place — no
-- data migration needed.
alter type app_module rename value 'AI Agent' to 'Stitch';
