-- Cluster-wide roles (ADR-0001 §4.2 #8). Run once per environment by a superuser; idempotent.
-- No passwords here: each environment sets them outside the repository
-- (local: `pnpm db:bootstrap` with APP_ENV=local; tests: random per run).
--
--   couli_migrator  owns schemas and tables, runs migrations (CI / deploy only)
--   couli_app       api / stream / admin / worker processes
--   couli_payout    payout process
--   couli_readonly  read-only access (reports, troubleshooting)
--   couli_maint     only EXECUTE on partition maintenance functions, no DDL
DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    'couli_migrator', 'couli_app', 'couli_payout', 'couli_readonly', 'couli_maint'
  ]
  LOOP
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
        EXECUTE format(
          'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
          v_role
        );
      END IF;
    EXCEPTION
      WHEN duplicate_object THEN
        NULL; -- created concurrently by another bootstrap run
    END;
  END LOOP;
END
$$;
