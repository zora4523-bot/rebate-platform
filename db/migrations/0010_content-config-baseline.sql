-- Up Migration
-- Content/configuration baseline (规划/04 §3.2, §6.2, §10; ADR-0001 §4).
-- Compatibility: additive. Recovery: restore from backup; no down migration.
-- Entity UUIDs are UUIDv7 supplied by the application. The apps baseline is pending;
-- app_id foreign keys must be added when that table exists.
-- Writers compare row_version and increment it in the same UPDATE (CAS).
-- Business timestamps, including published_at, come from the injected Clock.
--
-- The content writer validates store keys and listing element shapes against the
-- contracts and specs/app-stores.yaml, rejects duplicate stores, checks default_store
-- membership and store/version compatibility, and preserves the submitted array order.
-- These save-time business checks are not implemented by database functions/triggers.
-- The application also requires notice_end_at for a non-closable notice and maintains
-- notice_content_version independently of the article revision.
-- Configuration changes must record actor and before/after values in the application's
-- audit transaction; updated_by alone is not an audit trail. No audit trigger is used.

CREATE TABLE app.app_versions (
  id                     uuid NOT NULL,
  app_id                 text NOT NULL,
  platform               text NOT NULL,
  channel                text NOT NULL,
  latest_version         text NOT NULL,
  min_supported_version  text,
  recommended_version    text,
  update_title           text NOT NULL,
  update_notes           text NOT NULL,
  store_url              text NOT NULL,
  default_store          text NOT NULL,
  store_listings         jsonb NOT NULL,
  row_version            integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_versions_pkey PRIMARY KEY (id),
  CONSTRAINT app_versions_app_platform_channel_key UNIQUE (app_id, platform, channel),
  CONSTRAINT app_versions_platform_check
    CHECK (platform IN ('ios', 'android', 'harmony', 'h5', 'admin')),
  -- SemVer is the x.y.z shape defined by contracts/openapi.yaml.
  CONSTRAINT app_versions_latest_version_check
    CHECK (latest_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  CONSTRAINT app_versions_min_supported_version_check
    CHECK (min_supported_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  CONSTRAINT app_versions_recommended_version_check
    CHECK (recommended_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  CONSTRAINT app_versions_store_listings_array_check
    CHECK (jsonb_typeof(store_listings) = 'array')
);

-- Keep revisions under the same article UUID so GET /articles/{id}?version= can
-- retrieve an older published version. The content writer inserts each new revision.
-- Status remains open text until an authoritative content-state contract exists.
CREATE TABLE app.articles (
  id                      uuid NOT NULL,
  app_id                  text NOT NULL,
  category                text NOT NULL,
  title                   text NOT NULL,
  body                    text NOT NULL,
  version                 integer NOT NULL DEFAULT 1,
  status                  text NOT NULL,
  published_at            timestamptz,
  notice_closable          boolean NOT NULL,
  notice_content_version  integer NOT NULL DEFAULT 1,
  notice_end_at           timestamptz,
  row_version             integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT articles_pkey PRIMARY KEY (id, version),
  CONSTRAINT articles_category_check CHECK (category IN ('help', 'rule', 'notice', 'agreement')),
  CONSTRAINT articles_version_check CHECK (version >= 1),
  CONSTRAINT articles_notice_content_version_check CHECK (notice_content_version >= 1)
);

CREATE INDEX articles_app_category_published_idx
  ON app.articles (app_id, category, status, published_at, id, version);

-- Configuration is addressed by (app_id, key); version is the configuration revision,
-- separate from the row_version used for optimistic concurrency.
-- updated_by is an opaque actor identifier (including the synthetic seed actor).
CREATE TABLE app.config_items (
  app_id       text NOT NULL,
  key          text NOT NULL,
  value        jsonb NOT NULL,
  version      integer NOT NULL DEFAULT 1,
  updated_by   text NOT NULL,
  row_version  integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT config_items_pkey PRIMARY KEY (app_id, key),
  CONSTRAINT config_items_version_check CHECK (version >= 1)
);

GRANT SELECT, INSERT, UPDATE ON app.app_versions, app.articles, app.config_items TO couli_app;
GRANT SELECT ON app.app_versions, app.articles, app.config_items TO couli_readonly;
-- ADR-0001 §4.2 #20: payout reads its configuration directly from PostgreSQL.
GRANT SELECT ON app.config_items TO couli_payout;
