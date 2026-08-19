-- AOBA PMOS — add a distinct import_history type for the combined
-- Style + Image + EAN import (kept separate from 'styles' so Import
-- History accurately reflects which workflow was used). Run this on its
-- own, then commit, before it's used anywhere — Postgres doesn't allow a
-- new enum value to be used in the same transaction that adds it.
alter type import_type add value 'style_ean';
