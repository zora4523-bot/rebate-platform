// B2-04zfa rule tests (编排裁定 D10-492 ②; db/AGENTS.md 迁移规则 3): the migration only adds
// app.settle_runs — no backfill from settle_batches or elsewhere, no change to other tables.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { TIMEOUT, close, migrationSource, open, ready, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-04zfa#5] 只加表、不回填：迁移后表为空；迁移里没有写数据的语句，也不改、不删别的表', async () => {
  await ready(h.app);
  const count = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.settle_runs
  `.execute(h.app);
  expect(count.rows).toEqual([{ n: '0' }]);

  const source = migrationSource();
  for (const [label, pattern] of [
    ['INSERT', /\bINSERT\s+INTO\b/i],
    ['UPDATE', /\bUPDATE\s+(?:ONLY\s+)?[a-z_][\w.]*\s+(?:AS\s+\w+\s+)?SET\b/i],
    ['DELETE', /\bDELETE\s+FROM\b/i],
    ['MERGE', /\bMERGE\s+INTO\b/i],
    ['COPY', /\bCOPY\s+[a-z_][\w.]*/i],
    ['TRUNCATE', /(?:^|;)\s*TRUNCATE\b/i],
    ['SELECT INTO', /\bSELECT\b[^;]*\bINTO\s+(?:TABLE\s+)?app\./i],
    ['CREATE TABLE AS', /\bCREATE\s+TABLE\b[^;(]*\bAS\b/i],
  ] as const) {
    expect(source, label).not.toMatch(pattern);
  }
  const alters = source.match(/\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?[\w.]+/gi) ?? [];
  for (const statement of alters) {
    expect(statement, '只改本表').toMatch(/\bapp\.settle_runs$/i);
  }
  expect(source, '不删任何对象').not.toMatch(/(?:^|;)\s*DROP\b/i);
});
