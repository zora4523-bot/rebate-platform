-- Up Migration
-- Rule knowledge chunks for the agent's rule answers (规划/08 BR-AI-04 数字与结果的数据来源, BR-AI-07
-- rule_ref excerpt ≤ 200 字; 规划/04 §3.2 rule_chunks; SPEC_REF 17b5fe5). Task B3-08e; table shape
-- follows the orchestrator's finalized table in couli-runs/B3-08e brief §9 / §11 and ruling D10-194
-- option C (MVP keeps no embedding column: no vector column and no extension here; the embedding
-- column comes in its own later migration once the owner picks a model).
-- Compatibility: additive. One new ordinary table in schema app with named constraints, one index,
-- one prohibitive guard trigger and its function, and grants. No existing table, column, constraint
-- or grant changes; the foreign key only takes a short SHARE ROW EXCLUSIVE lock on app.articles.
-- Recovery: restore from backup; no down migration.
--
-- app.rule_chunks: one row per chunk of one published revision of a help / rule article (which
--   articles qualify and how they are split is the sync's job, B3-08i, not checked here).
--   Writer: agent (规划/02 §4.1). Columns:
--   chunk_id: uuid primary key with no default (UUIDv7 from the application's ID generator,
--     db/AGENTS.md rule 6; contracts card_rule_ref.chunk_id is an entity_id).
--   app_id: text NOT NULL (business-table rule).
--   article_id, published_version: the article revision the chunk was cut from. Composite foreign
--     key (article_id, published_version) → app.articles (id, version), the articles primary key
--     (id alone is not unique: one row per version). NO ACTION on delete and update, no cascade
--     (db/AGENTS.md rule 7). published_version >= 1 as articles.version.
--   seq: the chunk's position inside that revision, >= 0. UNIQUE (article_id, published_version,
--     seq): a revision is never chunked twice into the same slot; another revision may reuse seq.
--   title, text: the article title and the chunk body shown verbatim on the rule card; both
--     non-empty, text at most 200 characters (char_length, so counted in characters, not bytes;
--     same limit as the BR-AI-07 rule_ref excerpt).
--   status: active / retired, DEFAULT 'active'. retired_at: when the chunk was retired (from the
--     injected Clock; no SQL default). CHECK (status = 'retired') = (retired_at IS NOT NULL) keeps
--     the two in step on INSERT and UPDATE alike.
--   created_at: technical insert time, DEFAULT now().
--   Index (app_id, status) for the active-chunk lookup of the rule search (B3-08b).
--
-- Guard (prohibitive only, db/AGENTS.md rule 8; same form as the agent_* guards in 0021): a BEFORE
--   UPDATE trigger raises restrict_violation (23001) unless every column other than status and
--   retired_at is unchanged AND the row either keeps status and retired_at as they are (an
--   identical replay, e.g. re-retiring a retired chunk with the same timestamp) or goes from
--   active with no retired_at to retired with a non-NULL retired_at in the same statement. So
--   status alone, retired_at alone, retired → active, clearing or moving retired_at are refused.
--   The column grants below already stop couli_app from touching any other column (42501).
--
-- Grants: couli_app SELECT, INSERT and UPDATE (status, retired_at) only; no DELETE, TRUNCATE,
--   REFERENCES or TRIGGER. couli_readonly SELECT on every column except the free-text title and
--   text (04 通则: the read-only role gets no free-text columns). couli_payout and couli_maint get
--   nothing. The guard function is not executable by PUBLIC (as in 0021).
--
-- Timeouts: the table is new and empty, so its index and unique key build instantly; the foreign
--   key takes a short SHARE ROW EXCLUSIVE lock on app.articles. 5s lock wait so a blocked deploy
--   fails fast instead of queueing article publishing behind it, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.rule_chunks (
  chunk_id          uuid NOT NULL,
  app_id            text NOT NULL,
  article_id        uuid NOT NULL,
  published_version integer NOT NULL,
  seq               integer NOT NULL,
  title             text NOT NULL,
  "text"            text NOT NULL,
  status            text NOT NULL DEFAULT 'active',
  created_at        timestamptz NOT NULL DEFAULT now(),
  retired_at        timestamptz,
  CONSTRAINT rule_chunks_pkey PRIMARY KEY (chunk_id),
  CONSTRAINT rule_chunks_article_fkey FOREIGN KEY (article_id, published_version)
    REFERENCES app.articles (id, version) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT rule_chunks_article_id_published_version_seq_key
    UNIQUE (article_id, published_version, seq),
  CONSTRAINT rule_chunks_published_version_check CHECK (published_version >= 1),
  CONSTRAINT rule_chunks_seq_check CHECK (seq >= 0),
  CONSTRAINT rule_chunks_title_check CHECK (title <> ''),
  CONSTRAINT rule_chunks_text_check CHECK ("text" <> '' AND char_length("text") <= 200),
  CONSTRAINT rule_chunks_status_check CHECK (status IN ('active', 'retired')),
  CONSTRAINT rule_chunks_retired_at_check CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

CREATE INDEX rule_chunks_app_id_status_idx ON app.rule_chunks (app_id, status);

-- Prohibitive trigger only (db/AGENTS.md rule 8), raising restrict_violation (23001).
CREATE FUNCTION app.reject_rule_chunk_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF ROW(NEW.chunk_id, NEW.app_id, NEW.article_id, NEW.published_version, NEW.seq, NEW.title,
         NEW."text", NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.chunk_id, OLD.app_id, OLD.article_id, OLD.published_version, OLD.seq, OLD.title,
          OLD."text", OLD.created_at)
    OR NOT (
      (
        NEW.status IS NOT DISTINCT FROM OLD.status
        AND NEW.retired_at IS NOT DISTINCT FROM OLD.retired_at
      )
      OR (
        OLD.status = 'active'
        AND OLD.retired_at IS NULL
        AND NEW.status = 'retired'
        AND NEW.retired_at IS NOT NULL
      )
    )
  THEN
    RAISE EXCEPTION 'rule_chunks content is immutable; status may only go active -> retired together with retired_at'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_rule_chunk_rewrite() FROM PUBLIC;

CREATE TRIGGER rule_chunks_no_rewrite
  BEFORE UPDATE ON app.rule_chunks
  FOR EACH ROW EXECUTE FUNCTION app.reject_rule_chunk_rewrite();

GRANT SELECT, INSERT ON app.rule_chunks TO couli_app;
GRANT UPDATE (status, retired_at) ON app.rule_chunks TO couli_app;

GRANT SELECT (chunk_id, app_id, article_id, published_version, seq, status, created_at, retired_at)
  ON app.rule_chunks TO couli_readonly;
