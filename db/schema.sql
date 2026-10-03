--
-- PostgreSQL database dump
--

\restrict couli


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: app; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA app;


--
-- Name: pgboss; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA pgboss;


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: job_state; Type: TYPE; Schema: pgboss; Owner: -
--

CREATE TYPE pgboss.job_state AS ENUM (
    'created',
    'retry',
    'active',
    'completed',
    'cancelled',
    'failed'
);


--
-- Name: ensure_month_partition(text, date); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.ensure_month_partition(p_table text, p_month date) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  v_start  date;
  v_end    date;
  v_name   text;
  v_parent oid;
  v_child  oid;
BEGIN
  IF p_table IS NULL OR p_month IS NULL THEN
    RAISE EXCEPTION 'ensure_month_partition: p_table and p_month are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Allow-list of month-partitioned tables (ADR-0001 §4.2 #5). Extend it in the migration
  -- that creates the next partitioned table.
  IF p_table NOT IN ('event_log') THEN
    RAISE EXCEPTION 'ensure_month_partition: table "%" is not month-partitioned', p_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- date -> timestamp (without time zone) casts keep every step independent of the session
  -- time zone.
  v_start := make_date(extract(year FROM p_month)::int, extract(month FROM p_month)::int, 1);
  v_end   := (v_start + interval '1 month')::date;
  v_name  := p_table || '_p' || to_char(v_start::timestamp, 'YYYYMM');

  -- Serialise concurrent callers for the same partition.
  PERFORM pg_advisory_xact_lock(hashtextextended('app.ensure_month_partition:' || v_name, 0));

  SELECT c.oid INTO v_parent
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = p_table AND c.relkind = 'p';
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'ensure_month_partition: app.% is not a partitioned table', p_table
      USING ERRCODE = 'undefined_table';
  END IF;

  SELECT c.oid INTO v_child
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = v_name;
  IF v_child IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_inherits i WHERE i.inhrelid = v_child AND i.inhparent = v_parent
    ) THEN
      RETURN v_name;
    END IF;
    RAISE EXCEPTION 'ensure_month_partition: app.% exists but is not a partition of app.%',
      v_name, p_table
      USING ERRCODE = 'duplicate_table';
  END IF;

  EXECUTE format(
    'CREATE TABLE app.%I PARTITION OF app.%I FOR VALUES FROM (%L) TO (%L)',
    v_name,
    p_table,
    to_char(v_start::timestamp, 'YYYY-MM-DD') || ' 00:00:00+00',
    to_char(v_end::timestamp, 'YYYY-MM-DD') || ' 00:00:00+00'
  );

  RETURN v_name;
END
$$;


--
-- Name: reject_device_registration_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_device_registration_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF OLD.merged_into_user_id IS NOT NULL
    OR NEW.merged_into_user_id IS NULL
    OR ROW(NEW.app_id, NEW.device_hash, NEW.user_id, NEW.register_method, NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.app_id, OLD.device_hash, OLD.user_id, OLD.register_method, OLD.created_at)
  THEN
    RAISE EXCEPTION 'device_registrations only permits setting an empty merge target once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_update_delete(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_update_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not allowed: append-only table',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;


--
-- Name: create_queue(text, jsonb); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.create_queue(queue_name text, options jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $_$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job_common'
                            END;
      queue_created_on timestamptz;
    BEGIN

      WITH q as (
        INSERT INTO pgboss.queue (
          name,
          policy,
          retry_limit,
          retry_delay,
          retry_backoff,
          retry_delay_max,
          expire_seconds,
          retention_seconds,
          deletion_seconds,
          warning_queued,
          dead_letter,
          partition,
          table_name,
          heartbeat_seconds,
          notify,
          created_on,
          updated_on
        )
        VALUES (
          queue_name,
          options->>'policy',
          COALESCE((options->>'retryLimit')::int, 2),
          COALESCE((options->>'retryDelay')::int, 0),
          COALESCE((options->>'retryBackoff')::bool, false),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, 900),
          COALESCE((options->>'retentionSeconds')::int, 1209600),
          COALESCE((options->>'deleteAfterSeconds')::int, 604800),
          COALESCE((options->>'warningQueueSize')::int, 0),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, false),
          tablename,
          (options->>'heartbeatSeconds')::int,
          COALESCE((options->>'notify')::bool, false),
          pgboss.job_now(),
          pgboss.job_now()
        )
        ON CONFLICT DO NOTHING
        RETURNING created_on
      )
      SELECT created_on into queue_created_on from q;

      IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN
        RETURN;
      END IF;

      EXECUTE format('CREATE TABLE pgboss.%I (LIKE pgboss.job INCLUDING DEFAULTS)', tablename);

      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i11 ON pgboss.job (name, priority DESC, created_on, start_after) WHERE state < 'active' AND NOT blocked$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      ELSIF options->>'policy' = 'key_strict_fifo' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i10 ON pgboss.job (name, singleton_key, state DESC, created_on, id) INCLUDE (start_after) WHERE state < 'active' AND NOT blocked AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE pgboss.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE pgboss.job ATTACH PARTITION pgboss.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $_$;


--
-- Name: delete_queue(text); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.delete_queue(queue_name text) RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_table varchar;
      v_partition bool;
    BEGIN
      
      SELECT table_name, partition
      FROM pgboss.queue
      WHERE name = queue_name
      INTO v_table, v_partition;

      IF v_partition THEN
        EXECUTE format('DROP TABLE IF EXISTS pgboss.%I', v_table);
      ELSE
        EXECUTE format('DELETE FROM pgboss.%I WHERE name = %L', v_table, queue_name);
      END IF;
    
      DELETE FROM pgboss.queue WHERE name = queue_name;
    END;
    $$;


--
-- Name: job_now(); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.job_now() RETURNS timestamp with time zone
    LANGUAGE sql STABLE
    AS $$
      SELECT pg_catalog.now();
    $$;


--
-- Name: job_table_format(text, text); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.job_table_format(command text, table_name text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $_$
      SELECT format(
        regexp_replace(
          regexp_replace(command, '\.job\y', '.%1$I', 'g'),
          '\yjob_i(\d+)', '%1$s_i\1', 'g'
        ),
        table_name
      );
    $_$;


--
-- Name: job_table_run(text, text, text); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.job_table_run(command text, tbl_name text DEFAULT NULL::text, queue_name text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE
      tbl RECORD;
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        EXECUTE pgboss.job_table_format(command, tbl_name);
        RETURN;
      END IF;

      EXECUTE pgboss.job_table_format(command, 'job_common');

      FOR tbl IN SELECT table_name FROM pgboss.queue WHERE partition = true
      LOOP
        EXECUTE pgboss.job_table_format(command, tbl.table_name);
      END LOOP;
    END;
    $$;


--
-- Name: job_table_run_async(text, integer, text, text, text); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.job_table_run_async(command_name text, version integer, command text, tbl_name text DEFAULT NULL::text, queue_name text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
        VALUES (
          command_name,
          version,
          'pending',
          queue_name,
          tbl_name,
          pgboss.job_table_format(command, tbl_name)
        );
        RETURN;
      END IF;

      INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
      SELECT
        command_name,
        version,
        'pending',
        NULL,
        'job_common',
        pgboss.job_table_format(command, 'job_common')
      UNION ALL
      SELECT
        command_name,
        version,
        'pending',
        queue.name,
        queue.table_name,
        pgboss.job_table_format(command, queue.table_name)
      FROM pgboss.queue
      WHERE partition = true;
    END;
    $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: device_registrations; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.device_registrations (
    app_id text NOT NULL,
    device_hash text NOT NULL,
    user_id uuid NOT NULL,
    register_method text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merged_into_user_id uuid
);


--
-- Name: devices; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.devices (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    device_hash text NOT NULL,
    id_source text NOT NULL,
    install_secret_hash text NOT NULL,
    platform text NOT NULL,
    app_version text NOT NULL,
    last_login_sid text,
    revoked_at timestamp with time zone,
    last_seen_at timestamp with time zone NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT devices_device_hash_check CHECK ((device_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT devices_id_source_check CHECK ((id_source = ANY (ARRAY['idfv'::text, 'android_id'::text, 'oaid'::text, 'odid'::text])))
);


--
-- Name: event_log; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.event_log (
    id bigint NOT NULL,
    app_id text NOT NULL,
    event_id uuid NOT NULL,
    name text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
)
PARTITION BY RANGE (occurred_at);


--
-- Name: event_log_default; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.event_log_default (
    id bigint CONSTRAINT event_log_id_not_null NOT NULL,
    app_id text CONSTRAINT event_log_app_id_not_null NOT NULL,
    event_id uuid CONSTRAINT event_log_event_id_not_null NOT NULL,
    name text CONSTRAINT event_log_name_not_null NOT NULL,
    payload jsonb CONSTRAINT event_log_payload_not_null NOT NULL,
    occurred_at timestamp with time zone CONSTRAINT event_log_occurred_at_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT event_log_created_at_not_null NOT NULL
);


--
-- Name: event_log_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.event_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.event_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.idempotency_keys (
    id bigint NOT NULL,
    app_id text NOT NULL,
    subject text NOT NULL,
    user_id uuid,
    method text NOT NULL,
    path text NOT NULL,
    key text NOT NULL,
    request_hash text,
    status text NOT NULL,
    response jsonb,
    expire_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT idempotency_keys_request_data_check CHECK ((((status = 'abandoned'::text) AND (request_hash IS NULL) AND (response IS NULL)) OR ((status = ANY (ARRAY['processing'::text, 'completed'::text])) AND (request_hash IS NOT NULL)))),
    CONSTRAINT idempotency_keys_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'completed'::text, 'abandoned'::text])))
);


--
-- Name: idempotency_keys_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.idempotency_keys ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.idempotency_keys_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: login_logs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.login_logs (
    id bigint NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    device_id_hash text NOT NULL,
    ip inet NOT NULL,
    method text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: login_logs_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.login_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.login_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: processed_events; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.processed_events (
    consumer text NOT NULL,
    event_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_oauth; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.user_oauth (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    union_id text NOT NULL,
    open_id text,
    merged_from_user_id uuid,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_oauth_provider_check CHECK ((provider = ANY (ARRAY['wechat'::text, 'apple'::text, 'huawei'::text])))
);


--
-- Name: users; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.users (
    id uuid NOT NULL,
    app_id text NOT NULL,
    phone_cipher bytea,
    phone_hmac text,
    nickname text NOT NULL,
    avatar text NOT NULL,
    nickname_change_month text,
    nickname_change_count integer DEFAULT 0 NOT NULL,
    invite_code text NOT NULL,
    attr_code text NOT NULL,
    parent_id uuid,
    parent_bind_source text,
    parent_bound_at timestamp with time zone,
    self_bind_used boolean DEFAULT false NOT NULL,
    level text NOT NULL,
    status text DEFAULT 'normal'::text NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    deleted_reason text,
    personalization_off boolean DEFAULT false NOT NULL,
    register_method text NOT NULL,
    registered_channel text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_nickname_change_month_check CHECK ((nickname_change_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))
);


--
-- Name: bam; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.bam (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    version integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    queue text,
    table_name text NOT NULL,
    command text NOT NULL,
    error text,
    created_on timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    started_on timestamp with time zone,
    completed_on timestamp with time zone
);


--
-- Name: job; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.job (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    data jsonb,
    state pgboss.job_state DEFAULT 'created'::pgboss.job_state NOT NULL,
    retry_limit integer DEFAULT 2 NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    retry_delay integer DEFAULT 0 NOT NULL,
    retry_backoff boolean DEFAULT false NOT NULL,
    retry_delay_max integer,
    expire_seconds integer DEFAULT 900 NOT NULL,
    deletion_seconds integer DEFAULT 604800 NOT NULL,
    singleton_key text,
    singleton_on timestamp without time zone,
    group_id text,
    group_tier text,
    start_after timestamp with time zone DEFAULT now() NOT NULL,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    started_on timestamp with time zone,
    completed_on timestamp with time zone,
    keep_until timestamp with time zone DEFAULT (now() + '336:00:00'::interval) NOT NULL,
    output jsonb,
    dead_letter text,
    policy text,
    heartbeat_on timestamp with time zone,
    heartbeat_seconds integer,
    blocked boolean DEFAULT false NOT NULL,
    blocking boolean DEFAULT false NOT NULL,
    pending_dependencies integer DEFAULT 0 NOT NULL,
    source_name text,
    source_id uuid,
    source_created_on timestamp with time zone,
    source_retry_count integer
)
PARTITION BY LIST (name);


--
-- Name: job_common; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.job_common (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT job_id_not_null NOT NULL,
    name text CONSTRAINT job_name_not_null NOT NULL,
    priority integer DEFAULT 0 CONSTRAINT job_priority_not_null NOT NULL,
    data jsonb,
    state pgboss.job_state DEFAULT 'created'::pgboss.job_state CONSTRAINT job_state_not_null NOT NULL,
    retry_limit integer DEFAULT 2 CONSTRAINT job_retry_limit_not_null NOT NULL,
    retry_count integer DEFAULT 0 CONSTRAINT job_retry_count_not_null NOT NULL,
    retry_delay integer DEFAULT 0 CONSTRAINT job_retry_delay_not_null NOT NULL,
    retry_backoff boolean DEFAULT false CONSTRAINT job_retry_backoff_not_null NOT NULL,
    retry_delay_max integer,
    expire_seconds integer DEFAULT 900 CONSTRAINT job_expire_seconds_not_null NOT NULL,
    deletion_seconds integer DEFAULT 604800 CONSTRAINT job_deletion_seconds_not_null NOT NULL,
    singleton_key text,
    singleton_on timestamp without time zone,
    group_id text,
    group_tier text,
    start_after timestamp with time zone DEFAULT now() CONSTRAINT job_start_after_not_null NOT NULL,
    created_on timestamp with time zone DEFAULT now() CONSTRAINT job_created_on_not_null NOT NULL,
    started_on timestamp with time zone,
    completed_on timestamp with time zone,
    keep_until timestamp with time zone DEFAULT (now() + '336:00:00'::interval) CONSTRAINT job_keep_until_not_null NOT NULL,
    output jsonb,
    dead_letter text,
    policy text,
    heartbeat_on timestamp with time zone,
    heartbeat_seconds integer,
    blocked boolean DEFAULT false CONSTRAINT job_blocked_not_null NOT NULL,
    blocking boolean DEFAULT false CONSTRAINT job_blocking_not_null NOT NULL,
    pending_dependencies integer DEFAULT 0 CONSTRAINT job_pending_dependencies_not_null NOT NULL,
    source_name text,
    source_id uuid,
    source_created_on timestamp with time zone,
    source_retry_count integer,
    CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK ((NOT ((policy = 'key_strict_fifo'::text) AND (singleton_key IS NULL))))
);


--
-- Name: job_dependency; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.job_dependency (
    child_name text NOT NULL,
    child_id uuid NOT NULL,
    parent_name text NOT NULL,
    parent_id uuid NOT NULL
);


--
-- Name: queue; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.queue (
    name text NOT NULL,
    policy text NOT NULL,
    retry_limit integer NOT NULL,
    retry_delay integer NOT NULL,
    retry_backoff boolean NOT NULL,
    retry_delay_max integer,
    expire_seconds integer NOT NULL,
    retention_seconds integer NOT NULL,
    deletion_seconds integer NOT NULL,
    dead_letter text,
    partition boolean NOT NULL,
    table_name text NOT NULL,
    deferred_count integer DEFAULT 0 NOT NULL,
    queued_count integer DEFAULT 0 NOT NULL,
    ready_count integer DEFAULT 0 NOT NULL,
    warning_queued integer DEFAULT 0 NOT NULL,
    active_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    ready_history integer[] DEFAULT '{}'::integer[] NOT NULL,
    heartbeat_seconds integer,
    notify boolean DEFAULT false NOT NULL,
    singletons_active text[],
    monitor_claim_on timestamp with time zone,
    monitor_on timestamp with time zone,
    maintain_on timestamp with time zone,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    updated_on timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT queue_check CHECK ((dead_letter IS DISTINCT FROM name))
);


--
-- Name: queue_stats; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.queue_stats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    deferred_count integer DEFAULT 0 NOT NULL,
    queued_count integer DEFAULT 0 NOT NULL,
    ready_count integer DEFAULT 0 NOT NULL,
    active_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    captured_on timestamp with time zone DEFAULT now() NOT NULL
)
PARTITION BY RANGE (captured_on);


--
-- Name: schedule; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.schedule (
    name text NOT NULL,
    key text DEFAULT ''::text NOT NULL,
    kind text DEFAULT 'cron'::text NOT NULL,
    cron text NOT NULL,
    timezone text DEFAULT 'UTC'::text,
    data jsonb,
    options jsonb,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    updated_on timestamp with time zone DEFAULT now() NOT NULL,
    last_job_id uuid,
    CONSTRAINT schedule_kind_check CHECK ((kind = ANY (ARRAY['cron'::text, 'rrule'::text])))
);


--
-- Name: subscription; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.subscription (
    event text NOT NULL,
    name text NOT NULL,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    updated_on timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: version; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.version (
    version integer NOT NULL,
    cron_on timestamp with time zone,
    bam_on timestamp with time zone,
    flow_on timestamp with time zone,
    reindex_on timestamp with time zone,
    monitor_backoff_on timestamp with time zone
);


--
-- Name: warning; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.warning (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    message text NOT NULL,
    data jsonb,
    created_on timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pgmigrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pgmigrations (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    run_on timestamp without time zone NOT NULL
);


--
-- Name: pgmigrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pgmigrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pgmigrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pgmigrations_id_seq OWNED BY public.pgmigrations.id;


--
-- Name: event_log_default; Type: TABLE ATTACH; Schema: app; Owner: -
--

ALTER TABLE ONLY app.event_log ATTACH PARTITION app.event_log_default DEFAULT;


--
-- Name: job_common; Type: TABLE ATTACH; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job ATTACH PARTITION pgboss.job_common DEFAULT;


--
-- Name: pgmigrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgmigrations ALTER COLUMN id SET DEFAULT nextval('public.pgmigrations_id_seq'::regclass);


--
-- Name: device_registrations device_registrations_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.device_registrations
    ADD CONSTRAINT device_registrations_pkey PRIMARY KEY (app_id, user_id);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: event_log event_log_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.event_log
    ADD CONSTRAINT event_log_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: event_log_default event_log_default_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.event_log_default
    ADD CONSTRAINT event_log_default_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_scope_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.idempotency_keys
    ADD CONSTRAINT idempotency_keys_scope_key UNIQUE (app_id, subject, method, path, key);


--
-- Name: login_logs login_logs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.login_logs
    ADD CONSTRAINT login_logs_pkey PRIMARY KEY (id);


--
-- Name: processed_events processed_events_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.processed_events
    ADD CONSTRAINT processed_events_pkey PRIMARY KEY (consumer, event_id);


--
-- Name: user_oauth user_oauth_identity_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_oauth
    ADD CONSTRAINT user_oauth_identity_key UNIQUE (app_id, provider, union_id);


--
-- Name: user_oauth user_oauth_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_oauth
    ADD CONSTRAINT user_oauth_pkey PRIMARY KEY (id);


--
-- Name: user_oauth user_oauth_user_provider_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_oauth
    ADD CONSTRAINT user_oauth_user_provider_key UNIQUE (app_id, user_id, provider);


--
-- Name: users users_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_app_id_id_key UNIQUE (app_id, id);


--
-- Name: users users_attr_code_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_attr_code_key UNIQUE (app_id, attr_code);


--
-- Name: users users_invite_code_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_invite_code_key UNIQUE (app_id, invite_code);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: bam bam_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.bam
    ADD CONSTRAINT bam_pkey PRIMARY KEY (id);


--
-- Name: job job_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job
    ADD CONSTRAINT job_pkey PRIMARY KEY (name, id);


--
-- Name: job_common job_common_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job_common
    ADD CONSTRAINT job_common_pkey PRIMARY KEY (name, id);


--
-- Name: job_dependency job_dependency_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job_dependency
    ADD CONSTRAINT job_dependency_pkey PRIMARY KEY (child_name, child_id, parent_name, parent_id);


--
-- Name: queue queue_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.queue
    ADD CONSTRAINT queue_pkey PRIMARY KEY (name);


--
-- Name: queue_stats queue_stats_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.queue_stats
    ADD CONSTRAINT queue_stats_pkey PRIMARY KEY (id, captured_on);


--
-- Name: schedule schedule_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.schedule
    ADD CONSTRAINT schedule_pkey PRIMARY KEY (name, key);


--
-- Name: subscription subscription_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.subscription
    ADD CONSTRAINT subscription_pkey PRIMARY KEY (event, name);


--
-- Name: version version_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.version
    ADD CONSTRAINT version_pkey PRIMARY KEY (version);


--
-- Name: warning warning_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.warning
    ADD CONSTRAINT warning_pkey PRIMARY KEY (id);


--
-- Name: pgmigrations pgmigrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgmigrations
    ADD CONSTRAINT pgmigrations_pkey PRIMARY KEY (id);


--
-- Name: device_registrations_device_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX device_registrations_device_created_idx ON app.device_registrations USING btree (app_id, device_hash, created_at);


--
-- Name: event_log_event_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX event_log_event_id_idx ON ONLY app.event_log USING btree (event_id);


--
-- Name: event_log_default_event_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX event_log_default_event_id_idx ON app.event_log_default USING btree (event_id);


--
-- Name: users_phone_hmac_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX users_phone_hmac_key ON app.users USING btree (app_id, phone_hmac) WHERE (status <> 'deleted'::text);


--
-- Name: job_common_i1; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i1 ON pgboss.job_common USING btree (name, COALESCE(singleton_key, ''::text)) WHERE ((state = 'created'::pgboss.job_state) AND (policy = 'short'::text));


--
-- Name: job_common_i10; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX job_common_i10 ON pgboss.job_common USING btree (name, singleton_key, state DESC, created_on, id) INCLUDE (start_after) WHERE ((state < 'active'::pgboss.job_state) AND (NOT blocked) AND (policy = 'key_strict_fifo'::text));


--
-- Name: job_common_i11; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX job_common_i11 ON pgboss.job_common USING btree (name, priority DESC, created_on, start_after) WHERE ((state < 'active'::pgboss.job_state) AND (NOT blocked));


--
-- Name: job_common_i2; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i2 ON pgboss.job_common USING btree (name, COALESCE(singleton_key, ''::text)) WHERE ((state = 'active'::pgboss.job_state) AND (policy = 'singleton'::text));


--
-- Name: job_common_i3; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i3 ON pgboss.job_common USING btree (name, state, COALESCE(singleton_key, ''::text)) WHERE ((state <= 'active'::pgboss.job_state) AND (policy = 'stately'::text));


--
-- Name: job_common_i4; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i4 ON pgboss.job_common USING btree (name, singleton_on, COALESCE(singleton_key, ''::text)) WHERE ((state <> 'cancelled'::pgboss.job_state) AND (singleton_on IS NOT NULL));


--
-- Name: job_common_i6; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i6 ON pgboss.job_common USING btree (name, COALESCE(singleton_key, ''::text)) WHERE ((state <= 'active'::pgboss.job_state) AND (policy = 'exclusive'::text));


--
-- Name: job_common_i7; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX job_common_i7 ON pgboss.job_common USING btree (name, group_id) WHERE ((state = 'active'::pgboss.job_state) AND (group_id IS NOT NULL));


--
-- Name: job_common_i8; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i8 ON pgboss.job_common USING btree (name, singleton_key) WHERE ((state = ANY (ARRAY['active'::pgboss.job_state, 'retry'::pgboss.job_state, 'failed'::pgboss.job_state])) AND (policy = 'key_strict_fifo'::text));


--
-- Name: job_common_i9; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX job_common_i9 ON pgboss.job_common USING btree (name, id) WHERE (blocking AND (state = 'completed'::pgboss.job_state));


--
-- Name: job_dep_parent_idx; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX job_dep_parent_idx ON pgboss.job_dependency USING btree (parent_name, parent_id);


--
-- Name: queue_stats_i1; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX queue_stats_i1 ON ONLY pgboss.queue_stats USING btree (name, captured_on DESC) INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count);


--
-- Name: warning_i1; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX warning_i1 ON pgboss.warning USING btree (created_on DESC);


--
-- Name: event_log_default_event_id_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.event_log_event_id_idx ATTACH PARTITION app.event_log_default_event_id_idx;


--
-- Name: event_log_default_pkey; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.event_log_pkey ATTACH PARTITION app.event_log_default_pkey;


--
-- Name: job_common_pkey; Type: INDEX ATTACH; Schema: pgboss; Owner: -
--

ALTER INDEX pgboss.job_pkey ATTACH PARTITION pgboss.job_common_pkey;


--
-- Name: device_registrations device_registrations_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER device_registrations_no_rewrite BEFORE UPDATE ON app.device_registrations FOR EACH ROW EXECUTE FUNCTION app.reject_device_registration_rewrite();


--
-- Name: event_log event_log_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER event_log_append_only BEFORE DELETE OR UPDATE ON app.event_log FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: device_registrations device_registrations_merged_into_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.device_registrations
    ADD CONSTRAINT device_registrations_merged_into_fkey FOREIGN KEY (app_id, merged_into_user_id) REFERENCES app.users(app_id, id);


--
-- Name: device_registrations device_registrations_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.device_registrations
    ADD CONSTRAINT device_registrations_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: devices devices_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.devices
    ADD CONSTRAINT devices_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: login_logs login_logs_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.login_logs
    ADD CONSTRAINT login_logs_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: user_oauth user_oauth_merged_from_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_oauth
    ADD CONSTRAINT user_oauth_merged_from_fkey FOREIGN KEY (app_id, merged_from_user_id) REFERENCES app.users(app_id, id);


--
-- Name: user_oauth user_oauth_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_oauth
    ADD CONSTRAINT user_oauth_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: users users_parent_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_parent_fkey FOREIGN KEY (app_id, parent_id) REFERENCES app.users(app_id, id);


--
-- Name: job_common dlq_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job_common
    ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue(name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;


--
-- Name: job_common q_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job_common
    ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;


--
-- Name: queue queue_dead_letter_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.queue
    ADD CONSTRAINT queue_dead_letter_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue(name);


--
-- Name: schedule schedule_name_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.schedule
    ADD CONSTRAINT schedule_name_fkey FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE CASCADE;


--
-- Name: subscription subscription_name_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.subscription
    ADD CONSTRAINT subscription_name_fkey FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE CASCADE;


--
-- Name: SCHEMA app; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA app TO couli_app;
GRANT USAGE ON SCHEMA app TO couli_payout;
GRANT USAGE ON SCHEMA app TO couli_readonly;
GRANT USAGE ON SCHEMA app TO couli_maint;


--
-- Name: SCHEMA pgboss; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA pgboss TO couli_app;
GRANT USAGE ON SCHEMA pgboss TO couli_payout;


--
-- Name: FUNCTION ensure_month_partition(p_table text, p_month date); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.ensure_month_partition(p_table text, p_month date) FROM PUBLIC;
GRANT ALL ON FUNCTION app.ensure_month_partition(p_table text, p_month date) TO couli_maint;


--
-- Name: FUNCTION reject_device_registration_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_device_registration_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_update_delete(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_update_delete() FROM PUBLIC;


--
-- Name: TABLE device_registrations; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT ON TABLE app.device_registrations TO couli_app;
GRANT SELECT ON TABLE app.device_registrations TO couli_readonly;


--
-- Name: COLUMN device_registrations.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(app_id) ON TABLE app.device_registrations TO couli_app;


--
-- Name: COLUMN device_registrations.device_hash; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(device_hash) ON TABLE app.device_registrations TO couli_app;


--
-- Name: COLUMN device_registrations.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(user_id) ON TABLE app.device_registrations TO couli_app;


--
-- Name: COLUMN device_registrations.register_method; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(register_method) ON TABLE app.device_registrations TO couli_app;


--
-- Name: COLUMN device_registrations.merged_into_user_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(merged_into_user_id) ON TABLE app.device_registrations TO couli_app;


--
-- Name: TABLE devices; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.devices TO couli_app;
GRANT SELECT ON TABLE app.devices TO couli_readonly;


--
-- Name: TABLE event_log; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.event_log TO couli_app;
GRANT SELECT,INSERT ON TABLE app.event_log TO couli_payout;
GRANT SELECT ON TABLE app.event_log TO couli_readonly;


--
-- Name: TABLE idempotency_keys; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.idempotency_keys TO couli_app;
GRANT SELECT ON TABLE app.idempotency_keys TO couli_readonly;


--
-- Name: TABLE login_logs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.login_logs TO couli_app;
GRANT SELECT ON TABLE app.login_logs TO couli_readonly;


--
-- Name: TABLE processed_events; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.processed_events TO couli_app;
GRANT SELECT,INSERT ON TABLE app.processed_events TO couli_payout;
GRANT SELECT ON TABLE app.processed_events TO couli_readonly;


--
-- Name: TABLE user_oauth; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.user_oauth TO couli_app;
GRANT SELECT ON TABLE app.user_oauth TO couli_readonly;


--
-- Name: TABLE users; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.users TO couli_app;
GRANT SELECT ON TABLE app.users TO couli_readonly;


--
-- Name: TABLE bam; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.bam TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.bam TO couli_payout;


--
-- Name: TABLE job; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job TO couli_payout;


--
-- Name: TABLE job_common; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job_common TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job_common TO couli_payout;


--
-- Name: TABLE job_dependency; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job_dependency TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job_dependency TO couli_payout;


--
-- Name: TABLE queue; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.queue TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.queue TO couli_payout;


--
-- Name: TABLE queue_stats; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.queue_stats TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.queue_stats TO couli_payout;


--
-- Name: TABLE schedule; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.schedule TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.schedule TO couli_payout;


--
-- Name: TABLE subscription; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.subscription TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.subscription TO couli_payout;


--
-- Name: TABLE version; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.version TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.version TO couli_payout;


--
-- Name: TABLE warning; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.warning TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.warning TO couli_payout;


--
-- PostgreSQL database dump complete
--

\unrestrict couli
