-- Up Migration
-- Agent result traces (08 BR-AI-05 细则「结果集保存本轮条件和卡片引用，价格只存在服务端」、
-- 序号引用 / 「再便宜点」; BR-AI-08 「该槽位已追问过 1 次」; SPEC_REF f411375). Task B3-09d; table
-- shapes follow the orchestrator's finalized tables and rulings in couli-runs/B3-09d brief §9.
-- Compatibility: additive. Three new append-only ordinary tables in schema app with named
-- constraints, indexes and grants, plus one new named unique key on app.agent_result_sets
-- (agent_result_sets_app_id_run_id_id_key, built as a unique index then attached with UNIQUE USING
-- INDEX under the same name, as 0046 did for order_keys); no column of an existing table changes
-- and existing grants are untouched.
-- Recovery: restore from backup; no down migration.
--
-- Common: every table carries app_id text NOT NULL, has no id column and no column default except
-- created_at DEFAULT now() (technical insert time; business moments come from the injected Clock).
-- Foreign keys are named, carry app_id and are NO ACTION (no cascade). Writer: agent (规划/02 §4.1).
-- Append-only by grants alone (as agent_result_sets / agent_cards in 0021): no UPDATE, DELETE or
-- TRUNCATE for any business role and no trigger. Retention deletion (BR-ID-30 ①) belongs to a
-- later task and goes through the (app_id, created_at) indexes.
--
-- agent_result_deliveries: one row per card handed out by a run, the server-side record behind
--   card_id references (ref_ordinal, card_id across turns) and replayed cards. The price
--   (final_price_fen, bigint fen) lives only here, never in agent_cards or in what the model sees
--   (BR-AI-05); 「再便宜点」 reads the minimum shown final_price_fen from here (BR-PRICE-15).
--   Primary key (app_id, session_id, card_id): card_id is a session-wide sequence never reused
--   (04 §8.2), so a second delivery of the same card in a session is a 23505 whichever run or set
--   it names. position (>= 1, the card's place in its result set) is not unique: concurrent
--   deliveries of different cards in one set must not collide; ordering is the store's (B3-09c).
--   The two composite foreign keys force run -> session and result set -> run to agree: (app_id,
--   session_id, run_id) -> agent_runs (app_id, session_id, id) and (app_id, run_id,
--   result_set_id) -> agent_result_sets (app_id, run_id, id), the latter through the new key.
--   platform is the contracts/enums/platform.yaml list (tmall is taobao's shop_type, not a
--   platform). card is the replay card JSON object; couli_readonly may read it (agent_cards.data
--   precedent).
-- agent_clarify_asks: one row per (chain, slot) the server has already asked a clarify for; the
--   primary key (app_id, session_id, chain_id, slot) is the "only once" guarantee, written with
--   INSERT … ON CONFLICT DO NOTHING RETURNING (one row = first ask). slot is reference / price /
--   platform.
-- agent_result_chains: the session's follow-up chain log. Each row is a new state of the chain the
--   session is on; the latest is the largest seq (writer takes max + 1 and retries on 23505).
--   status follows B3-05g SessionChain.status (searching / awaiting_price / has_products).
--   conditions are the chain's latest effective search conditions: NULL only while no result
--   exists yet (has_products requires them); when present they are a JSON object whose chain_id is
--   a string equal to the row's chain_id. conditions hold the user's search words, so
--   couli_readonly may not read that column (as agent_result_sets.conditions in 0021).
--
-- Grants: couli_app SELECT, INSERT on the three tables. couli_readonly SELECT on
-- agent_result_deliveries and agent_clarify_asks, and on every agent_result_chains column except
-- conditions. couli_payout and couli_maint get nothing.
--
-- Timeouts: the new tables are empty; the unique index on app.agent_result_sets is built inside the
-- migration transaction (SHARE lock, blocks result-set inserts while it builds, small table before
-- launch) and the foreign keys take short SHARE ROW EXCLUSIVE locks on agent_sessions, agent_runs
-- and agent_result_sets. 5s lock wait so a blocked deploy fails fast instead of queueing agent
-- traffic behind it, 60s overall as a ceiling for the index build.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE UNIQUE INDEX agent_result_sets_app_id_run_id_id_key
  ON app.agent_result_sets (app_id, run_id, id);

ALTER TABLE app.agent_result_sets
  ADD CONSTRAINT agent_result_sets_app_id_run_id_id_key
  UNIQUE USING INDEX agent_result_sets_app_id_run_id_id_key;

CREATE TABLE app.agent_result_deliveries (
  app_id          text NOT NULL,
  session_id      uuid NOT NULL,
  run_id          uuid NOT NULL,
  result_set_id   uuid NOT NULL,
  position        integer NOT NULL,
  card_id         text NOT NULL,
  product_key     text NOT NULL,
  platform        text NOT NULL,
  final_price_fen bigint NOT NULL,
  card            jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_result_deliveries_pkey PRIMARY KEY (app_id, session_id, card_id),
  CONSTRAINT agent_result_deliveries_run_fkey FOREIGN KEY (app_id, session_id, run_id)
    REFERENCES app.agent_runs (app_id, session_id, id),
  CONSTRAINT agent_result_deliveries_result_set_fkey FOREIGN KEY (app_id, run_id, result_set_id)
    REFERENCES app.agent_result_sets (app_id, run_id, id),
  CONSTRAINT agent_result_deliveries_position_check CHECK (position >= 1),
  -- 04 §8.3 card_id, same pattern as agent_cards_card_id_check (anchored).
  CONSTRAINT agent_result_deliveries_card_id_check CHECK (card_id ~ '^c[1-9][0-9]*$'),
  CONSTRAINT agent_result_deliveries_product_key_check CHECK (product_key <> ''),
  -- contracts/enums/platform.yaml platform
  CONSTRAINT agent_result_deliveries_platform_check CHECK (platform IN (
    'taobao', 'jd', 'pdd', 'meituan', 'vip', 'douyin', 'eleme', 'kuaishou', 'suning'
  )),
  CONSTRAINT agent_result_deliveries_final_price_fen_check CHECK (final_price_fen >= 0),
  CONSTRAINT agent_result_deliveries_card_check CHECK (jsonb_typeof(card) = 'object')
);

CREATE INDEX agent_result_deliveries_result_set_idx
  ON app.agent_result_deliveries (app_id, run_id, result_set_id);
CREATE INDEX agent_result_deliveries_created_idx
  ON app.agent_result_deliveries (app_id, created_at);

CREATE TABLE app.agent_clarify_asks (
  app_id     text NOT NULL,
  session_id uuid NOT NULL,
  chain_id   text NOT NULL,
  slot       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_clarify_asks_pkey PRIMARY KEY (app_id, session_id, chain_id, slot),
  CONSTRAINT agent_clarify_asks_session_fkey FOREIGN KEY (app_id, session_id)
    REFERENCES app.agent_sessions (app_id, id),
  CONSTRAINT agent_clarify_asks_chain_id_check CHECK (chain_id <> ''),
  CONSTRAINT agent_clarify_asks_slot_check CHECK (slot IN ('reference', 'price', 'platform'))
);

CREATE INDEX agent_clarify_asks_created_idx ON app.agent_clarify_asks (app_id, created_at);

CREATE TABLE app.agent_result_chains (
  app_id     text NOT NULL,
  session_id uuid NOT NULL,
  seq        integer NOT NULL,
  chain_id   text NOT NULL,
  status     text NOT NULL,
  conditions jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_result_chains_pkey PRIMARY KEY (app_id, session_id, seq),
  CONSTRAINT agent_result_chains_session_fkey FOREIGN KEY (app_id, session_id)
    REFERENCES app.agent_sessions (app_id, id),
  CONSTRAINT agent_result_chains_seq_check CHECK (seq >= 1),
  CONSTRAINT agent_result_chains_chain_id_check CHECK (chain_id <> ''),
  -- B3-05g SessionChain.status
  CONSTRAINT agent_result_chains_status_check
    CHECK (status IN ('searching', 'awaiting_price', 'has_products')),
  -- A JSON object whose chain_id is a string equal to the row's chain_id ('{}' and
  -- {"chain_id": null} fail); CASE keeps the jsonb operators away from scalars and arrays and
  -- COALESCE turns any NULL comparison into a 23514 instead of a pass.
  CONSTRAINT agent_result_chains_conditions_check CHECK (
    conditions IS NULL OR COALESCE(CASE
      WHEN jsonb_typeof(conditions) = 'object' THEN
        jsonb_typeof(conditions -> 'chain_id') = 'string'
        AND (conditions ->> 'chain_id') = chain_id
      ELSE false
    END, false)
  ),
  CONSTRAINT agent_result_chains_has_products_check
    CHECK (status <> 'has_products' OR conditions IS NOT NULL)
);

CREATE INDEX agent_result_chains_created_idx ON app.agent_result_chains (app_id, created_at);

GRANT SELECT, INSERT ON
  app.agent_result_deliveries, app.agent_clarify_asks, app.agent_result_chains
  TO couli_app;

GRANT SELECT ON app.agent_result_deliveries, app.agent_clarify_asks TO couli_readonly;
GRANT SELECT (app_id, session_id, seq, chain_id, status, created_at)
  ON app.agent_result_chains TO couli_readonly;
