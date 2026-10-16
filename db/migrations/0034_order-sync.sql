-- Up Migration
-- Order sync and status history tables (规划/04 §3.2 sync_cursors, order_sync_pending,
-- order_sync_counters, order_sync_drops / order_sync_drop_keys, order_status_history; 规划/02 §7.1
-- 水位只在窗口各页处理完后推进). Task B1-08c; table shape follows the orchestrator ruling D10-16
-- in couli-runs/B1-08c brief (rulings 1-8).
-- Compatibility: additive. Six new ordinary (non-partitioned) tables in schema app, named
-- constraints / indexes, two append-only guard triggers and grants; no existing object changes.
-- Recovery: restore from backup; no down migration.
--
-- Common: every table has app_id text NOT NULL and a bigint identity primary key `id`; business
-- uniqueness is a separate named UNIQUE constraint. Business timestamps and dates (cursor_at,
-- updated_at, detected_at, resolved_at, at, date) come from the injected Clock and have no
-- database default; date is the +08:00 natural day computed by the application. Foreign keys are
-- named, carry app_id and never cascade.
--
-- sync_cursors: one row per independent sync stream, unique (app_id, platform, union_account_id,
--   query_kind, scene); scene is '-' for platforms that do not split by order_scene. The account
--   FK also binds platform (union_accounts (app_id, platform, id)). UPDATE advances cursor_at.
-- order_sync_pending: the 待处理表. reason is the nine 04 §3.2 categories in the upper-case style
--   of orders.hold_reason (until the contracts line registers codes; a mismatch gets a new
--   migration). status is the disposition ('open' / 'resolved' / 'dismissed') without default:
--   the application writes 'open'. order_id is nullable (first sighting may have no order row)
--   and references order_keys. raw_payload_id is a logical reference to the partitioned
--   app.union_raw_payloads and has no FK (db/AGENTS.md rule 7). The partial unique index on
--   (app_id, platform, sub_order_id, reason) WHERE status = 'open' keeps one unresolved case per
--   sub-order and reason; the writer refreshes detected_at instead of inserting again.
-- order_sync_counters: per-day pipeline counters, closed counter set, count >= 0, unique
--   (app_id, platform, date, counter); atomic increment by UPDATE.
-- order_sync_drops: per-day drop counts, reason is open non-empty text (NO_PAY_TIME and the
--   BR-ATTR-02 reasons), count >= 0, unique (app_id, platform, date, reason).
-- order_sync_drop_keys: dedup keys for drops, unique (app_id, platform, sub_order_id, reason),
--   insert-only.
-- order_status_history: insert-only audit of platform / rebate status transitions; from_status is
--   NULL for the initial state.
-- Retention: none here. Order tables are pre-created and not deleted (BR-ID-30 ⑰); drop_keys
-- retention (BR-ID-30) is left to a follow-up task.
--
-- Grants: couli_app SELECT, INSERT, UPDATE on sync_cursors, order_sync_pending,
-- order_sync_counters and order_sync_drops; SELECT, INSERT only on order_sync_drop_keys and
-- order_status_history (append-only, with app.reject_update_delete() triggers as a second line of
-- defence). No DELETE or TRUNCATE for anyone. couli_readonly SELECT on all six.
--
-- Timeouts: only new, empty tables are created; the FKs take short locks on app.union_accounts
-- and app.order_keys. 5s lock wait so a blocked deploy fails fast, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.sync_cursors (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  app_id           text NOT NULL,
  platform         text NOT NULL,
  union_account_id uuid NOT NULL,
  query_kind       text NOT NULL,
  scene            text NOT NULL,
  cursor_at        timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_cursors_pkey PRIMARY KEY (id),
  CONSTRAINT sync_cursors_stream_key
    UNIQUE (app_id, platform, union_account_id, query_kind, scene),
  CONSTRAINT sync_cursors_union_account_fkey FOREIGN KEY (app_id, platform, union_account_id)
    REFERENCES app.union_accounts (app_id, platform, id),
  CONSTRAINT sync_cursors_query_kind_check CHECK (query_kind <> ''),
  CONSTRAINT sync_cursors_scene_check CHECK (scene <> '')
);

CREATE TABLE app.order_sync_pending (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  app_id          text NOT NULL,
  platform        text NOT NULL,
  sub_order_id    text NOT NULL,
  order_id        uuid,
  reason          text NOT NULL,
  raw_status      text,
  raw_payload_id  bigint,
  detail          text,
  detected_at     timestamptz NOT NULL,
  status          text NOT NULL,
  resolved_by     uuid,
  resolved_at     timestamptz,
  resolution_note text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_sync_pending_pkey PRIMARY KEY (id),
  CONSTRAINT order_sync_pending_order_fkey FOREIGN KEY (app_id, order_id)
    REFERENCES app.order_keys (app_id, order_id),
  CONSTRAINT order_sync_pending_reason_check CHECK (reason IN (
    'UNMAPPED_STATUS', 'UNFREEZE_SIGNAL', 'ILLEGAL_TRANSITION', 'NO_RECEIVED_AT',
    'CLAWBACK_NO_COMMISSION', 'SERVICE_FEE_RATE_MISSING', 'RULE_VERSION_PLATFORM_MISSING',
    'TLJ_FACE_VALUE_UNMATCHED', 'AMOUNT_PARSE_FAILED'
  )),
  CONSTRAINT order_sync_pending_status_check CHECK (status IN ('open', 'resolved', 'dismissed'))
);

CREATE UNIQUE INDEX order_sync_pending_open_key
  ON app.order_sync_pending (app_id, platform, sub_order_id, reason)
  WHERE status = 'open';

CREATE TABLE app.order_sync_counters (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  app_id     text NOT NULL,
  platform   text NOT NULL,
  date       date NOT NULL,
  counter    text NOT NULL,
  count      bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_sync_counters_pkey PRIMARY KEY (id),
  CONSTRAINT order_sync_counters_day_key UNIQUE (app_id, platform, date, counter),
  CONSTRAINT order_sync_counters_counter_check
    CHECK (counter IN ('attr_param_invalid', 'attr_binding_miss', 'order_sync_no_mtime')),
  CONSTRAINT order_sync_counters_count_check CHECK (count >= 0)
);

CREATE TABLE app.order_sync_drops (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  app_id     text NOT NULL,
  platform   text NOT NULL,
  date       date NOT NULL,
  reason     text NOT NULL,
  count      bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_sync_drops_pkey PRIMARY KEY (id),
  CONSTRAINT order_sync_drops_day_key UNIQUE (app_id, platform, date, reason),
  CONSTRAINT order_sync_drops_reason_check CHECK (reason <> ''),
  CONSTRAINT order_sync_drops_count_check CHECK (count >= 0)
);

CREATE TABLE app.order_sync_drop_keys (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  app_id       text NOT NULL,
  platform     text NOT NULL,
  sub_order_id text NOT NULL,
  reason       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_sync_drop_keys_pkey PRIMARY KEY (id),
  CONSTRAINT order_sync_drop_keys_dedup_key UNIQUE (app_id, platform, sub_order_id, reason),
  CONSTRAINT order_sync_drop_keys_reason_check CHECK (reason <> '')
);

CREATE TRIGGER order_sync_drop_keys_append_only
  BEFORE UPDATE OR DELETE ON app.order_sync_drop_keys
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

CREATE TABLE app.order_status_history (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  app_id      text NOT NULL,
  order_id    uuid NOT NULL,
  field       text NOT NULL,
  from_status text,
  event       text NOT NULL,
  to_status   text NOT NULL,
  source      text NOT NULL,
  at          timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_status_history_pkey PRIMARY KEY (id),
  CONSTRAINT order_status_history_order_fkey FOREIGN KEY (app_id, order_id)
    REFERENCES app.order_keys (app_id, order_id),
  CONSTRAINT order_status_history_field_check CHECK (field IN ('platform', 'rebate')),
  CONSTRAINT order_status_history_source_check
    CHECK (source IN ('sync', 'admin', 'claim', 'system'))
);

CREATE INDEX order_status_history_order_idx
  ON app.order_status_history (app_id, order_id, at);

CREATE TRIGGER order_status_history_append_only
  BEFORE UPDATE OR DELETE ON app.order_status_history
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

GRANT SELECT, INSERT, UPDATE ON app.sync_cursors, app.order_sync_pending,
  app.order_sync_counters, app.order_sync_drops TO couli_app;
GRANT SELECT, INSERT ON app.order_sync_drop_keys, app.order_status_history TO couli_app;
GRANT SELECT ON app.sync_cursors, app.order_sync_pending, app.order_sync_counters,
  app.order_sync_drops, app.order_sync_drop_keys, app.order_status_history TO couli_readonly;
