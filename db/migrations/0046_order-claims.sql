-- Up Migration
-- Order claims (找回): claims and claim_items (规划/04 §3.2 claims / claim_items, §2.3 找回枚举,
-- §2.5 claim_status; 08 BR-ATTR-17 / BR-ATTR-18 / BR-ATTR-22; 规划/12 §9 S-09). Task B1-10a; table
-- shape follows the orchestrator scope (口径 1-7) and ruling D10-56 in couli-runs/B1-10a brief.
-- Compatibility: additive. Two new ordinary (non-partitioned) tables in schema app with named
-- constraints / indexes and grants, plus one new named unique key on app.order_keys
-- (order_keys_claim_ref_key, built as a unique index then attached with UNIQUE USING INDEX under
-- the same name); no existing object changes, order_keys grants are untouched.
-- Recovery: restore from backup; no down migration.
--
-- Common: both tables carry app_id text NOT NULL and an application-generated UUIDv7 primary key
-- `id` (no database default). Foreign keys are named, carry app_id and never cascade. row_version
-- is incremented by the application (CAS); no trigger maintains it, decisions or deletion.
--
-- claims: one claim per submission. status has no default (the application writes 'submitted').
--   evidence_level is the weakest item evidence, NULL until computed: submitted <=> NULL,
--   auto_matched => strong, manual_review => weak / none (BR-ATTR-18; J-e); terminal states
--   need a level and accept any. created_at / updated_at come from the injected Clock without a
--   database default (J-b: the daily claim count is taken by accounting day from claims).
--   order_no is the user input with spaces removed, never empty and without half-width spaces;
--   pdd hyphens are kept (J-d). reason is free-text handling note, not a reason code (J-c).
--   platform references the platforms dictionary, no fixed list (J-j). claims_item_ref_key exists
--   only so claim_items can bind applicant and platform to its claim.
-- claim_items: one row per sub-order of a claim. The claim FK (app_id, claim_id,
--   applicant_user_id, platform) forces applicant and platform to equal the parent claim
--   (04: platform 取自所属 claim). The order FK (app_id, platform, sub_order_id, order_id) targets
--   the non-partitioned order_keys through order_keys_claim_ref_key, so the key must exist, in the
--   same app, and order_id must be that key's row (BR-ATTR-22; J-a). Unique (app_id,
--   applicant_user_id, platform, sub_order_id) whatever the decision (BR-ATTR-17).
--   evidence_link_log_ids is bigint[] of link_logs.id, a logical reference without FK (link_logs is
--   partitioned): NULL iff evidence is NULL, empty for 'none', non-empty for strong / weak, no NULL
--   element (J-f). decision NULL = pending; reject_reason present iff rejected; decided_at present
--   iff decided; decided_by is NULL while pending and also for system decisions (J-g).
--   created_at is the technical insert time (DEFAULT now(), as 0035); updated_at from the Clock.
-- Retention: none here (BR-ID-30 ⑰: keep until legal / finance confirm a period).
--
-- Grants: couli_app SELECT, INSERT on both tables and UPDATE only on the mutable columns
-- (claims: evidence_level, status, handler_admin_id, reason, row_version, updated_at;
-- claim_items: evidence, evidence_link_log_ids, decision, reject_reason, decided_by, decided_at,
-- row_version, updated_at). No DELETE, TRUNCATE, REFERENCES or TRIGGER for anyone. couli_readonly
-- SELECT on both.
--
-- Timeouts: the new tables are empty; the unique index on app.order_keys is built inside the
-- migration transaction (SHARE lock, blocks order_keys inserts while it builds) and the FKs take
-- short locks on users, admin_users, platforms and order_keys. 5s lock wait so a blocked deploy
-- fails fast, 60s overall as a ceiling for the order_keys index build.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE UNIQUE INDEX order_keys_claim_ref_key ON app.order_keys (app_id, platform, sub_order_id, order_id);

ALTER TABLE app.order_keys
  ADD CONSTRAINT order_keys_claim_ref_key UNIQUE USING INDEX order_keys_claim_ref_key;

CREATE TABLE app.claims (
  id               uuid NOT NULL,
  app_id           text NOT NULL,
  user_id          uuid NOT NULL,
  platform         text NOT NULL,
  order_no         text NOT NULL,
  order_no_type    text NOT NULL,
  paid_date        date NOT NULL,
  evidence_level   text,
  status           text NOT NULL,
  handler_admin_id uuid,
  reason           text,
  row_version      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  CONSTRAINT claims_pkey PRIMARY KEY (id),
  CONSTRAINT claims_item_ref_key UNIQUE (app_id, id, user_id, platform),
  CONSTRAINT claims_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT claims_platform_fkey FOREIGN KEY (platform)
    REFERENCES app.platforms (code),
  CONSTRAINT claims_handler_admin_fkey FOREIGN KEY (app_id, handler_admin_id)
    REFERENCES app.admin_users (app_id, id),
  CONSTRAINT claims_order_no_check CHECK (order_no <> '' AND strpos(order_no, ' ') = 0),
  CONSTRAINT claims_order_no_type_check CHECK (order_no_type IN ('sub', 'parent')),
  CONSTRAINT claims_evidence_level_check CHECK (evidence_level IN ('strong', 'weak', 'none')),
  CONSTRAINT claims_evidence_status_check CHECK (
    (status = 'submitted') = (evidence_level IS NULL)
    AND (status <> 'auto_matched' OR evidence_level = 'strong')
    AND (status <> 'manual_review' OR evidence_level IN ('weak', 'none'))
  ),
  CONSTRAINT claims_status_check CHECK (
    status IN ('submitted', 'auto_matched', 'manual_review', 'approved', 'rejected', 'cancelled')
  )
);

CREATE INDEX claims_user_created_idx ON app.claims (app_id, user_id, created_at DESC);
CREATE INDEX claims_review_queue_idx ON app.claims (app_id, status, created_at)
  WHERE status IN ('auto_matched', 'manual_review');

CREATE TABLE app.claim_items (
  id                    uuid NOT NULL,
  app_id                text NOT NULL,
  claim_id              uuid NOT NULL,
  applicant_user_id     uuid NOT NULL,
  platform              text NOT NULL,
  sub_order_id          text NOT NULL,
  order_id              uuid NOT NULL,
  evidence              text,
  evidence_link_log_ids bigint[],
  decision              text,
  reject_reason         text,
  decided_by            uuid,
  decided_at            timestamptz,
  row_version           integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL,
  CONSTRAINT claim_items_pkey PRIMARY KEY (id),
  CONSTRAINT claim_items_applicant_order_key
    UNIQUE (app_id, applicant_user_id, platform, sub_order_id),
  CONSTRAINT claim_items_claim_fkey FOREIGN KEY (app_id, claim_id, applicant_user_id, platform)
    REFERENCES app.claims (app_id, id, user_id, platform),
  CONSTRAINT claim_items_order_key_fkey FOREIGN KEY (app_id, platform, sub_order_id, order_id)
    REFERENCES app.order_keys (app_id, platform, sub_order_id, order_id),
  CONSTRAINT claim_items_decided_by_fkey FOREIGN KEY (app_id, decided_by)
    REFERENCES app.admin_users (app_id, id),
  CONSTRAINT claim_items_evidence_check CHECK (evidence IN ('strong', 'weak', 'none')),
  CONSTRAINT claim_items_evidence_links_check CHECK (
    (evidence IS NULL AND evidence_link_log_ids IS NULL)
    OR (
      evidence IS NOT NULL
      AND evidence_link_log_ids IS NOT NULL
      AND array_position(evidence_link_log_ids, NULL) IS NULL
      AND CASE
        WHEN evidence = 'none' THEN cardinality(evidence_link_log_ids) = 0
        ELSE cardinality(evidence_link_log_ids) > 0
      END
    )
  ),
  CONSTRAINT claim_items_decision_check CHECK (decision IN ('approved', 'rejected', 'cancelled')),
  CONSTRAINT claim_items_reject_reason_check CHECK (
    reject_reason IN (
      'NO_EVIDENCE', 'EXPIRED_CLICK', 'NOT_TRACKED', 'OTHER_TLJ', 'FRAUD', 'OTHER',
      'NOT_IN_POOL', 'ORDER_INVALID'
    )
  ),
  CONSTRAINT claim_items_reject_reason_pair_check CHECK (
    (decision IS NOT DISTINCT FROM 'rejected') = (reject_reason IS NOT NULL)
  ),
  CONSTRAINT claim_items_decided_pair_check CHECK (
    (decision IS NULL) = (decided_at IS NULL)
    AND (decision IS NOT NULL OR decided_by IS NULL)
  )
);

CREATE INDEX claim_items_pending_idx ON app.claim_items (app_id, platform, sub_order_id)
  WHERE decision IS NULL;
CREATE INDEX claim_items_claim_idx ON app.claim_items (app_id, claim_id);

GRANT SELECT, INSERT ON app.claims, app.claim_items TO couli_app;
GRANT UPDATE (evidence_level, status, handler_admin_id, reason, row_version, updated_at)
  ON app.claims TO couli_app;
GRANT UPDATE (evidence, evidence_link_log_ids, decision, reject_reason, decided_by, decided_at,
  row_version, updated_at) ON app.claim_items TO couli_app;
GRANT SELECT ON app.claims, app.claim_items TO couli_readonly;
