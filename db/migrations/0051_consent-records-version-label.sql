-- Up Migration
-- consent_records.version_label: the string version of a clipboard_auto_import record (the purpose
-- consent for clipboard auto-recognition, BR-ID-12 细则, BR-ID-16: version is the string
-- config.clipboard.consent_version). Task B1-02zc (orchestrator ruling E33: the integer column
-- version is not changed; a clipboard row stores 0 there and its string in version_label).
-- Pairing rule (consent_records_version_label_check):
--   type = clipboard_auto_import ⇒ subject_type = device, version_label not null, version = 0;
--   any other type ⇒ version_label is null.
-- Compatibility: expand only. The new column is nullable without a default, so existing integer
-- writers that leave it out keep working; no existing row is a clipboard_auto_import row (the
-- endpoint refused that type until this task), so every existing row satisfies the new CHECK.
-- Grants: consent_records is granted at table level (SELECT, INSERT to couli_app, SELECT to
-- couli_readonly, from the migration that created it), which covers a new column; the table stays
-- insert-only, so no UPDATE / DELETE is granted here.
-- Recovery: restore from backup; no down migration. (Dropping the CHECK and then the column would
-- first need every clipboard_auto_import row removed.)
--
-- Timeouts: ADD COLUMN and ADD CONSTRAINT take an ACCESS EXCLUSIVE lock on consent_records; 5s lock
-- wait so a blocked deploy fails fast instead of queueing consent writes behind it, 60s overall as
-- a ceiling for the CHECK scan of a small table.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.consent_records ADD COLUMN version_label text;

-- Every existing row has version_label null and a type other than clipboard_auto_import, so it
-- satisfies the CHECK; the table holds no real rows before launch and the scan runs inside the
-- ACCESS EXCLUSIVE lock taken just above, so NOT VALID + VALIDATE would gain nothing.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.consent_records ADD CONSTRAINT consent_records_version_label_check
  CHECK (
    (
      type = 'clipboard_auto_import'
      AND subject_type = 'device'
      AND version_label IS NOT NULL
      AND version = 0
    )
    OR (type <> 'clipboard_auto_import' AND version_label IS NULL)
  );
