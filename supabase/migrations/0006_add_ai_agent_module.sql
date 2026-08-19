-- AOBA PMOS — add the "AI Agent" module (separate from AI Copilot).
-- Run this on its own, then commit, before running 0007 — Postgres doesn't
-- allow a new enum value to be used in the same transaction that adds it.
alter type app_module add value 'AI Agent';
