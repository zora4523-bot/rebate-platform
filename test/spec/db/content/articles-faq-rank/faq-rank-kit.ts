// F1-02zzo §9.2–9.3: app.articles.faq_rank (04 §3.2 articles; CT-26a ArticleListItem.faq_rank).
// Library layer only: the 20001 API check belongs to F1-02zzp. Connections come from the
// *.int.test.ts files (createTestDatabase, business roles only); nothing here opens a pool.
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export type Connection = Kysely<DB>;
export type Row = Record<string, unknown>;

export const AT = new Date('2026-10-22T08:00:00.000Z');
export const VALUE_CHECK = 'articles_faq_rank_check';
export const CATEGORY_CHECK = 'articles_faq_rank_category_check';
// CHECKs that were on app.articles before this task and must survive it.
export const EXISTING_CHECKS = [
  'articles_category_check',
  'articles_help_section_category_check',
  'articles_help_section_check',
  'articles_notice_content_version_check',
  'articles_status_check',
  'articles_version_check',
] as const;
// 0049: the only columns couli_app may UPDATE; faq_rank must not join them.
export const MUTABLE = ['notice_end_at', 'published_at', 'row_version', 'status', 'updated_at'];
export const NON_HELP = ['rule', 'notice', 'agreement'] as const;
export const VALID_RANKS = [1, 2, 500, 998, 999] as const;
export const INVALID_RANKS = [0, -1, 1000, 2147483647, -2147483648] as const;

export async function faqRankColumn(db: Connection) {
  return (
    await sql<Row>`SELECT c.udt_name AS type, c.data_type AS "dataType",
        c.is_nullable AS nullable, c.column_default AS "defaultValue",
        c.is_identity AS identity, c.is_generated AS generated, c.domain_name AS domain,
        a.atttypid::regtype::text AS regtype, a.attnotnull AS "notNull",
        a.atthasdef AS "hasDefault", a.attgenerated::text AS "generatedKind"
      FROM information_schema.columns c
      JOIN pg_attribute a ON a.attrelid = to_regclass('app.articles') AND a.attname = c.column_name
      WHERE c.table_schema = 'app' AND c.table_name = 'articles'
        AND c.column_name = 'faq_rank' AND NOT a.attisdropped`.execute(db)
  ).rows;
}

// Call first in every test: an unmigrated database must fail this assertion, not SQLSTATE 42703.
export async function ready(db: Connection): Promise<void> {
  expect(await faqRankColumn(db), 'app.articles.faq_rank exists').toHaveLength(1);
}

// Each fixture has its own app_id; text and time are synthetic and fixed. Every column the
// migrated table returns from RETURNING * is listed, so whole-row comparisons are exact.
export function article(overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    app_id: `f1_02zzo_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    category: 'help',
    title: 'FAQ rank fixture',
    body: 'Fixture body',
    version: 1,
    status: 'draft',
    published_at: null,
    notice_closable: true,
    notice_content_version: 1,
    notice_end_at: null,
    row_version: 0,
    created_at: AT,
    updated_at: AT,
    help_section: null,
    faq_rank: null,
    ...overrides,
  };
}

export async function insert(db: Connection, row: Row): Promise<Row> {
  const names = Object.keys(row);
  const result = await sql<Row>`INSERT INTO app.articles
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING *`.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

export async function stored(db: Connection, row: Row): Promise<Row[]> {
  return (
    await sql<Row>`SELECT * FROM app.articles
      WHERE app_id = ${row.app_id} AND id = ${row.id} ORDER BY version`.execute(db)
  ).rows;
}

// Resolves to the driver error (or null when the statement unexpectedly succeeded).
export async function failure(run: Promise<unknown>): Promise<Row | null> {
  return run.then(
    () => null,
    (error: unknown) => error as Row,
  );
}
