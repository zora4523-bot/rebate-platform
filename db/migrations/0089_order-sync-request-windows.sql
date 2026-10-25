-- Up Migration
-- Per-job progress of the console's manual order sync (01 F-ORD-10; 02 §7.1; 04 §3.2
-- order_sync_requests). Task B1-09i (money review r1: a request ends only once every job it
-- dispatched has ended, and a redelivered job counts once). The file number is a placeholder,
-- taken at landing time; nothing below depends on it.
-- Compatibility: additive. One new empty table, and one new unique index on the existing
-- app.order_sync_requests (app_id, id) as the target of the new table's app-scoped foreign key (no
-- column, constraint, data or grant change there).
-- Recovery: restore from backup; no down migration. (Until a release writes to it, the table and
-- the index could be dropped by a new migration.)
--
-- app.order_sync_request_windows: one row per job a manual request dispatched, inserted in the
--   same transaction as the request and its queue sends. Columns:
--   app_id, sync_id   the request (FK app.order_sync_requests (app_id, id), same app only).
--   seq               the job's index within the request, 0-based; it travels in the job payload.
--   union_account_id  the union account the job queries (no foreign key to app.union_accounts:
--                     the row records which account a job was sent for, as the job payload does).
--   window_start, window_end   the job's fixed window [start, end), both empty for an
--                     order-number job (mode order_nos), otherwise start < end.
--   status            queued / running / done / failed (CHECK), same values as the request.
--   fetched_count, stored_count   the job's own counts, written once when it ends; the request's
--                     counts are their sum.
--   error             why the job failed; finished_at exactly when the job has ended.
--   created_at, updated_at   technical times (updated_at is written by the application).
--   The worker ends a row only by compare-and-set from queued / running, so a redelivered job
--   whose row already ended changes nothing. The request is done once no row of it is queued or
--   running and none failed, failed as soon as one row failed.
-- Uniqueness: primary key (sync_id, seq); at most one row per (sync_id, union_account_id,
--   window_start), NULLS NOT DISTINCT so an account's order-number job is single too.
-- No foreign key cascades. Rows are never deleted (BR-ID-30 for order tables).
-- Retention: none here.
--
-- Grants: couli_app SELECT, INSERT, and UPDATE only on status, fetched_count, stored_count,
-- error, finished_at, updated_at; no DELETE. couli_readonly SELECT. couli_payout and couli_maint
-- get nothing.
--
-- Timeouts: one new empty table plus one index build on app.order_sync_requests (SHARE lock; the
-- table is small, written by the console only). 5s lock wait so a blocked deploy fails fast, 60s
-- overall as a ceiling for the index build.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE UNIQUE INDEX order_sync_requests_app_id_id_key
  ON app.order_sync_requests (app_id, id);

CREATE TABLE app.order_sync_request_windows (
  app_id           text NOT NULL,
  sync_id          uuid NOT NULL,
  seq              integer NOT NULL,
  union_account_id uuid NOT NULL,
  window_start     timestamptz,
  window_end       timestamptz,
  status           text NOT NULL,
  fetched_count    integer NOT NULL DEFAULT 0,
  stored_count     integer NOT NULL DEFAULT 0,
  error            text,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_sync_request_windows_pkey PRIMARY KEY (sync_id, seq),
  CONSTRAINT order_sync_request_windows_window_key
    UNIQUE NULLS NOT DISTINCT (sync_id, union_account_id, window_start),
  CONSTRAINT order_sync_request_windows_sync_fkey FOREIGN KEY (app_id, sync_id)
    REFERENCES app.order_sync_requests (app_id, id),
  CONSTRAINT order_sync_request_windows_seq_check CHECK (seq >= 0),
  CONSTRAINT order_sync_request_windows_window_check CHECK (
    (window_start IS NULL AND window_end IS NULL)
    OR (window_start IS NOT NULL AND window_end IS NOT NULL AND window_start < window_end)
  ),
  CONSTRAINT order_sync_request_windows_status_check
    CHECK (status IN ('queued', 'running', 'done', 'failed')),
  CONSTRAINT order_sync_request_windows_counts_check
    CHECK (fetched_count >= 0 AND stored_count >= 0),
  CONSTRAINT order_sync_request_windows_finished_check
    CHECK ((status IN ('done', 'failed')) = (finished_at IS NOT NULL))
);

CREATE INDEX order_sync_request_windows_account_idx
  ON app.order_sync_request_windows (app_id, union_account_id);

GRANT SELECT, INSERT ON app.order_sync_request_windows TO couli_app;
GRANT UPDATE (status, fetched_count, stored_count, error, finished_at, updated_at)
  ON app.order_sync_request_windows TO couli_app;
GRANT SELECT ON app.order_sync_request_windows TO couli_readonly;
