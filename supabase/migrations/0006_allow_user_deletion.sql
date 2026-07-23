-- AOBA PMOS — allow deleting a user without being blocked by their history.
-- Deleting a profiles row currently fails with a foreign-key violation if
-- that user ever created a style, sent an invite, ran an import, or has any
-- audit_log entry (any of which is true for almost any active user). Those
-- historical records should survive the user being removed -- the
-- reference should just become null, not block the deletion. audit_log in
-- particular already denormalizes actor_name specifically so entries stay
-- readable after the profile is gone; this migration makes the foreign key
-- actually behave that way.
alter table styles
  drop constraint if exists styles_created_by_fkey,
  add constraint styles_created_by_fkey
    foreign key (created_by) references profiles(id) on delete set null;

alter table import_history
  drop constraint if exists import_history_imported_by_fkey,
  add constraint import_history_imported_by_fkey
    foreign key (imported_by) references profiles(id) on delete set null;

alter table audit_log
  drop constraint if exists audit_log_actor_fkey,
  add constraint audit_log_actor_fkey
    foreign key (actor) references profiles(id) on delete set null;

alter table invites
  drop constraint if exists invites_invited_by_fkey,
  add constraint invites_invited_by_fkey
    foreign key (invited_by) references profiles(id) on delete set null;
