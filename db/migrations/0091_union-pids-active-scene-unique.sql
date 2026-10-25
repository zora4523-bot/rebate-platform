-- Up Migration
-- At most one active PID per app × platform × union account × pid_scene (08 BR-ATTR-02 正文 and
-- 细则「后台登记与启停」, 规划/04 §3.2 union_pids; orchestrator rulings D10-221 A as amended by
-- D10-231). Task B1-22i. Different union accounts may each keep one active PID in the same scene
-- (B1-19d: reads pick the PID by the bound account; activation across accounts only warns).
-- The union pid service (setPidStatus) and the command line refuse a second active PID of the same
-- account and scene first (UnionPidError 'conflict'); this index is the last line against races.
-- Compatibility: additive, one new partial unique index on app.union_pids:
--   union_pids_active_account_scene_key  UNIQUE (app_id, platform, union_account_id, pid_scene)
--     WHERE status = 'active'. pending and retired rows are not limited.
-- Existing data: before the index is built the migration looks for groups that already break the
-- rule (two or more active rows with the same key). If there are any it fails with RAISE EXCEPTION
-- listing every app_id / platform / union_account_id / pid_scene with its row count, and changes
-- nothing: an operator retires the surplus rows through the union pid service (audited) and runs
-- the migration again. Data is never retired or rewritten here.
-- Guard: union_pids is an attribution table (prefix union_ in tools/ci/lint-migrations.ts), so the
-- index is named and no squawk exception is used. A new index is not a guard rebuild, so the file
-- needs no APPROVED_GUARD_CHANGES entry. require-concurrent-index-creation is excluded globally in
-- .squawk.toml (the runner applies migrations in one transaction).
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration. (Dropping the index would be a new migration
-- and, union_pids being an attribution table, a guard change needing approval.)
--
-- Timeouts: LOCK TABLE takes SHARE (the lock CREATE INDEX takes anyway) so no row can become
-- active between the duplicate check and the index build; union_pids holds a few rows per app and
-- platform, so the scan and the build are instant. 5s lock wait so a blocked deploy fails fast
-- instead of queueing PID writes behind it, 60s overall as a ceiling for the scan and the build.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE app.union_pids IN SHARE MODE;

DO $$
DECLARE
  duplicates text;
BEGIN
  SELECT string_agg(
           format('app_id=%s platform=%s union_account_id=%s pid_scene=%s rows=%s',
                  g.app_id, g.platform, g.union_account_id, g.pid_scene, g.n),
           '; ' ORDER BY g.app_id, g.platform, g.union_account_id, g.pid_scene)
    INTO duplicates
    FROM (
      SELECT app_id, platform, union_account_id, pid_scene, count(*) AS n
        FROM app.union_pids
       WHERE status = 'active'
       GROUP BY app_id, platform, union_account_id, pid_scene
      HAVING count(*) > 1
    ) AS g;
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'app.union_pids has more than one active PID for the same app, platform, union account and scene: %', duplicates
      USING HINT = 'Retire the surplus rows through the union pid service, then run the migration again; this migration changes no data.';
  END IF;
END
$$;

CREATE UNIQUE INDEX union_pids_active_account_scene_key
  ON app.union_pids (app_id, platform, union_account_id, pid_scene)
  WHERE status = 'active';
