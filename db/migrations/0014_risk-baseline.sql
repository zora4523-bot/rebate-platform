-- Up Migration
-- Risk baseline (规划/04 §2.5 risk_state / appeal_status, §3.2 rows risk_rules / risk_hits,
-- blocklist, user_risk_state, appeals; BR-ID-31, BR-ID-36 incl. 细则「被拦截请求申诉」,
-- BR-ATTR-26; contracts/enums/identity.yaml risk_state, appeal_status, appeal_target_type,
-- blocked_request_type (CT-02d); SPEC_REF 1955639; ADR-0001 §4).
-- Compatibility: additive (five new tables). Recovery: restore from backup; no down migration.
-- Writer of all five tables: risk (规划/02 §4.1). Entity UUIDs are UUIDv7 supplied by the
-- application; risk_hits uses an internal identity key (ADR-0001 §4.2 #1). User references
-- include app_id and never cascade. app_id is text as in 0003/0005; apps foreign keys await
-- the apps baseline. All five tables are unpartitioned.
-- Single-column CHECKs carry exactly the contract / 08 value sets; rules spanning columns are
-- separate CHECKs. Actor columns (blocklist.created_by, user_risk_state.changed_by,
-- appeals.handler_id) are opaque actor identifiers in text, as payout_account_changes.operator
-- and config_items.updated_by: there is no admin_users table yet.
-- Business moments (changed_at, frozen_until, deadline_at, closed_at, expire_at, start_at,
-- end_at) have no SQL clock default and come from the injected Clock (ADR-0001 §4.2 #10).
-- Where created_at is a business moment (blocklist 登记时间, appeals 提交时刻 that deadline_at
-- counts from, risk_hits 命中时间), risk writes it from the Clock in the creating INSERT as
-- sessions in 0013; the default is only a fallback (SQL now() would record the wrong moment
-- under the compressed staging clock).
-- CAS (ADR-0001 §4.1): blocklist, user_risk_state, appeals and risk_rules start row_version
-- at 0; writers compare the old state and version and increment row_version in the same
-- UPDATE. No trigger performs a business transition.
--
-- blocklist (BR-ID-31 account side, BR-ATTR-26 order side; one table for both). This
-- migration fixes the dimension codes and the storage that 04 §3.2 leaves to B1-03 (to be
-- written back into the 04 blocklist row):
--   account side: phone, id_no, alipay, bank_card, wechat_openid, device, relation_id. The
--     three payout dimensions mirror payout_accounts.alipay_hmac / bank_card_hmac /
--     wechat_openid_hmac, so the dimension also says which normalization the admin import
--     applied before the HMAC (BR-ID-31 细则; 08 counts them as one 收款账号 dimension).
--     The value is stored ONLY as value_hmac (value IS NULL), computed from the normalized
--     input (phone: BR-ID-05 细则「手机号规范化」; alipay / bank card: BR-WDR-02 细则); device
--     stores the device hash itself (64 lowercase hex, BR-ID-09), checked by
--     blocklist_device_check. Every account entry records expire_at (BR-ID-31, BR-ID-30) and
--     has no order-side columns.
--   order side: order_no_suffix (platform must be taobao, value is the 6-character suffix
--     compared character by character with the last 6 characters of trade_parent_id) and
--     channel (value is the relation_id compared by equality, with union_account_id and the
--     half-open [start_at, end_at) window compared with attr_at). The value is stored as
--     plain text in value and value_hmac IS NULL: matching works on the value as BR-ATTR-26
--     describes, and risk computes the HMAC of the matched value for risk_hits. expire_at is
--     optional here; start_at / end_at / union_account_id belong to channel only.
-- Duplicate entries (same dimension and value): whether a second registration overwrites or
-- is rejected has no default in 规划 (06), so there is deliberately NO unique constraint; the
-- two lookup indexes are not unique. Entries are never deleted by couli_app: deactivation
-- sets status=inactive (BR-ATTR-26), and the BR-ID-36 revocation "moves the entry out" the
-- same way. Retention deletion (BR-ID-30 ⑪) is a later task under its own grant. Matching is
-- independent of users (no user foreign key) and survives account deletion (BR-ID-31).
-- union_account_id references union_accounts, whose baseline (and foreign key) comes later.
-- Platform stays open text as orders.platform (0007). violation_type follows BR-ID-31.
-- couli_app may update value_hmac, value, violation_type, reason, end_at, expire_at and
-- status (BR-ID-31 细则 edits the value; BR-ATTR-26 sets end_at later and deactivates);
-- dimension, platform, union_account_id and start_at have no change scenario in 08 and stay
-- as inserted (db/AGENTS.md #4).
--
-- user_risk_state: the only store of risk_state (04 §2.5; 08's users.risk_state is
-- user_risk_state.state). Primary key user_id as in 04. A user without a row is normal: users
-- rows are written by identity, so risk inserts the row on the first change. frozen_until is
-- NULL for an indefinite freeze; banned never has an end (BR-ID-31) and normal has no
-- deadline, so frozen_until is allowed only while frozen or appealing (an account appeal keeps
-- the freeze deadline for an upheld result that restores prev_risk_state). reason is the
-- internal reason (admin only); reason_category is the user-visible category, one of the five
-- codes of BR-TEXT-23 细则「原因类别」 (malicious_rights, fraud_invite, abnormal_trade,
-- account_security, other; dictionary risk_reason.<category>), chosen whenever the account is
-- banned or frozen ("后台封禁、冻结…时必选一项"), so it is required unless state=normal
-- (appealing keeps the category of the appealed state). couli_payout reads only
-- (app_id, user_id, state) for the
-- member_blocked recheck (BR-WDR-13 ③, BR-WDR-05: any appealing is a block, so payout needs
-- neither prev_risk_state nor frozen_until).
--
-- appeals (BR-ID-36): target_type / request_type / status / prev_risk_state follow the
-- contract enums. target_id is text: an account appeal names the user (target_id must equal
-- user_id::text), an order appeal the order_id (canonical lowercase UUID, CHECKed, so a case
-- variant of the same order cannot slip past the partial unique index), a blocked_request
-- appeal the blocked-request number (= risk_hits.ref_id, see risk_hits).
-- related_phone_hmac is the HMAC of the related phone number (关联手机号, normalized as
-- BR-ID-05) of a blocked_request appeal, never the number itself; it is required for the
-- register and phone_change types (the submitted number always exists) and optional for
-- withdraw and payout_account (the account's current phone, which may be unbound).
-- At most one processing appeal per object: partial unique (app_id, target_type, target_id)
-- WHERE status='processing'; register appeals additionally one per related phone: partial
-- unique (app_id, related_phone_hmac) WHERE status='processing' AND request_type='register'.
-- Closing (upheld / revoked) is one-way and sets closed_at and handler_id; a later appeal on
-- the same object is then allowed. A concurrent second submission fails with 23505 and the
-- caller returns the existing processing appeal (BR-ID-36). The order appeal flag
-- (appeal_pending) is derived from the target index. Only status, handler_id, closed_at and
-- the version columns are updatable.
--
-- risk_rules: rule_id is the rule's business code, unique per app; risk_hits references it
-- by (app_id, rule_id). Consequence of that foreign key: every rule code that can hit (seeded
-- hard rules included, 规划/02 risk/ seeds) must already have a row under EACH app_id, or
-- writing the hit fails with 23503 and the surrounding transaction rolls back (including the
-- blocked request's own result). risk can register a missing code first with
-- INSERT ... ON CONFLICT (app_id, rule_id) DO NOTHING. A rule has one row that is changed in
-- place: version is the rule's own version number set by risk, row_version the CAS counter;
-- hits do not record the version. conditions holds the condition JSON (04 条件 JSON); its keys
-- belong to risk. scene and status are open text: 04 and 08 give no closed vocabulary for
-- them. Rules are not deleted (no DELETE grant); hits keep their rule.
--
-- risk_hits (BR-ID-36): insert-only, enforced by grants (couli_app has SELECT and column
-- INSERT, never UPDATE or DELETE). As login_logs / consent_records, no trigger, so a later
-- retention task (not yet set in BR-ID-30; rows hold a phone HMAC and masked number) can
-- remove rows under its own grant. Every hit records dimension and value_hmac (the HMAC of
-- the hit value, never plaintext; for device the device hash). dimension is open text: hits
-- also come from non-blocklist rules (device or IP limits, BR-ID-05, BR-ID-32); blocklist
-- hits use the blocklist dimension codes. ref_type in {order, withdrawal, blocked_request}
-- (BR-ID-36 关联对象); other referenced objects (e.g. invite-binding hits, BR-INV-08/09) get a
-- value in the migration of the task that writes them. ref_id is text: the order or
-- withdrawal UUID, or the blocked-request number shown to admins, which risk generates as a
-- UUIDv7 before inserting; all hit rows of the same request share it, so ref_id is not unique.
-- A blocked_request row (44001) records request_type (contract blocked_request_type) when the
-- interception has a type; request_type appears only on blocked_request rows but is not
-- required there. That is a deliberate opening for interceptions without a defined type yet,
-- e.g. a third-party first login refused by the same-device registration limit (BR-ID-05):
-- 规划/06 第 22 项 ③ only exempts such requests from appeal registration, not from the hit
-- record BR-ID-36 requires for every hit. appeals keeps request_type mandatory for
-- blocked_request, because these requests cannot be appealed.
-- user_id is NULL for register and the requester for the other types (unconstrained when the
-- type is missing); amount_fen (positive integer fen) only and always for withdraw;
-- related_phone_hmac / related_phone_masked (BR-ID-33: HMAC plus masked number, no plaintext
-- column) are required for register and phone_change, an optional pair on the other
-- blocked_request rows (withdraw, payout_account, or no type), absent on order / withdrawal
-- rows. created_at is the hit moment, written by risk from the injected Clock (couli_app's
-- column INSERT includes it); there is no UPDATE or DELETE, so it cannot change afterwards.
--
-- Grants: couli_app gets what the single writer needs; couli_readonly reads all five tables;
-- couli_payout reads user_risk_state (app_id, user_id, state) only; couli_maint gets nothing.
--
-- To be written back into 规划/04 §3.2 (choices this migration makes where 04 / 08 defer to
-- B1-03 or the contract line), plus one 规划 gap:
--   1. blocklist dimension codes and storage as described above (account side HMAC only with
--      expire_at; order side plain value, value_hmac NULL; order_no_suffix platform=taobao,
--      6 characters; channel union_account_id + [start_at, end_at)).
--   2. Account appeal: target_id = user_id.
--   3. Blocked-request field names: risk_hits.request_type, related_phone_hmac,
--      related_phone_masked, amount_fen; appeals.related_phone_hmac.
--   4. risk_hits.ref_type codes: order, withdrawal, blocked_request.
--   5. Condition JSON column name: risk_rules.conditions.
--   6. Gap: risk_hits stores a masked phone number and a phone HMAC, but BR-ID-30 sets no
--      retention period for it.
--   7. risk_rules versions only change in place (one row per rule code); hits do not record
--      the version.
--   8. The blocked-request number (risk_hits.ref_id) is a UUIDv7 generated by the application
--      before the insert and shared by all hit rows of the same request.

CREATE TABLE app.blocklist (
  id               uuid NOT NULL,
  app_id           text NOT NULL,
  dimension        text NOT NULL,
  value_hmac       text,
  value            text,
  violation_type   text NOT NULL,
  reason           text,
  platform         text,
  union_account_id uuid,
  start_at         timestamptz,
  end_at           timestamptz,
  expire_at        timestamptz,
  status           text NOT NULL,
  created_by       text NOT NULL,
  row_version      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blocklist_pkey PRIMARY KEY (id),
  CONSTRAINT blocklist_dimension_check CHECK (
    dimension IN (
      'phone', 'id_no', 'alipay', 'bank_card', 'wechat_openid', 'device', 'relation_id',
      'order_no_suffix', 'channel'
    )
  ),
  CONSTRAINT blocklist_violation_type_check
    CHECK (violation_type IN ('malicious_rights', 'fraud_invite', 'other')),
  CONSTRAINT blocklist_status_check CHECK (status IN ('active', 'inactive')),
  -- Account side: HMAC only. Order side: plain value, no HMAC (see the header).
  CONSTRAINT blocklist_storage_check CHECK (
    CASE WHEN dimension IN ('order_no_suffix', 'channel')
      THEN value IS NOT NULL AND value_hmac IS NULL
      ELSE value_hmac IS NOT NULL AND value IS NULL
    END
  ),
  CONSTRAINT blocklist_account_expire_check
    CHECK (dimension IN ('order_no_suffix', 'channel') OR expire_at IS NOT NULL),
  CONSTRAINT blocklist_platform_check
    CHECK ((dimension IN ('order_no_suffix', 'channel')) = (platform IS NOT NULL)),
  CONSTRAINT blocklist_order_no_suffix_check CHECK (
    dimension <> 'order_no_suffix' OR (platform = 'taobao' AND char_length(value) = 6)
  ),
  CONSTRAINT blocklist_channel_check CHECK (
    CASE WHEN dimension = 'channel'
      THEN union_account_id IS NOT NULL AND start_at IS NOT NULL
        AND (end_at IS NULL OR end_at > start_at)
      ELSE union_account_id IS NULL AND start_at IS NULL AND end_at IS NULL
    END
  ),
  CONSTRAINT blocklist_device_check
    CHECK (dimension <> 'device' OR value_hmac ~ '^[0-9a-f]{64}$')
);

-- Matching: account side by HMAC, order side by value (BR-ID-31, BR-ATTR-26). Not unique.
CREATE INDEX blocklist_value_hmac_idx ON app.blocklist (app_id, dimension, value_hmac)
  WHERE value_hmac IS NOT NULL;
CREATE INDEX blocklist_value_idx ON app.blocklist (app_id, dimension, value)
  WHERE value IS NOT NULL;

CREATE TABLE app.user_risk_state (
  user_id         uuid NOT NULL,
  app_id          text NOT NULL,
  state           text NOT NULL,
  reason          text,
  reason_category text,
  frozen_until    timestamptz,
  changed_by      text NOT NULL,
  changed_at      timestamptz NOT NULL,
  row_version     integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_risk_state_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_risk_state_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT user_risk_state_state_check
    CHECK (state IN ('normal', 'frozen', 'appealing', 'banned')),
  -- BR-TEXT-23 细则「原因类别」 (dictionary risk_reason.<category>).
  CONSTRAINT user_risk_state_reason_category_check CHECK (
    reason_category IN (
      'malicious_rights', 'fraud_invite', 'abnormal_trade', 'account_security', 'other'
    )
  ),
  CONSTRAINT user_risk_state_reason_category_required_check
    CHECK (state = 'normal' OR reason_category IS NOT NULL),
  CONSTRAINT user_risk_state_frozen_until_check
    CHECK (frozen_until IS NULL OR state IN ('frozen', 'appealing'))
);

-- Freeze expiry task and the 30-day alert for indefinite freezes (BR-ID-36).
CREATE INDEX user_risk_state_state_idx ON app.user_risk_state (app_id, state, frozen_until);

CREATE TABLE app.appeals (
  id                 uuid NOT NULL,
  app_id             text NOT NULL,
  user_id            uuid,
  target_type        text NOT NULL,
  request_type       text,
  target_id          text NOT NULL,
  related_phone_hmac text,
  prev_risk_state    text,
  status             text NOT NULL,
  content            text NOT NULL,
  deadline_at        timestamptz NOT NULL,
  handler_id         text,
  closed_at          timestamptz,
  row_version        integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appeals_pkey PRIMARY KEY (id),
  CONSTRAINT appeals_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT appeals_target_type_check
    CHECK (target_type IN ('account', 'order', 'blocked_request')),
  CONSTRAINT appeals_request_type_check
    CHECK (request_type IN ('register', 'withdraw', 'phone_change', 'payout_account')),
  CONSTRAINT appeals_status_check CHECK (status IN ('processing', 'upheld', 'revoked')),
  CONSTRAINT appeals_request_check
    CHECK ((target_type = 'blocked_request') = (request_type IS NOT NULL)),
  CONSTRAINT appeals_user_check CHECK (
    CASE WHEN request_type = 'register' THEN user_id IS NULL ELSE user_id IS NOT NULL END
  ),
  CONSTRAINT appeals_account_target_check
    CHECK (target_type <> 'account' OR target_id = user_id::text),
  -- Canonical lowercase UUID, so a case variant of the same order cannot bypass the index.
  CONSTRAINT appeals_order_target_check CHECK (
    target_type <> 'order'
    OR target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  -- Account appeals keep banned or frozen; order and blocked_request appeals keep nothing.
  CONSTRAINT appeals_prev_risk_state_check CHECK (
    CASE WHEN target_type = 'account'
      THEN prev_risk_state IS NOT NULL AND prev_risk_state IN ('banned', 'frozen')
      ELSE prev_risk_state IS NULL
    END
  ),
  CONSTRAINT appeals_related_phone_check CHECK (
    CASE
      WHEN request_type IN ('register', 'phone_change') THEN related_phone_hmac IS NOT NULL
      WHEN request_type IS NULL THEN related_phone_hmac IS NULL
      ELSE true
    END
  ),
  CONSTRAINT appeals_closed_check CHECK ((status = 'processing') = (closed_at IS NULL)),
  CONSTRAINT appeals_handler_check CHECK (status = 'processing' OR handler_id IS NOT NULL)
);

-- BR-ID-36: one processing appeal per object; register appeals also one per related phone.
CREATE UNIQUE INDEX appeals_processing_target_key
  ON app.appeals (app_id, target_type, target_id)
  WHERE status = 'processing';
CREATE UNIQUE INDEX appeals_processing_register_phone_key
  ON app.appeals (app_id, related_phone_hmac)
  WHERE status = 'processing' AND request_type = 'register';
-- GET /v1/me/appeals and the overdue alert on deadline_at (BR-ID-36).
CREATE INDEX appeals_user_idx ON app.appeals (app_id, user_id, created_at DESC);
CREATE INDEX appeals_processing_deadline_idx ON app.appeals (app_id, deadline_at)
  WHERE status = 'processing';

CREATE TABLE app.risk_rules (
  id          uuid NOT NULL,
  app_id      text NOT NULL,
  rule_id     text NOT NULL,
  scene       text NOT NULL,
  conditions  jsonb NOT NULL,
  risk_action text NOT NULL,
  status      text NOT NULL,
  version     integer NOT NULL,
  row_version integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_rules_pkey PRIMARY KEY (id),
  CONSTRAINT risk_rules_rule_id_key UNIQUE (app_id, rule_id),
  CONSTRAINT risk_rules_risk_action_check
    CHECK (risk_action IN ('pass', 'manual_review', 'block', 'void_commission'))
);

CREATE TABLE app.risk_hits (
  id                   bigint GENERATED ALWAYS AS IDENTITY,
  app_id               text NOT NULL,
  user_id              uuid,
  rule_id              text NOT NULL,
  risk_action          text NOT NULL,
  dimension            text NOT NULL,
  value_hmac           text NOT NULL,
  ref_type             text NOT NULL,
  ref_id               text NOT NULL,
  request_type         text,
  related_phone_hmac   text,
  related_phone_masked text,
  amount_fen           bigint,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_hits_pkey PRIMARY KEY (id),
  CONSTRAINT risk_hits_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT risk_hits_rule_fkey FOREIGN KEY (app_id, rule_id)
    REFERENCES app.risk_rules (app_id, rule_id),
  CONSTRAINT risk_hits_risk_action_check
    CHECK (risk_action IN ('pass', 'manual_review', 'block', 'void_commission')),
  CONSTRAINT risk_hits_ref_type_check
    CHECK (ref_type IN ('order', 'withdrawal', 'blocked_request')),
  CONSTRAINT risk_hits_request_type_check
    CHECK (request_type IN ('register', 'withdraw', 'phone_change', 'payout_account')),
  -- A blocked_request row may lack a type for interceptions without one yet (see the header).
  CONSTRAINT risk_hits_request_check
    CHECK (request_type IS NULL OR ref_type = 'blocked_request'),
  CONSTRAINT risk_hits_user_check CHECK (
    CASE
      WHEN request_type = 'register' THEN user_id IS NULL
      WHEN request_type IS NOT NULL THEN user_id IS NOT NULL
      ELSE true
    END
  ),
  CONSTRAINT risk_hits_amount_check CHECK (
    CASE WHEN request_type = 'withdraw'
      THEN amount_fen IS NOT NULL AND amount_fen > 0
      ELSE amount_fen IS NULL
    END
  ),
  CONSTRAINT risk_hits_related_phone_check CHECK (
    CASE
      WHEN request_type IN ('register', 'phone_change')
        THEN related_phone_hmac IS NOT NULL AND related_phone_masked IS NOT NULL
      WHEN ref_type <> 'blocked_request'
        THEN related_phone_hmac IS NULL AND related_phone_masked IS NULL
      ELSE (related_phone_hmac IS NULL) = (related_phone_masked IS NULL)
    END
  )
);

-- Admin lookup of blocked requests by number, by full phone (HMAC) or by UID (BR-ID-36 细则).
CREATE INDEX risk_hits_ref_idx ON app.risk_hits (app_id, ref_type, ref_id);
CREATE INDEX risk_hits_related_phone_idx ON app.risk_hits (app_id, related_phone_hmac)
  WHERE related_phone_hmac IS NOT NULL;
CREATE INDEX risk_hits_user_idx ON app.risk_hits (app_id, user_id)
  WHERE user_id IS NOT NULL;

GRANT SELECT, INSERT ON app.blocklist, app.user_risk_state, app.appeals, app.risk_rules
  TO couli_app;
GRANT UPDATE (
  value_hmac, value, violation_type, reason, end_at, expire_at, status, row_version, updated_at
) ON app.blocklist TO couli_app;
GRANT UPDATE (
  state, reason, reason_category, frozen_until, changed_by, changed_at, row_version, updated_at
) ON app.user_risk_state TO couli_app;
GRANT UPDATE (status, handler_id, closed_at, row_version, updated_at) ON app.appeals
  TO couli_app;
GRANT UPDATE (scene, conditions, risk_action, status, version, row_version, updated_at)
  ON app.risk_rules TO couli_app;
GRANT SELECT ON app.risk_hits TO couli_app;
-- Insert-only; id is an identity; created_at is the Clock hit moment (see the header).
GRANT INSERT (
  app_id, user_id, rule_id, risk_action, dimension, value_hmac, ref_type, ref_id,
  request_type, related_phone_hmac, related_phone_masked, amount_fen, created_at
) ON app.risk_hits TO couli_app;
GRANT SELECT ON app.blocklist, app.user_risk_state, app.appeals, app.risk_rules, app.risk_hits
  TO couli_readonly;
-- BR-WDR-13 ③ member_blocked recheck (BR-WDR-05): the state only.
GRANT SELECT (app_id, user_id, state) ON app.user_risk_state TO couli_payout;
