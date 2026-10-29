-- Up Migration
-- Share materials of a share link (08 BR-ATTR-10 细则「分享页与分享赚入口页」「中间页的口令按打开环境区分」;
-- orchestrator ruling D10-426). Task B1-15v; POST /v1/shares that writes it is B1-15w.
-- Compatibility: additive. One new empty table, named constraints, a foreign key to app.links, the
-- append-only guard trigger (app.reject_update_delete() of 0003), grants.
-- Recovery: restore from backup; no down migration.
--
-- share_materials: one row per share link (app.links with pid_scene = 'share'), generated once when
--   POST /v1/shares registers the link, under the sharer's identity. link_id is the primary key and
--   references app.links(link_id) (no cascade, db/AGENTS.md rule 7); that the link is a share link
--   is checked by the writer, not by the database. share_url is the sharer's converted short link,
--   never empty. tpwd is the Taobao token, NULL for platforms without one, never ''; it is handed
--   out only when the share page asks for the token. created_at is the technical insert time.
--   Written only by the linking module (couli_app), insert-only: a repeated generation for the same
--   link is idempotent through share_materials_pkey and ON CONFLICT DO NOTHING; never updated or
--   deleted.
-- Retention: none here.
--
-- Grants: couli_app SELECT, INSERT (no UPDATE / DELETE / TRUNCATE: insert-only, the trigger rejects
-- UPDATE and DELETE for every role as a second line of defence); couli_readonly SELECT, as for every
-- linking table. couli_payout and couli_maint get nothing.
--
-- Timeouts: only a new, empty table and its trigger are created; the foreign key takes a short
-- SHARE ROW EXCLUSIVE lock on app.links and validates nothing (the new table is empty). 5s lock wait
-- so a blocked deploy fails fast, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.share_materials (
  app_id     text NOT NULL,
  link_id    uuid NOT NULL,
  share_url  text NOT NULL,
  tpwd       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT share_materials_pkey PRIMARY KEY (link_id),
  CONSTRAINT share_materials_link_id_fkey FOREIGN KEY (link_id) REFERENCES app.links (link_id),
  CONSTRAINT share_materials_app_id_check CHECK (app_id <> ''),
  CONSTRAINT share_materials_share_url_check CHECK (share_url <> ''),
  CONSTRAINT share_materials_tpwd_check CHECK (tpwd <> '')
);

CREATE TRIGGER share_materials_append_only
  BEFORE UPDATE OR DELETE ON app.share_materials
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

GRANT SELECT, INSERT ON app.share_materials TO couli_app;
GRANT SELECT ON app.share_materials TO couli_readonly;
