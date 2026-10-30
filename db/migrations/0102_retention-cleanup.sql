-- Up Migration
-- B1-15zb (BR-ID-30 正文, ⑥ ⑩ ⑮ ⑯ ⑱; orchestrator rulings D10-451, D10-454, D10-457, D10-458).
-- First batch of the row-level retention cleanup, written like app.delete_expired_link_open_attempts
-- (0022; maintenance section J). One SECURITY DEFINER function per table, owner couli_migrator,
-- EXECUTE for couli_maint only; each call deletes at most p_batch_size (1..10000) rows, oldest
-- first, over every app_id, and returns the count. Rows locked by a writer are skipped and picked
-- up by a later batch. No role gets a direct DELETE from this migration.
--
--   app.delete_expired_login_logs            created_at, floor 180 days (⑥)
--   app.delete_expired_device_registrations  created_at, floor 180 days (⑱)
--   app.delete_expired_inbox_messages        created_at, floor 180 days (⑮)
--   app.delete_expired_notify_logs           created_at, floor 190 days, every channel (⑥ ⑯)
--   app.delete_expired_sms_send_attempts     created_at, floor 190 days (⑥, D10-458)
--   app.delete_expired_deleted_identities    expire_at < p_now, no day boundary (⑩)
--
-- created_at tables: a row goes when created_at < 00:00 (+08:00) of (the +08:00 calendar day of
-- p_now − p_days calendar days); a row exactly at the cutoff is kept. p_days comes from the
-- retention.<table>_days configuration, but each function refuses (22023) anything below the BR-ID-30
-- value written in it: this is the second gate behind the configuration floor, so a configuration
-- that was changed by mistake cannot delete too much. 36500 is a technical ceiling against overflow.
--
-- Not touched: order_sync_drop_keys (D10-457), blocklist (D10-454), audit logs and every funds, order
-- and withdrawal table (⑧ ⑫ ⑰). The only trigger on these six tables is the UPDATE trigger
-- device_registrations_no_rewrite, which DELETE does not fire.
--
-- Single-column created_at indexes keep every batch bounded instead of scanning the table;
-- deleted_identities_expire_at_idx already exists and is not duplicated.
--
-- Grants: couli_maint had no way to read configuration. It gets SELECT on app.config_items (same as
-- couli_payout and couli_readonly) and nothing else: the retention keys live there, and the
-- maintenance worker reads them each run. It stays unable to write them.
--
-- Compatibility: additive (six functions, five indexes, one SELECT grant).
-- Recovery: set retention.purge.enabled to false, then apply a corrective migration; rows deleted by
-- later maintenance calls can only be recovered from a backup.
--
-- Timeouts: as in 0022, the runner's single transaction rules out CONCURRENTLY (.squawk.toml excludes
-- require-concurrent-index-creation for this reason), and each CREATE INDEX holds a SHARE lock that
-- blocks writers of that table for the build. These tables are small before launch, so the builds are
-- short; 5s lock wait so a blocked deploy fails fast instead of queueing writers (login_logs is on the
-- login path) behind it, 120s overall as a ceiling for the five builds.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE INDEX login_logs_created_at_idx ON app.login_logs (created_at);
CREATE INDEX device_registrations_created_at_idx ON app.device_registrations (created_at);
CREATE INDEX inbox_messages_created_at_idx ON app.inbox_messages (created_at);
CREATE INDEX notify_logs_created_at_idx ON app.notify_logs (created_at);
CREATE INDEX sms_send_attempts_created_at_idx ON app.sms_send_attempts (created_at);

GRANT SELECT ON TABLE app.config_items TO couli_maint;

-- login_logs ----------------------------------------------------------------------------------

CREATE FUNCTION app.delete_expired_login_logs(p_now timestamptz, p_days integer, p_batch_size integer)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_cutoff  timestamptz;
  v_deleted bigint;
BEGIN
  IF p_now IS NULL OR p_days IS NULL OR p_batch_size IS NULL THEN
    RAISE EXCEPTION 'delete_expired_login_logs: p_now, p_days and p_batch_size are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'delete_expired_login_logs: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'delete_expired_login_logs: p_batch_size must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The floor is BR-ID-30 ⑥ itself: the second gate behind the configuration.
  IF p_days < 180 OR p_days > 36500 THEN
    RAISE EXCEPTION 'delete_expired_login_logs: p_days must be between 180 and 36500'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone. Subtract calendar days before converting
  -- local midnight back to an instant (BR-ID-30 正文).
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - p_days)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  -- One bounded batch over every app_id. SKIP LOCKED: a row a writer holds is left for a later
  -- batch instead of making maintenance wait; table-level waits are capped by lock_timeout.
  WITH victims AS (
    SELECT l.id
    FROM app.login_logs l
    WHERE l.created_at < v_cutoff
    ORDER BY l.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.login_logs t
  USING victims v
  WHERE t.id = v.id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;

ALTER FUNCTION app.delete_expired_login_logs(timestamptz, integer, integer) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.delete_expired_login_logs(timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_expired_login_logs(timestamptz, integer, integer) TO couli_maint;

-- device_registrations ------------------------------------------------------------------------

CREATE FUNCTION app.delete_expired_device_registrations(p_now timestamptz, p_days integer, p_batch_size integer)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_cutoff  timestamptz;
  v_deleted bigint;
BEGIN
  IF p_now IS NULL OR p_days IS NULL OR p_batch_size IS NULL THEN
    RAISE EXCEPTION 'delete_expired_device_registrations: p_now, p_days and p_batch_size are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'delete_expired_device_registrations: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'delete_expired_device_registrations: p_batch_size must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The floor is BR-ID-30 ⑱ itself: the second gate behind the configuration.
  IF p_days < 180 OR p_days > 36500 THEN
    RAISE EXCEPTION 'delete_expired_device_registrations: p_days must be between 180 and 36500'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone (see app.delete_expired_login_logs).
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - p_days)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  WITH victims AS (
    SELECT d.app_id, d.user_id
    FROM app.device_registrations d
    WHERE d.created_at < v_cutoff
    ORDER BY d.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.device_registrations t
  USING victims v
  WHERE t.app_id = v.app_id AND t.user_id = v.user_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;

ALTER FUNCTION app.delete_expired_device_registrations(timestamptz, integer, integer) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.delete_expired_device_registrations(timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_expired_device_registrations(timestamptz, integer, integer) TO couli_maint;

-- inbox_messages ------------------------------------------------------------------------------

CREATE FUNCTION app.delete_expired_inbox_messages(p_now timestamptz, p_days integer, p_batch_size integer)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_cutoff  timestamptz;
  v_deleted bigint;
BEGIN
  IF p_now IS NULL OR p_days IS NULL OR p_batch_size IS NULL THEN
    RAISE EXCEPTION 'delete_expired_inbox_messages: p_now, p_days and p_batch_size are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'delete_expired_inbox_messages: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'delete_expired_inbox_messages: p_batch_size must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The floor is BR-ID-30 ⑮ itself: the second gate behind the configuration.
  IF p_days < 180 OR p_days > 36500 THEN
    RAISE EXCEPTION 'delete_expired_inbox_messages: p_days must be between 180 and 36500'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone (see app.delete_expired_login_logs).
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - p_days)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  WITH victims AS (
    SELECT m.message_id
    FROM app.inbox_messages m
    WHERE m.created_at < v_cutoff
    ORDER BY m.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.inbox_messages t
  USING victims v
  WHERE t.message_id = v.message_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;

ALTER FUNCTION app.delete_expired_inbox_messages(timestamptz, integer, integer) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.delete_expired_inbox_messages(timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_expired_inbox_messages(timestamptz, integer, integer) TO couli_maint;

-- notify_logs ---------------------------------------------------------------------------------

CREATE FUNCTION app.delete_expired_notify_logs(p_now timestamptz, p_days integer, p_batch_size integer)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_cutoff  timestamptz;
  v_deleted bigint;
BEGIN
  IF p_now IS NULL OR p_days IS NULL OR p_batch_size IS NULL THEN
    RAISE EXCEPTION 'delete_expired_notify_logs: p_now, p_days and p_batch_size are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'delete_expired_notify_logs: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'delete_expired_notify_logs: p_batch_size must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The floor is BR-ID-30 ⑥ ⑯ itself: the second gate behind the configuration.
  IF p_days < 190 OR p_days > 36500 THEN
    RAISE EXCEPTION 'delete_expired_notify_logs: p_days must be between 190 and 36500'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone (see app.delete_expired_login_logs).
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - p_days)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  -- Every channel (inbox, push, sms) has the same period.
  WITH victims AS (
    SELECT n.id
    FROM app.notify_logs n
    WHERE n.created_at < v_cutoff
    ORDER BY n.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.notify_logs t
  USING victims v
  WHERE t.id = v.id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;

ALTER FUNCTION app.delete_expired_notify_logs(timestamptz, integer, integer) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.delete_expired_notify_logs(timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_expired_notify_logs(timestamptz, integer, integer) TO couli_maint;

-- sms_send_attempts ---------------------------------------------------------------------------

CREATE FUNCTION app.delete_expired_sms_send_attempts(p_now timestamptz, p_days integer, p_batch_size integer)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_cutoff  timestamptz;
  v_deleted bigint;
BEGIN
  IF p_now IS NULL OR p_days IS NULL OR p_batch_size IS NULL THEN
    RAISE EXCEPTION 'delete_expired_sms_send_attempts: p_now, p_days and p_batch_size are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'delete_expired_sms_send_attempts: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'delete_expired_sms_send_attempts: p_batch_size must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The floor is BR-ID-30 ⑥ (D10-458) itself: the second gate behind the configuration.
  IF p_days < 190 OR p_days > 36500 THEN
    RAISE EXCEPTION 'delete_expired_sms_send_attempts: p_days must be between 190 and 36500'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone (see app.delete_expired_login_logs).
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - p_days)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  WITH victims AS (
    SELECT s.app_id, s.attempt_id
    FROM app.sms_send_attempts s
    WHERE s.created_at < v_cutoff
    ORDER BY s.created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.sms_send_attempts t
  USING victims v
  WHERE t.app_id = v.app_id AND t.attempt_id = v.attempt_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;

ALTER FUNCTION app.delete_expired_sms_send_attempts(timestamptz, integer, integer) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.delete_expired_sms_send_attempts(timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_expired_sms_send_attempts(timestamptz, integer, integer) TO couli_maint;

-- deleted_identities --------------------------------------------------------------------------

CREATE FUNCTION app.delete_expired_deleted_identities(p_now timestamptz, p_batch_size integer)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_now IS NULL OR p_batch_size IS NULL THEN
    RAISE EXCEPTION 'delete_expired_deleted_identities: p_now and p_batch_size are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'delete_expired_deleted_identities: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'delete_expired_deleted_identities: p_batch_size must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- BR-ID-30 ⑩: each row carries its own expiry, compared with the instant itself; no day
  -- boundary, and created_at and deleted_at do not matter.
  WITH victims AS (
    SELECT i.id
    FROM app.deleted_identities i
    WHERE i.expire_at < p_now
    ORDER BY i.expire_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.deleted_identities t
  USING victims v
  WHERE t.id = v.id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;

ALTER FUNCTION app.delete_expired_deleted_identities(timestamptz, integer) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.delete_expired_deleted_identities(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_expired_deleted_identities(timestamptz, integer) TO couli_maint;
