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
  IF p_table NOT IN ('event_log', 'orders') THEN
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
-- Name: reject_link_open_attempt_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_link_open_attempt_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.attempt_id, NEW.app_id, NEW.link_id, NEW.user_id, NEW.opened_at)
      IS DISTINCT FROM
      ROW(OLD.attempt_id, OLD.app_id, OLD.link_id, OLD.user_id, OLD.opened_at)
    OR (OLD.jump_reported_at IS NOT NULL
      AND NEW.jump_reported_at IS DISTINCT FROM OLD.jump_reported_at)
    OR (OLD.dismissed_at IS NOT NULL
      AND NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at)
  THEN
    RAISE EXCEPTION 'link_open_attempts identity is immutable and timestamps are write-once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_link_quote_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_link_quote_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.app_id, NEW.link_id) IS DISTINCT FROM ROW(OLD.app_id, OLD.link_id)
    OR (OLD.quoted_final_price_fen IS NOT NULL
      AND NEW.quoted_final_price_fen IS DISTINCT FROM OLD.quoted_final_price_fen)
    OR (OLD.quoted_coupon_fen IS NOT NULL
      AND NEW.quoted_coupon_fen IS DISTINCT FROM OLD.quoted_coupon_fen)
    OR (OLD.quoted_coupon_id IS NOT NULL
      AND NEW.quoted_coupon_id IS DISTINCT FROM OLD.quoted_coupon_id)
    OR (OLD.quoted_at IS NOT NULL
      AND ROW(NEW.quoted_final_price_fen, NEW.quoted_coupon_fen, NEW.quoted_coupon_id, NEW.quoted_at)
        IS DISTINCT FROM
        ROW(OLD.quoted_final_price_fen, OLD.quoted_coupon_fen, OLD.quoted_coupon_id, OLD.quoted_at))
  THEN
    RAISE EXCEPTION 'links identity and written quote snapshot are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_order_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_order_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.order_id, NEW.app_id, NEW.platform, NEW.sub_order_id, NEW.attr_at)
      IS DISTINCT FROM
      ROW(OLD.order_id, OLD.app_id, OLD.platform, OLD.sub_order_id, OLD.attr_at)
    OR (OLD.product_key IS NOT NULL AND NEW.product_key IS DISTINCT FROM OLD.product_key)
    OR (OLD.settle_period IS NOT NULL AND NEW.settle_period IS DISTINCT FROM OLD.settle_period)
    OR (OLD.credit_requires_settle AND NOT NEW.credit_requires_settle)
  THEN
    RAISE EXCEPTION 'orders identity, written product/period and settlement requirement cannot be rewritten'
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
-- Name: inbox_messages; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.inbox_messages (
    message_id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    code text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    route jsonb,
    read_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: link_logs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.link_logs (
    id bigint NOT NULL,
    app_id text NOT NULL,
    link_id uuid,
    event text NOT NULL,
    user_id uuid,
    opener_user_id uuid,
    platform text,
    product_key text,
    raw_item_id text,
    shop_id text,
    scene text,
    pid_scene text,
    spm text,
    pid text,
    relation_id text,
    client text,
    cache_hit boolean DEFAULT false NOT NULL,
    expired boolean DEFAULT false NOT NULL,
    quoted_price_fen bigint,
    no_rebate boolean DEFAULT false NOT NULL,
    no_rebate_reason text,
    agent_session_id uuid,
    agent_message_id uuid,
    prompt_version text,
    model text,
    result_code integer NOT NULL,
    latency_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT link_logs_event_check CHECK ((event = ANY (ARRAY['convert'::text, 'precompute'::text, 'register'::text, 'open'::text])))
)
PARTITION BY RANGE (created_at);


--
-- Name: link_logs_default; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.link_logs_default (
    id bigint CONSTRAINT link_logs_id_not_null NOT NULL,
    app_id text CONSTRAINT link_logs_app_id_not_null NOT NULL,
    link_id uuid,
    event text CONSTRAINT link_logs_event_not_null NOT NULL,
    user_id uuid,
    opener_user_id uuid,
    platform text,
    product_key text,
    raw_item_id text,
    shop_id text,
    scene text,
    pid_scene text,
    spm text,
    pid text,
    relation_id text,
    client text,
    cache_hit boolean DEFAULT false CONSTRAINT link_logs_cache_hit_not_null NOT NULL,
    expired boolean DEFAULT false CONSTRAINT link_logs_expired_not_null NOT NULL,
    quoted_price_fen bigint,
    no_rebate boolean DEFAULT false CONSTRAINT link_logs_no_rebate_not_null NOT NULL,
    no_rebate_reason text,
    agent_session_id uuid,
    agent_message_id uuid,
    prompt_version text,
    model text,
    result_code integer CONSTRAINT link_logs_result_code_not_null NOT NULL,
    latency_ms integer,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT link_logs_created_at_not_null NOT NULL,
    CONSTRAINT link_logs_event_check CHECK ((event = ANY (ARRAY['convert'::text, 'precompute'::text, 'register'::text, 'open'::text])))
);


--
-- Name: link_logs_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.link_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.link_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: link_open_attempts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.link_open_attempts (
    attempt_id uuid NOT NULL,
    app_id text NOT NULL,
    link_id uuid NOT NULL,
    user_id uuid,
    opened_at timestamp with time zone NOT NULL,
    jump_reported_at timestamp with time zone,
    dismissed_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: links; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.links (
    link_id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    device_id uuid,
    platform text NOT NULL,
    product_key text,
    raw_item_id text,
    raw_fetched_at timestamp with time zone,
    scene text NOT NULL,
    sub_scene text,
    pid_scene text,
    pid text,
    entry_source text,
    identity_snapshot jsonb,
    convert_result bytea,
    cache_hit boolean DEFAULT false NOT NULL,
    quoted_final_price_fen bigint,
    quoted_coupon_fen bigint,
    quoted_coupon_id text,
    quoted_at timestamp with time zone,
    expire_at timestamp with time zone NOT NULL,
    agent_session_id uuid,
    agent_card_id text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
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
-- Name: order_keys; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_keys (
    platform text NOT NULL,
    sub_order_id text NOT NULL,
    order_id uuid NOT NULL,
    app_id text NOT NULL,
    attr_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: order_rights; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_rights (
    id uuid NOT NULL,
    app_id text NOT NULL,
    order_id uuid NOT NULL,
    source text NOT NULL,
    type text NOT NULL,
    status text NOT NULL,
    amount_fen bigint,
    deduction_commission_fen bigint,
    occurred_at timestamp with time zone NOT NULL,
    platform_rights_no text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_rights_status_check CHECK ((status = ANY (ARRAY['PROCESSING'::text, 'WAIT_COMMISSION'::text, 'SUCCEEDED'::text, 'FAILED'::text]))),
    CONSTRAINT order_rights_type_check CHECK ((type = ANY (ARRAY['RIGHTS'::text, 'PUNISH'::text, 'INVALID_AFTER_SETTLE'::text, 'REFUND_AFTER_SETTLE'::text])))
);


--
-- Name: order_settlements; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_settlements (
    app_id text NOT NULL,
    order_id uuid NOT NULL,
    seq integer NOT NULL,
    source text NOT NULL,
    settle_commission_fen bigint NOT NULL,
    settled_at timestamp with time zone NOT NULL,
    content_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_settlements_source_check CHECK ((source = ANY (ARRAY['API'::text, 'STATEMENT'::text])))
);


--
-- Name: orders; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.orders (
    order_id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    sub_order_id text NOT NULL,
    parent_order_id text,
    shop_type text,
    product_key text,
    raw_item_id text NOT NULL,
    shop_id text,
    title text,
    image_url text,
    quantity integer,
    refunded_quantity integer,
    refunded_quantity_at_credit integer,
    pay_amount_fen bigint,
    pid text,
    relation_id text,
    sub_union_id text,
    custom_params text,
    link_id uuid,
    source_match text,
    user_id uuid,
    buy_type text,
    scene_basis text,
    user_basis text,
    platform_status text NOT NULL,
    rebate_status text DEFAULT 'UNATTRIBUTED'::text NOT NULL,
    hold boolean DEFAULT false NOT NULL,
    hold_reason text,
    rights_pending boolean DEFAULT false NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    commission_version integer DEFAULT 0 NOT NULL,
    reason text,
    reason_sub text,
    diff_reason_code text,
    is_presale boolean DEFAULT false NOT NULL,
    deposit_paid_at timestamp with time zone,
    paid_at timestamp with time zone,
    paid_at_source text,
    attr_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone,
    platform_received_at timestamp with time zone,
    received_synced_at timestamp with time zone,
    settled_at timestamp with time zone,
    union_settled_at timestamp with time zone,
    settle_period text,
    platform_modified_at timestamp with time zone,
    credit_requires_settle boolean DEFAULT false NOT NULL,
    credited_at timestamp with time zone,
    est_commission_fen bigint,
    settle_commission_fen bigint,
    subsidy_commission_fen bigint,
    booked_base_fen bigint,
    booked_n_fen bigint,
    initial_est_fen bigint,
    n_total_fen bigint,
    pre_base_deduct_fen bigint,
    base_fen bigint,
    platform_est_profit_fen bigint,
    commission_rate_bp integer,
    is_price_compare boolean,
    commission_rate_min_bp integer,
    commission_rate_max_bp integer,
    activity_type text,
    source_scene text,
    agent_session_id uuid,
    content_hash text,
    raw_payload_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT orders_buy_type_check CHECK ((buy_type = ANY (ARRAY['self'::text, 'share'::text]))),
    CONSTRAINT orders_diff_reason_check CHECK ((diff_reason_code = ANY (ARRAY['PART_REFUND'::text, 'PRICE_COMPARE'::text, 'PRICE_PROTECT'::text, 'SETTLE_DIFF'::text]))),
    CONSTRAINT orders_hold_reason_check CHECK ((hold_reason = ANY (ARRAY['RISK'::text, 'CS'::text, 'UNMAPPED_STATUS'::text]))),
    CONSTRAINT orders_platform_status_check CHECK ((platform_status = ANY (ARRAY['DEPOSIT_PAID'::text, 'PAID'::text, 'RECEIVED'::text, 'SETTLED'::text, 'INVALID'::text]))),
    CONSTRAINT orders_reason_check CHECK ((reason = ANY (ARRAY['REFUND'::text, 'RIGHTS'::text, 'PUNISH'::text, 'PRESALE_UNPAID'::text, 'COMMISSION_ZERO'::text, 'OTHER'::text, 'BLACKLIST'::text, 'PART_REFUND'::text, 'PRICE_COMPARE'::text, 'PRICE_PROTECT'::text, 'SETTLE_DIFF'::text]))),
    CONSTRAINT orders_rebate_status_check CHECK ((rebate_status = ANY (ARRAY['UNATTRIBUTED'::text, 'ESTIMATED'::text, 'WAITING'::text, 'CREDITED'::text, 'VOID'::text, 'CLAWED_BACK'::text]))),
    CONSTRAINT orders_scene_basis_check CHECK ((scene_basis = ANY (ARRAY['pid'::text, 'param'::text, 'fallback'::text]))),
    CONSTRAINT orders_settle_period_check CHECK ((settle_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT orders_source_match_check CHECK ((source_match = ANY (ARRAY['exact'::text, 'product'::text, 'shop'::text, 'none'::text]))),
    CONSTRAINT orders_user_basis_check CHECK ((user_basis = ANY (ARRAY['param'::text, 'claim'::text, 'admin'::text])))
)
PARTITION BY RANGE (attr_at);


--
-- Name: orders_default; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.orders_default (
    order_id uuid CONSTRAINT orders_order_id_not_null NOT NULL,
    app_id text CONSTRAINT orders_app_id_not_null NOT NULL,
    platform text CONSTRAINT orders_platform_not_null NOT NULL,
    sub_order_id text CONSTRAINT orders_sub_order_id_not_null NOT NULL,
    parent_order_id text,
    shop_type text,
    product_key text,
    raw_item_id text CONSTRAINT orders_raw_item_id_not_null NOT NULL,
    shop_id text,
    title text,
    image_url text,
    quantity integer,
    refunded_quantity integer,
    refunded_quantity_at_credit integer,
    pay_amount_fen bigint,
    pid text,
    relation_id text,
    sub_union_id text,
    custom_params text,
    link_id uuid,
    source_match text,
    user_id uuid,
    buy_type text,
    scene_basis text,
    user_basis text,
    platform_status text CONSTRAINT orders_platform_status_not_null NOT NULL,
    rebate_status text DEFAULT 'UNATTRIBUTED'::text CONSTRAINT orders_rebate_status_not_null NOT NULL,
    hold boolean DEFAULT false CONSTRAINT orders_hold_not_null NOT NULL,
    hold_reason text,
    rights_pending boolean DEFAULT false CONSTRAINT orders_rights_pending_not_null NOT NULL,
    locked boolean DEFAULT false CONSTRAINT orders_locked_not_null NOT NULL,
    row_version integer DEFAULT 0 CONSTRAINT orders_row_version_not_null NOT NULL,
    commission_version integer DEFAULT 0 CONSTRAINT orders_commission_version_not_null NOT NULL,
    reason text,
    reason_sub text,
    diff_reason_code text,
    is_presale boolean DEFAULT false CONSTRAINT orders_is_presale_not_null NOT NULL,
    deposit_paid_at timestamp with time zone,
    paid_at timestamp with time zone,
    paid_at_source text,
    attr_at timestamp with time zone CONSTRAINT orders_attr_at_not_null NOT NULL,
    received_at timestamp with time zone,
    platform_received_at timestamp with time zone,
    received_synced_at timestamp with time zone,
    settled_at timestamp with time zone,
    union_settled_at timestamp with time zone,
    settle_period text,
    platform_modified_at timestamp with time zone,
    credit_requires_settle boolean DEFAULT false CONSTRAINT orders_credit_requires_settle_not_null NOT NULL,
    credited_at timestamp with time zone,
    est_commission_fen bigint,
    settle_commission_fen bigint,
    subsidy_commission_fen bigint,
    booked_base_fen bigint,
    booked_n_fen bigint,
    initial_est_fen bigint,
    n_total_fen bigint,
    pre_base_deduct_fen bigint,
    base_fen bigint,
    platform_est_profit_fen bigint,
    commission_rate_bp integer,
    is_price_compare boolean,
    commission_rate_min_bp integer,
    commission_rate_max_bp integer,
    activity_type text,
    source_scene text,
    agent_session_id uuid,
    content_hash text,
    raw_payload_id bigint,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT orders_created_at_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT orders_updated_at_not_null NOT NULL,
    CONSTRAINT orders_buy_type_check CHECK ((buy_type = ANY (ARRAY['self'::text, 'share'::text]))),
    CONSTRAINT orders_diff_reason_check CHECK ((diff_reason_code = ANY (ARRAY['PART_REFUND'::text, 'PRICE_COMPARE'::text, 'PRICE_PROTECT'::text, 'SETTLE_DIFF'::text]))),
    CONSTRAINT orders_hold_reason_check CHECK ((hold_reason = ANY (ARRAY['RISK'::text, 'CS'::text, 'UNMAPPED_STATUS'::text]))),
    CONSTRAINT orders_platform_status_check CHECK ((platform_status = ANY (ARRAY['DEPOSIT_PAID'::text, 'PAID'::text, 'RECEIVED'::text, 'SETTLED'::text, 'INVALID'::text]))),
    CONSTRAINT orders_reason_check CHECK ((reason = ANY (ARRAY['REFUND'::text, 'RIGHTS'::text, 'PUNISH'::text, 'PRESALE_UNPAID'::text, 'COMMISSION_ZERO'::text, 'OTHER'::text, 'BLACKLIST'::text, 'PART_REFUND'::text, 'PRICE_COMPARE'::text, 'PRICE_PROTECT'::text, 'SETTLE_DIFF'::text]))),
    CONSTRAINT orders_rebate_status_check CHECK ((rebate_status = ANY (ARRAY['UNATTRIBUTED'::text, 'ESTIMATED'::text, 'WAITING'::text, 'CREDITED'::text, 'VOID'::text, 'CLAWED_BACK'::text]))),
    CONSTRAINT orders_scene_basis_check CHECK ((scene_basis = ANY (ARRAY['pid'::text, 'param'::text, 'fallback'::text]))),
    CONSTRAINT orders_settle_period_check CHECK ((settle_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT orders_source_match_check CHECK ((source_match = ANY (ARRAY['exact'::text, 'product'::text, 'shop'::text, 'none'::text]))),
    CONSTRAINT orders_user_basis_check CHECK ((user_basis = ANY (ARRAY['param'::text, 'claim'::text, 'admin'::text])))
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
-- Name: push_tokens; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.push_tokens (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    bound_sid text,
    device_id uuid NOT NULL,
    provider text NOT NULL,
    token text NOT NULL,
    token_set_at timestamp with time zone NOT NULL,
    acquired_by_move_at timestamp with time zone,
    frozen_until timestamp with time zone,
    revoked_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
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
-- Name: user_tip_reads; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.user_tip_reads (
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    tip_key text NOT NULL,
    platform text NOT NULL,
    read_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_tip_reads_tip_key_check CHECK ((tip_key = ANY (ARRAY['jump_tip'::text, 'inviter_before_buy'::text])))
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
-- Name: link_logs_default; Type: TABLE ATTACH; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_logs ATTACH PARTITION app.link_logs_default DEFAULT;


--
-- Name: orders_default; Type: TABLE ATTACH; Schema: app; Owner: -
--

ALTER TABLE ONLY app.orders ATTACH PARTITION app.orders_default DEFAULT;


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
-- Name: inbox_messages inbox_messages_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.inbox_messages
    ADD CONSTRAINT inbox_messages_pkey PRIMARY KEY (message_id);


--
-- Name: link_logs link_logs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_logs
    ADD CONSTRAINT link_logs_pkey PRIMARY KEY (id, created_at);


--
-- Name: link_logs_default link_logs_default_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_logs_default
    ADD CONSTRAINT link_logs_default_pkey PRIMARY KEY (id, created_at);


--
-- Name: link_open_attempts link_open_attempts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_open_attempts
    ADD CONSTRAINT link_open_attempts_pkey PRIMARY KEY (attempt_id);


--
-- Name: links links_app_id_link_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.links
    ADD CONSTRAINT links_app_id_link_id_key UNIQUE (app_id, link_id);


--
-- Name: links links_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.links
    ADD CONSTRAINT links_pkey PRIMARY KEY (link_id);


--
-- Name: login_logs login_logs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.login_logs
    ADD CONSTRAINT login_logs_pkey PRIMARY KEY (id);


--
-- Name: order_keys order_keys_app_order_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_keys
    ADD CONSTRAINT order_keys_app_order_key UNIQUE (app_id, order_id);


--
-- Name: order_keys order_keys_identity_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_keys
    ADD CONSTRAINT order_keys_identity_key UNIQUE (order_id, attr_at, app_id, platform, sub_order_id);


--
-- Name: order_keys order_keys_order_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_keys
    ADD CONSTRAINT order_keys_order_id_key UNIQUE (order_id);


--
-- Name: order_keys order_keys_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_keys
    ADD CONSTRAINT order_keys_pkey PRIMARY KEY (platform, sub_order_id);


--
-- Name: order_rights order_rights_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_rights
    ADD CONSTRAINT order_rights_pkey PRIMARY KEY (id);


--
-- Name: order_settlements order_settlements_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_settlements
    ADD CONSTRAINT order_settlements_pkey PRIMARY KEY (order_id, seq);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (order_id, attr_at);


--
-- Name: orders_default orders_default_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.orders_default
    ADD CONSTRAINT orders_default_pkey PRIMARY KEY (order_id, attr_at);


--
-- Name: processed_events processed_events_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.processed_events
    ADD CONSTRAINT processed_events_pkey PRIMARY KEY (consumer, event_id);


--
-- Name: push_tokens push_tokens_device_provider_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.push_tokens
    ADD CONSTRAINT push_tokens_device_provider_key UNIQUE (app_id, device_id, provider);


--
-- Name: push_tokens push_tokens_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.push_tokens
    ADD CONSTRAINT push_tokens_pkey PRIMARY KEY (id);


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
-- Name: user_tip_reads user_tip_reads_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_tip_reads
    ADD CONSTRAINT user_tip_reads_pkey PRIMARY KEY (app_id, user_id, tip_key, platform);


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
-- Name: devices_app_id_id_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX devices_app_id_id_key ON app.devices USING btree (app_id, id);


--
-- Name: event_log_event_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX event_log_event_id_idx ON ONLY app.event_log USING btree (event_id);


--
-- Name: event_log_default_event_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX event_log_default_event_id_idx ON app.event_log_default USING btree (event_id);


--
-- Name: inbox_messages_user_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX inbox_messages_user_created_idx ON app.inbox_messages USING btree (app_id, user_id, created_at, message_id);


--
-- Name: link_logs_link_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX link_logs_link_created_idx ON ONLY app.link_logs USING btree (app_id, link_id, created_at);


--
-- Name: link_logs_default_app_id_link_id_created_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX link_logs_default_app_id_link_id_created_at_idx ON app.link_logs_default USING btree (app_id, link_id, created_at);


--
-- Name: link_open_attempts_link_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX link_open_attempts_link_idx ON app.link_open_attempts USING btree (app_id, link_id);


--
-- Name: link_open_attempts_user_opened_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX link_open_attempts_user_opened_idx ON app.link_open_attempts USING btree (app_id, user_id, opened_at);


--
-- Name: order_rights_order_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX order_rights_order_idx ON app.order_rights USING btree (app_id, order_id);


--
-- Name: orders_link_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX orders_link_idx ON ONLY app.orders USING btree (app_id, link_id);


--
-- Name: orders_default_app_id_link_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX orders_default_app_id_link_id_idx ON app.orders_default USING btree (app_id, link_id);


--
-- Name: orders_user_paid_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX orders_user_paid_idx ON ONLY app.orders USING btree (app_id, user_id, paid_at DESC, order_id DESC);


--
-- Name: orders_default_app_id_user_id_paid_at_order_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX orders_default_app_id_user_id_paid_at_order_id_idx ON app.orders_default USING btree (app_id, user_id, paid_at DESC, order_id DESC);


--
-- Name: push_tokens_live_token_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX push_tokens_live_token_key ON app.push_tokens USING btree (app_id, provider, token) WHERE (revoked_at IS NULL);


--
-- Name: push_tokens_user_bound_sid_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX push_tokens_user_bound_sid_idx ON app.push_tokens USING btree (app_id, user_id, bound_sid);


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
-- Name: link_logs_default_app_id_link_id_created_at_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.link_logs_link_created_idx ATTACH PARTITION app.link_logs_default_app_id_link_id_created_at_idx;


--
-- Name: link_logs_default_pkey; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.link_logs_pkey ATTACH PARTITION app.link_logs_default_pkey;


--
-- Name: orders_default_app_id_link_id_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.orders_link_idx ATTACH PARTITION app.orders_default_app_id_link_id_idx;


--
-- Name: orders_default_app_id_user_id_paid_at_order_id_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.orders_user_paid_idx ATTACH PARTITION app.orders_default_app_id_user_id_paid_at_order_id_idx;


--
-- Name: orders_default_pkey; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.orders_pkey ATTACH PARTITION app.orders_default_pkey;


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
-- Name: link_logs link_logs_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER link_logs_append_only BEFORE DELETE OR UPDATE ON app.link_logs FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: link_open_attempts link_open_attempts_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER link_open_attempts_no_rewrite BEFORE UPDATE ON app.link_open_attempts FOR EACH ROW EXECUTE FUNCTION app.reject_link_open_attempt_rewrite();


--
-- Name: links links_no_quote_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER links_no_quote_rewrite BEFORE UPDATE ON app.links FOR EACH ROW EXECUTE FUNCTION app.reject_link_quote_rewrite();


--
-- Name: order_keys order_keys_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER order_keys_append_only BEFORE DELETE OR UPDATE ON app.order_keys FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: order_settlements order_settlements_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER order_settlements_append_only BEFORE DELETE OR UPDATE ON app.order_settlements FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: orders orders_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER orders_no_rewrite BEFORE UPDATE ON app.orders FOR EACH ROW EXECUTE FUNCTION app.reject_order_rewrite();


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
-- Name: inbox_messages inbox_messages_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.inbox_messages
    ADD CONSTRAINT inbox_messages_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: link_logs link_logs_opener_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.link_logs
    ADD CONSTRAINT link_logs_opener_user_fkey FOREIGN KEY (app_id, opener_user_id) REFERENCES app.users(app_id, id);


--
-- Name: link_logs link_logs_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.link_logs
    ADD CONSTRAINT link_logs_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: link_open_attempts link_open_attempts_link_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_open_attempts
    ADD CONSTRAINT link_open_attempts_link_fkey FOREIGN KEY (app_id, link_id) REFERENCES app.links(app_id, link_id);


--
-- Name: link_open_attempts link_open_attempts_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_open_attempts
    ADD CONSTRAINT link_open_attempts_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: links links_device_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.links
    ADD CONSTRAINT links_device_fkey FOREIGN KEY (app_id, device_id) REFERENCES app.devices(app_id, id);


--
-- Name: links links_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.links
    ADD CONSTRAINT links_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: login_logs login_logs_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.login_logs
    ADD CONSTRAINT login_logs_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: order_rights order_rights_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_rights
    ADD CONSTRAINT order_rights_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: order_settlements order_settlements_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_settlements
    ADD CONSTRAINT order_settlements_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: orders orders_identity_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.orders
    ADD CONSTRAINT orders_identity_fkey FOREIGN KEY (order_id, attr_at, app_id, platform, sub_order_id) REFERENCES app.order_keys(order_id, attr_at, app_id, platform, sub_order_id);


--
-- Name: orders orders_link_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.orders
    ADD CONSTRAINT orders_link_fkey FOREIGN KEY (app_id, link_id) REFERENCES app.links(app_id, link_id);


--
-- Name: orders orders_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.orders
    ADD CONSTRAINT orders_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: push_tokens push_tokens_device_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.push_tokens
    ADD CONSTRAINT push_tokens_device_fkey FOREIGN KEY (app_id, device_id) REFERENCES app.devices(app_id, id);


--
-- Name: push_tokens push_tokens_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.push_tokens
    ADD CONSTRAINT push_tokens_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


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
-- Name: user_tip_reads user_tip_reads_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_tip_reads
    ADD CONSTRAINT user_tip_reads_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


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
-- Name: FUNCTION reject_link_open_attempt_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_link_open_attempt_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_link_quote_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_link_quote_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_order_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_order_rewrite() FROM PUBLIC;


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
-- Name: TABLE inbox_messages; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.inbox_messages TO couli_app;
GRANT SELECT ON TABLE app.inbox_messages TO couli_readonly;


--
-- Name: COLUMN inbox_messages.read_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(read_at) ON TABLE app.inbox_messages TO couli_app;


--
-- Name: COLUMN inbox_messages.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.inbox_messages TO couli_app;


--
-- Name: COLUMN inbox_messages.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.inbox_messages TO couli_app;


--
-- Name: TABLE link_logs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.link_logs TO couli_app;
GRANT SELECT ON TABLE app.link_logs TO couli_readonly;


--
-- Name: TABLE link_logs_default; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT ON TABLE app.link_logs_default TO couli_readonly;


--
-- Name: TABLE link_open_attempts; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.link_open_attempts TO couli_app;
GRANT SELECT ON TABLE app.link_open_attempts TO couli_readonly;


--
-- Name: COLUMN link_open_attempts.jump_reported_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(jump_reported_at) ON TABLE app.link_open_attempts TO couli_app;


--
-- Name: COLUMN link_open_attempts.dismissed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(dismissed_at) ON TABLE app.link_open_attempts TO couli_app;


--
-- Name: COLUMN link_open_attempts.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.link_open_attempts TO couli_app;


--
-- Name: COLUMN link_open_attempts.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.link_open_attempts TO couli_app;


--
-- Name: TABLE links; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.links TO couli_app;
GRANT SELECT ON TABLE app.links TO couli_readonly;


--
-- Name: TABLE login_logs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.login_logs TO couli_app;
GRANT SELECT ON TABLE app.login_logs TO couli_readonly;


--
-- Name: TABLE order_keys; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.order_keys TO couli_app;
GRANT SELECT ON TABLE app.order_keys TO couli_readonly;


--
-- Name: TABLE order_rights; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.order_rights TO couli_app;
GRANT SELECT ON TABLE app.order_rights TO couli_readonly;


--
-- Name: TABLE order_settlements; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.order_settlements TO couli_app;
GRANT SELECT ON TABLE app.order_settlements TO couli_readonly;


--
-- Name: TABLE orders; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.orders TO couli_app;
GRANT SELECT ON TABLE app.orders TO couli_readonly;


--
-- Name: TABLE orders_default; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT ON TABLE app.orders_default TO couli_readonly;


--
-- Name: TABLE processed_events; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.processed_events TO couli_app;
GRANT SELECT,INSERT ON TABLE app.processed_events TO couli_payout;
GRANT SELECT ON TABLE app.processed_events TO couli_readonly;


--
-- Name: TABLE push_tokens; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE app.push_tokens TO couli_app;
GRANT SELECT ON TABLE app.push_tokens TO couli_readonly;


--
-- Name: COLUMN push_tokens.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(user_id) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.bound_sid; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(bound_sid) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.token; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(token) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.token_set_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(token_set_at) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.acquired_by_move_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(acquired_by_move_at) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.frozen_until; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(frozen_until) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.revoked_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(revoked_at) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.push_tokens TO couli_app;


--
-- Name: TABLE user_oauth; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.user_oauth TO couli_app;
GRANT SELECT ON TABLE app.user_oauth TO couli_readonly;


--
-- Name: TABLE user_tip_reads; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE app.user_tip_reads TO couli_app;
GRANT SELECT ON TABLE app.user_tip_reads TO couli_readonly;


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
