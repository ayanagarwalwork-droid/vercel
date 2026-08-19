-- AOBA PMOS — add the "Costing" module (standalone sidebar page).
-- Run this on its own, then commit, before running 0011 — Postgres doesn't
-- allow a new enum value to be used in the same transaction that adds it.
alter type app_module add value 'Costing';
