-- Up Migration
-- Notification templates app.notify_templates and send log app.notify_logs (规划/04 §3.2 表行;
-- BR-WATCH-19 ③ 分类; ADR-0001 §4). Task B1-12e (orchestrator rulings B1–B4 in the task brief).
-- Compatibility: additive (two new tables, their constraints, indexes and grants; nothing existing
-- changes, app.users is only referenced, app.inbox_messages is untouched).
-- Recovery: restore from backup; no down migration.
--
-- Writer: notification owns both tables.
--
-- app.notify_templates, one row per (app_id, code):
--   code       uppercase snake case (e.g. ORDER_CREDITED, UNION_AUTH_EXPIRING).
--   category   service / subscription / marketing (BR-WATCH-19 ③; per-category opt-out).
--   channels   nonempty text[] of inbox / push / sms, no NULL elements (04 「渠道」).
--   route      optional JSON object {route, params} (TECH-04); only written into inbox
--              messages, never into push payloads. No title / body columns (04 has none).
--
-- app.notify_logs, one row per planned delivery:
--   id         uuid primary key, UUIDv7 supplied by the application.
--   user_id    nullable: site-owner alert SMS (UNION_AUTH_*) has no user (04, BR-ID-24);
--              when present it references app.users (app_id, id), no cascade.
--   code       no FK to notify_templates: system codes need no template row.
--   channel    inbox / push / sms.
--   dedupe_key nonempty; unique per app (04: unique (app_id, dedupe_key), e.g.
--              `withdrawal_id:OVERDUE`, BR-WDR-26). Consumers insert-and-catch-23505 so
--              at-least-once delivery persists one log per key.
--   planned_at application Clock; quiet-hours deferral moves it (04).
--   sent_at    application Clock; required for success, forbidden while queued, either for
--              failed. No SQL default on id / planned_at / sent_at.
--   status     queued (default) / success / failed.
--   Indexes: (status, planned_at) for the due-send scan; (app_id, user_id, created_at) for
--   per-user lookup and the BR-ID-30 retention purge.
--
-- CAS (ADR-0001 §4.1): row_version starts at 0; writers compare and increment it in the same
-- UPDATE. Grants: couli_app SELECT / INSERT / table-level UPDATE on both tables (constraint
-- violations, not permission errors, guard the shape); no DELETE — retention deletion is a
-- later task. couli_readonly SELECT only.
--
-- Timeouts: two new empty tables; CREATE TABLE / INDEX are instant, but the foreign key takes
-- SHARE ROW EXCLUSIVE on app.users. 5s lock wait so a blocked deploy fails fast instead of queueing
-- traffic behind it, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.notify_templates (
  app_id       text NOT NULL,
  code         text NOT NULL,
  category     text NOT NULL,
  channels     text[] NOT NULL,
  route        jsonb,
  row_version  integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notify_templates_pkey PRIMARY KEY (app_id, code),
  CONSTRAINT notify_templates_code_check CHECK (code ~ '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$'),
  CONSTRAINT notify_templates_category_check
    CHECK (category IN ('service', 'subscription', 'marketing')),
  CONSTRAINT notify_templates_channels_check CHECK (
    cardinality(channels) >= 1
    AND array_position(channels, NULL) IS NULL
    AND channels <@ ARRAY['inbox', 'push', 'sms']::text[]
  ),
  CONSTRAINT notify_templates_route_check
    CHECK (route IS NULL OR jsonb_typeof(route) = 'object')
);

CREATE TABLE app.notify_logs (
  id           uuid NOT NULL,
  app_id       text NOT NULL,
  user_id      uuid,
  code         text NOT NULL,
  channel      text NOT NULL,
  dedupe_key   text NOT NULL,
  planned_at   timestamptz NOT NULL,
  sent_at      timestamptz,
  status       text NOT NULL DEFAULT 'queued',
  row_version  integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notify_logs_pkey PRIMARY KEY (id),
  CONSTRAINT notify_logs_dedupe_key UNIQUE (app_id, dedupe_key),
  CONSTRAINT notify_logs_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT notify_logs_channel_check CHECK (channel IN ('inbox', 'push', 'sms')),
  CONSTRAINT notify_logs_status_check CHECK (status IN ('queued', 'success', 'failed')),
  CONSTRAINT notify_logs_dedupe_key_check CHECK (dedupe_key <> ''),
  CONSTRAINT notify_logs_sent_at_check CHECK (
    (status <> 'success' OR sent_at IS NOT NULL)
    AND (status <> 'queued' OR sent_at IS NULL)
  )
);

CREATE INDEX notify_logs_due_idx ON app.notify_logs (status, planned_at);

CREATE INDEX notify_logs_user_created_idx ON app.notify_logs (app_id, user_id, created_at);

GRANT SELECT, INSERT, UPDATE ON app.notify_templates, app.notify_logs TO couli_app;
GRANT SELECT ON app.notify_templates, app.notify_logs TO couli_readonly;
