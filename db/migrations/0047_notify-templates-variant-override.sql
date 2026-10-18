-- Up Migration
-- Template variants and editable wording overrides on app.notify_templates (08 BR-TEXT-23 细则
-- 「模板有变体」). Task B1-12f (orchestrator ruling B1–B5 in the task brief).
-- Compatibility: additive for writers. Three new columns: variant (NOT NULL with a constant
-- default, so inserts that omit it keep working and every existing row becomes variant
-- 'default'), title_override and body_override (nullable, no default). The primary key widens from
-- (app_id, code) to (app_id, code, variant); every existing row stays unique under it. Existing
-- columns, CHECKs, defaults and grants of 0042 are unchanged; notify_logs and inbox_messages are
-- untouched.
-- Recovery: restore from backup; no down migration. (Narrowing the key back would first need all
-- but one variant per (app_id, code) removed.)
--
-- variant         lowercase snake case (e.g. default, frozen, frozen_until, unfrozen, banned,
--                 unbanned); an open set, the code that renders a template picks the variant.
-- title_override  optional wording that replaces the packaged default title; the default copy
-- body_override   stays in code, these columns only carry the admin's rewording. NULL means
--                 "use the packaged default"; a non-NULL value must contain at least one
--                 non-whitespace character (ASCII whitespace plus the Unicode space separators,
--                 NEL, line / paragraph separators, ideographic space U+3000 and BOM).
--
-- Grants: none needed. 0042 grants couli_app table-level SELECT / INSERT / UPDATE and
-- couli_readonly table-level SELECT, which cover the new columns; still no DELETE.
--
-- Validation without NOT VALID: the table holds no real rows before launch, existing rows get
-- variant 'default' (passes the CHECK) and NULL overrides (pass their CHECKs), and the scans run
-- inside the ACCESS EXCLUSIVE lock this migration already holds for ADD COLUMN.
--
-- Timeouts: ALTER TABLE takes an ACCESS EXCLUSIVE lock on notify_templates; 5s lock wait so a
-- blocked deploy fails fast instead of queueing notification writers behind it, 60s overall as a
-- ceiling for the CHECK scans and the primary-key index build on a small table.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.notify_templates ADD COLUMN variant text NOT NULL DEFAULT 'default';

ALTER TABLE app.notify_templates ADD COLUMN title_override text;

ALTER TABLE app.notify_templates ADD COLUMN body_override text;

-- Existing rows all carry the constant default 'default' and there are no real rows before
-- launch: validating immediately is instant.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_templates ADD CONSTRAINT notify_templates_variant_check
  CHECK (variant ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$');

-- New column, NULL on every existing row: validating immediately is instant.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_templates ADD CONSTRAINT notify_templates_title_override_check
  CHECK (
    title_override IS NULL
    OR title_override ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
  );

-- New column, NULL on every existing row: validating immediately is instant.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_templates ADD CONSTRAINT notify_templates_body_override_check
  CHECK (
    body_override IS NULL
    OR body_override ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
  );

-- Widen the primary key, keeping its name. Nothing references notify_templates by foreign key
-- (notify_logs.code deliberately has none), so dropping the old key breaks no dependency. The new
-- key is built as a unique index first and then attached with USING INDEX (the index takes the
-- freed name notify_templates_pkey, which the constraint keeps); all three columns are NOT NULL.
ALTER TABLE app.notify_templates DROP CONSTRAINT notify_templates_pkey;

CREATE UNIQUE INDEX notify_templates_pkey ON app.notify_templates (app_id, code, variant);

ALTER TABLE app.notify_templates ADD CONSTRAINT notify_templates_pkey
  PRIMARY KEY USING INDEX notify_templates_pkey;
