-- Up Migration
-- Manual FAQ order for help articles (规划/04 §3.2 articles.faq_rank: int 1–999，可空；帮助中心
-- 「常见问题」的人工排序，只在分类为帮助时可非空; 规划/01 §4.2 Help: 常见问题按 faq_rank 从小到大排;
-- CT-26a, W-25). The contract field is ArticleListItem / admin article faq_rank (int 1–999,
-- nullable, contracts/openapi.yaml). The API-level 20001 check for non-help articles belongs to
-- F1-02zzp; this migration is the library layer only. Names, checks and grants follow the
-- orchestrator ruling in the F1-02zzo brief §9.2 (ADR-0001 §4), with 0061 as precedent.
-- Task F1-02zzo.
-- Compatibility: additive. app.articles gains faq_rank integer, nullable, no default, no backfill
-- (every existing row reads NULL, so both new checks hold for existing data). Existing inserts that
-- omit the column keep working. articles_faq_rank_check limits values to 1..999 inclusive;
-- articles_faq_rank_category_check allows a non-NULL value only when category = 'help'. Grants are
-- unchanged: the table-level SELECT / INSERT of couli_app and SELECT of couli_readonly cover the
-- new column; faq_rank is deliberately NOT added to couli_app's column-level UPDATE list from 0049
-- (revisions are new rows: changing the FAQ order means saving a new draft version).
-- Recovery: no down migration. To roll back, a new migration drops
-- articles_faq_rank_category_check and articles_faq_rank_check, then drops the column faq_rank
-- (after the application stops reading and writing it).
--
-- Timeouts: ADD COLUMN and ADD CONSTRAINT take ACCESS EXCLUSIVE on app.articles, held to commit
-- since the runner uses one transaction. 5s lock wait so a blocked deploy fails fast instead of
-- queueing article traffic behind it; 30s overall as a ceiling for the CHECK scans of a small table
-- and catalog changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.articles ADD COLUMN faq_rank integer;

-- app.articles is not a funds or attribution table. The runner applies migrations in one
-- transaction, so NOT VALID + VALIDATE would still scan under the ACCESS EXCLUSIVE lock taken by
-- ADD and gain nothing; the table is small (content revisions) and the new column is NULL on every
-- existing row, so a plain validated ADD is used, as in 0049 and 0061.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.articles ADD CONSTRAINT articles_faq_rank_check
  CHECK (faq_rank IS NULL OR faq_rank BETWEEN 1 AND 999);

-- Same reasoning as above.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.articles ADD CONSTRAINT articles_faq_rank_category_check
  CHECK (faq_rank IS NULL OR category = 'help');
