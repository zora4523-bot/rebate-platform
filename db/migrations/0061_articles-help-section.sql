-- Up Migration
-- Help-centre sub-section for help articles (规划/04 §3.2 articles.help_section: 帮助中心的子分类，
-- 可空，只在分类为帮助时可非空; 变更记录 20261020-内容线默认回写 §1.6, default L30). Codes are the
-- contract enum ArticleHelpSection (contracts/openapi.yaml, CT-02za): getting_started,
-- rebate_settlement, orders_claims, withdraw, invite, account_privacy. Names, checks and grants
-- follow the orchestrator ruling in the F1-02zq brief §9.2 (ADR-0001 §4). Task F1-02zq.
-- Compatibility: additive. app.articles gains help_section text, nullable, no default, no backfill
-- (every existing row reads NULL, so both new checks hold for existing data). Existing inserts that
-- omit the column keep working. articles_help_section_check limits values to the six codes
-- (case-sensitive, no other value); articles_help_section_category_check allows a non-NULL value
-- only when category = 'help'. Grants are unchanged: the table-level SELECT / INSERT of couli_app
-- and SELECT of couli_readonly cover the new column; help_section is deliberately NOT added to
-- couli_app's column-level UPDATE list from 0049 (revisions are new rows: changing the sub-section
-- means saving a new draft version).
-- Recovery: no down migration. To roll back, a new migration drops
-- articles_help_section_category_check and articles_help_section_check, then drops the column
-- help_section (after the application stops reading and writing it).
--
-- Timeouts: ADD COLUMN and ADD CONSTRAINT take ACCESS EXCLUSIVE on app.articles, held to commit
-- since the runner uses one transaction. 5s lock wait so a blocked deploy fails fast instead of
-- queueing article traffic behind it; 30s overall as a ceiling for the CHECK scans of a small table
-- and catalog changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.articles ADD COLUMN help_section text;

-- app.articles is not a funds or attribution table. The runner applies migrations in one
-- transaction, so NOT VALID + VALIDATE would still scan under the ACCESS EXCLUSIVE lock taken by
-- ADD and gain nothing; the table is small (content revisions) and the new column is NULL on every
-- existing row, so a plain validated ADD is used, as in 0049.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.articles ADD CONSTRAINT articles_help_section_check
  CHECK (help_section IS NULL OR help_section IN (
    'getting_started', 'rebate_settlement', 'orders_claims', 'withdraw', 'invite', 'account_privacy'
  ));

-- Same reasoning as above.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.articles ADD CONSTRAINT articles_help_section_category_check
  CHECK (help_section IS NULL OR category = 'help');
