-- Up Migration
-- SMS channel registration on app.notify_templates and the SMS receipt id on app.notify_logs
-- (08 BR-TEXT-20 细则「短信渠道登记与后台渠道开关」; 规划/04 §3 notify_templates SMS columns and the
-- notify_logs SMS receipt id, the Aliyun BizId). Task B1-12x (orchestrator ruling D10-316 ①, task
-- supplement B), plus the registration awaiting its test send on the same row (orchestrator rulings
-- D10-337 ① / D10-339 ⑤, 规划/04 §3 2026-10-24, task supplement E).
-- Compatibility: additive. Ten new nullable columns without defaults on notify_templates
-- (sms_sign_name, sms_template_code, sms_template_type, sms_preview_text, sms_pending_sign_name,
-- sms_pending_template_code, sms_pending_template_type, sms_pending_preview_text, sms_test_status,
-- sms_tested_at) and one on notify_logs (sms_biz_id); existing rows read NULL in all of them,
-- which every new CHECK accepts. Nothing is backfilled; existing columns (channels stays the
-- admin's channel switch), CHECKs, primary keys, the unique key (app_id, dedupe_key), indexes and
-- grants are unchanged. No credential column:
-- the Aliyun AccessKey never enters the admin or the database.
-- Recovery: restore from backup; no down migration. (Narrowing back would be a new migration that,
-- after the application stops reading and writing these columns, drops the new CHECKs and columns.)
--
-- Shape after this migration:
--   notify_templates, one SMS registration per (app_id, code, variant):
--     sms_sign_name      SMS signature.
--     sms_template_code  Aliyun template CODE.
--     sms_template_type  'verify' (验证码) or 'notice' (通知) (notify_templates_sms_template_type_check).
--     sms_preview_text   preview of the message body as registered with Aliyun.
--     The four are all NULL (not registered) or all set (notify_templates_sms_registration_check);
--     sign name, template CODE and preview text, when set, contain at least one non-whitespace
--     character, with the same whitespace set as title_override / body_override in 0047
--     (notify_templates_sms_sign_name_check, notify_templates_sms_template_code_check,
--     notify_templates_sms_preview_text_check).
--   notify_templates, the registration awaiting its test send on the same row, independent of the
--   four in-use columns above (either, both or neither may be set):
--     sms_pending_sign_name      pending SMS signature.
--     sms_pending_template_code  pending Aliyun template CODE.
--     sms_pending_template_type  'verify' or 'notice' (notify_templates_sms_pending_template_type_check).
--     sms_pending_preview_text   pending preview of the message body.
--     sms_test_status            outcome of the test send: 'accepted', 'failed' or
--                                'not_sent_no_verify_phone' (notify_templates_sms_test_status_check).
--     sms_tested_at              when the test send was attempted.
--     The six are all NULL (nothing pending) or all set (notify_templates_sms_pending_check); the
--     three pending text columns, when set, contain at least one non-whitespace character with the
--     same whitespace set (notify_templates_sms_pending_sign_name_check,
--     notify_templates_sms_pending_template_code_check,
--     notify_templates_sms_pending_preview_text_check).
--   notify_logs:
--     sms_biz_id  NULL, or the Aliyun BizId stored verbatim: not the empty string, and only on
--                 rows with channel = 'sms' (notify_logs_sms_biz_id_check).
--
-- Grants: couli_app already holds table-level SELECT / INSERT / UPDATE on both tables and
-- couli_readonly SELECT (0042); table-level privileges cover the new columns, so no GRANT here.
--
-- Timeouts: ADD COLUMN (nullable, no default) is a catalog-only change; ADD CONSTRAINT takes
-- ACCESS EXCLUSIVE on the table, held to commit (the runner uses one transaction), and each
-- validated ADD CONSTRAINT scans the table once. 5s lock wait so a blocked deploy fails fast
-- instead of queueing notification traffic behind it; 30s overall as a ceiling for the scans.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.notify_templates ADD COLUMN sms_sign_name text;

ALTER TABLE app.notify_templates ADD COLUMN sms_template_code text;

ALTER TABLE app.notify_templates ADD COLUMN sms_template_type text;

ALTER TABLE app.notify_templates ADD COLUMN sms_preview_text text;

ALTER TABLE app.notify_templates ADD COLUMN sms_pending_sign_name text;

ALTER TABLE app.notify_templates ADD COLUMN sms_pending_template_code text;

ALTER TABLE app.notify_templates ADD COLUMN sms_pending_template_type text;

ALTER TABLE app.notify_templates ADD COLUMN sms_pending_preview_text text;

ALTER TABLE app.notify_templates ADD COLUMN sms_test_status text;

ALTER TABLE app.notify_templates ADD COLUMN sms_tested_at timestamptz;

ALTER TABLE app.notify_logs ADD COLUMN sms_biz_id text;

-- app.notify_templates and app.notify_logs are not funds or attribution tables. The runner applies
-- migrations in one transaction, so NOT VALID + VALIDATE would still scan under the ACCESS
-- EXCLUSIVE lock taken by ADD and gain nothing; as in 0044 / 0049 / 0069, plain validated ADDs are
-- used. The columns are new and NULL on every existing row, so every CHECK below holds for them.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_templates ADD CONSTRAINT notify_templates_sms_template_type_check
  CHECK (sms_template_type IS NULL OR sms_template_type IN ('verify', 'notice'));

-- Same reason as above: one transaction, validated ADD. All four NULL or none.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_templates ADD CONSTRAINT notify_templates_sms_registration_check CHECK (
  (
    sms_sign_name IS NULL
    AND sms_template_code IS NULL
    AND sms_template_type IS NULL
    AND sms_preview_text IS NULL
  )
  OR (
    sms_sign_name IS NOT NULL
    AND sms_template_code IS NOT NULL
    AND sms_template_type IS NOT NULL
    AND sms_preview_text IS NOT NULL
  )
);

-- Same reason as above: one transaction, validated ADD.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_templates ADD CONSTRAINT notify_templates_sms_sign_name_check
  CHECK (
    sms_sign_name IS NULL
    OR sms_sign_name ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
  );

-- Same reason as above: one transaction, validated ADD.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_templates ADD CONSTRAINT notify_templates_sms_template_code_check
  CHECK (
    sms_template_code IS NULL
    OR sms_template_code ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
  );

-- Same reason as above: one transaction, validated ADD.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_templates ADD CONSTRAINT notify_templates_sms_preview_text_check
  CHECK (
    sms_preview_text IS NULL
    OR sms_preview_text ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
  );

-- Same reason as above: one transaction, validated ADD.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_templates ADD CONSTRAINT notify_templates_sms_pending_template_type_check
  CHECK (sms_pending_template_type IS NULL OR sms_pending_template_type IN ('verify', 'notice'));

-- Same reason as above: one transaction, validated ADD.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_templates ADD CONSTRAINT notify_templates_sms_test_status_check
  CHECK (
    sms_test_status IS NULL
    OR sms_test_status IN ('accepted', 'failed', 'not_sent_no_verify_phone')
  );

-- Same reason as above: one transaction, validated ADD. All six pending columns NULL or none;
-- independent of notify_templates_sms_registration_check.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_templates ADD CONSTRAINT notify_templates_sms_pending_check CHECK (
  (
    sms_pending_sign_name IS NULL
    AND sms_pending_template_code IS NULL
    AND sms_pending_template_type IS NULL
    AND sms_pending_preview_text IS NULL
    AND sms_test_status IS NULL
    AND sms_tested_at IS NULL
  )
  OR (
    sms_pending_sign_name IS NOT NULL
    AND sms_pending_template_code IS NOT NULL
    AND sms_pending_template_type IS NOT NULL
    AND sms_pending_preview_text IS NOT NULL
    AND sms_test_status IS NOT NULL
    AND sms_tested_at IS NOT NULL
  )
);

-- Same reason as above: one transaction, validated ADD.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_templates ADD CONSTRAINT notify_templates_sms_pending_sign_name_check
  CHECK (
    sms_pending_sign_name IS NULL
    OR sms_pending_sign_name ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
  );

-- Same reason as above: one transaction, validated ADD.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_templates ADD CONSTRAINT notify_templates_sms_pending_template_code_check
  CHECK (
    sms_pending_template_code IS NULL
    OR sms_pending_template_code ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
  );

-- Same reason as above: one transaction, validated ADD.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_templates ADD CONSTRAINT notify_templates_sms_pending_preview_text_check
  CHECK (
    sms_pending_preview_text IS NULL
    OR sms_pending_preview_text ~ '[^[:space:]\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
  );

-- Same reason as above: one transaction, validated ADD. channel is NOT NULL.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_logs ADD CONSTRAINT notify_logs_sms_biz_id_check
  CHECK (sms_biz_id IS NULL OR (sms_biz_id <> '' AND channel = 'sms'));
