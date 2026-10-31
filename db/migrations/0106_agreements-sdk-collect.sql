-- Up Migration
-- Agreement types sdk_list and collect_list (规划/04 §3.2 agreements, D10-465 / D10-478: type takes
-- privacy / agreement / labor_agreement / sdk_list / collect_list; the two new types do not take
-- part in consent, are not shown at first launch and never require re-signing). Names follow the
-- orchestrator ruling in the F1-02zzr brief §9.2: only agreements_type_check changes, rebuilt
-- under the same name (case-sensitive, no trimming). Task F1-02zzr.
-- Compatibility: widening only. The allowed set grows from three values to five; every existing
-- row holds one of the original three values, so it satisfies the new check. All other checks
-- (version, min_version, requires_resign, text_sha256, url, legal_confirm), the unique key
-- (app_id, type, version), foreign keys and grants are unchanged. agreements_requires_resign_check
-- already sends every type other than labor_agreement to requires_resign = false, which covers
-- the two new types. "min_version always equals version" for them is enforced by the application
-- publish check (F1-02zzs), not by a database constraint.
-- Recovery: no down migration. To roll back, first delete any sdk_list / collect_list rows, then
-- a new migration drops agreements_type_check and re-adds it with the original three values.
--
-- Timeouts: DROP / ADD CONSTRAINT take ACCESS EXCLUSIVE on app.agreements, held to commit since
-- the runner uses one transaction. 5s lock wait so a blocked deploy fails fast instead of queueing
-- agreement reads behind it; 30s overall as a ceiling for the CHECK scan of a small table.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.agreements DROP CONSTRAINT agreements_type_check;

-- app.agreements is not a funds or attribution table. The runner applies migrations in one
-- transaction, so NOT VALID + VALIDATE would still scan under the ACCESS EXCLUSIVE lock taken by
-- DROP / ADD and gain nothing; the table is small (a few published versions per type), so a plain
-- validated ADD is used, as in 0061.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.agreements ADD CONSTRAINT agreements_type_check
  CHECK (type IN ('privacy', 'agreement', 'labor_agreement', 'sdk_list', 'collect_list'));
