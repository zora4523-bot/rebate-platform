// F1-02zzo §9.2–9.3 items 1–4: faq_rank column shape, the two named CHECKs and their values.
// The integration globalSetup alone reads the admin database URL and applies migrations; this
// file works through business roles and does not pin a migration number.
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  CATEGORY_CHECK,
  EXISTING_CHECKS,
  INVALID_RANKS,
  NON_HELP,
  VALID_RANKS,
  VALUE_CHECK,
  article,
  failure,
  faqRankColumn,
  insert,
  ready,
  stored,
  type Connection,
} from './faq-rank-kit.ts';

let database: TestDatabase;
let app: Connection;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});

afterAll(async () => {
  if (app) await destroyDb(app);
  await database?.drop();
});

it('[AC-F1-02zzo#1] faq_rank is a plain nullable int4 with no default, not generated, not a domain', async () => {
  await ready(app);
  expect(await faqRankColumn(app)).toEqual([
    {
      type: 'int4',
      dataType: 'integer',
      nullable: 'YES',
      defaultValue: null,
      identity: 'NO',
      generated: 'NEVER',
      domain: null,
      regtype: 'integer',
      notNull: false,
      hasDefault: false,
      generatedKind: '',
    },
  ]);
});

it('[AC-F1-02zzo#2] both named faq_rank CHECKs are validated and every earlier CHECK remains', async () => {
  await ready(app);
  const names = [...EXISTING_CHECKS, CATEGORY_CHECK, VALUE_CHECK].sort();
  const checks = await sql`SELECT conname AS name, contype::text AS type,
      convalidated AS validated
    FROM pg_constraint
    WHERE conrelid = to_regclass('app.articles') AND conname IN (${sql.join(names)})
    ORDER BY conname`.execute(app);
  expect(checks.rows).toEqual(names.map((name) => ({ name, type: 'c', validated: true })));
});

it('[AC-F1-02zzo#3] the value CHECK covers faq_rank alone; the category CHECK covers faq_rank and category', async () => {
  await ready(app);
  const columns = await sql<{ name: string; columns: string[] }>`SELECT c.conname AS name,
      array(SELECT a.attname::text FROM unnest(c.conkey) AS k(attnum)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        ORDER BY a.attname) AS columns
    FROM pg_constraint c
    WHERE c.conrelid = to_regclass('app.articles')
      AND c.conname IN (${CATEGORY_CHECK}, ${VALUE_CHECK})
    ORDER BY c.conname`.execute(app);
  expect(columns.rows).toEqual([
    { name: CATEGORY_CHECK, columns: ['category', 'faq_rank'] },
    { name: VALUE_CHECK, columns: ['faq_rank'] },
  ]);
});

it('[AC-F1-02zzo#4] help accepts 1, 2, 500, 998, 999 and NULL and stores each unchanged', async () => {
  await ready(app);
  for (const faq_rank of [...VALID_RANKS, null]) {
    const row = article({ faq_rank });
    expect(await insert(app, row), String(faq_rank)).toEqual(row);
    expect(await stored(app, row), String(faq_rank)).toEqual([row]);
  }
});

it('[AC-F1-02zzo#5] help rejects 0, -1, 1000 and the int4 extremes via articles_faq_rank_check', async () => {
  await ready(app);
  for (const faq_rank of INVALID_RANKS) {
    const row = article({ faq_rank });
    await expect(insert(app, row), String(faq_rank)).rejects.toMatchObject({
      code: '23514',
      constraint: VALUE_CHECK,
    });
    expect(await stored(app, row), String(faq_rank)).toEqual([]);
  }
});

it('[AC-F1-02zzo#6] help with a section accepts in-range ranks and still rejects out-of-range ones', async () => {
  await ready(app);
  for (const faq_rank of [1, 999]) {
    const row = article({ help_section: 'withdraw', faq_rank });
    expect(await insert(app, row), String(faq_rank)).toEqual(row);
    expect(await stored(app, row), String(faq_rank)).toEqual([row]);
  }
  for (const faq_rank of [0, 1000]) {
    const row = article({ help_section: 'withdraw', faq_rank });
    await expect(insert(app, row), String(faq_rank)).rejects.toMatchObject({
      code: '23514',
      constraint: VALUE_CHECK,
    });
    expect(await stored(app, row), String(faq_rank)).toEqual([]);
  }
});

it('[AC-F1-02zzo#7] rule, notice and agreement reject every in-range rank via articles_faq_rank_category_check', async () => {
  await ready(app);
  for (const category of NON_HELP) {
    for (const faq_rank of VALID_RANKS) {
      const row = article({ category, faq_rank });
      await expect(insert(app, row), `${category}/${faq_rank}`).rejects.toMatchObject({
        code: '23514',
        constraint: CATEGORY_CHECK,
      });
      expect(await stored(app, row), `${category}/${faq_rank}`).toEqual([]);
    }
  }
});

it('[AC-F1-02zzo#8] non-help categories with an out-of-range rank are rejected by one of the two CHECKs', async () => {
  await ready(app);
  for (const category of NON_HELP) {
    for (const faq_rank of INVALID_RANKS) {
      const row = article({ category, faq_rank });
      const error = await failure(insert(app, row));
      expect(error, `${category}/${faq_rank}`).toMatchObject({ code: '23514' });
      expect([CATEGORY_CHECK, VALUE_CHECK], `${category}/${faq_rank}`).toContain(error?.constraint);
      expect(await stored(app, row), `${category}/${faq_rank}`).toEqual([]);
    }
  }
});

it('[AC-F1-02zzo#9] every category accepts an explicit NULL rank and inserts that omit faq_rank', async () => {
  await ready(app);
  for (const category of ['help', ...NON_HELP]) {
    const explicit = article({ category, faq_rank: null });
    expect(await insert(app, explicit), category).toEqual(explicit);
    expect(await stored(app, explicit), category).toEqual([explicit]);
    const expected = article({ category });
    const omitted = { ...expected };
    delete omitted.faq_rank;
    expect(await insert(app, omitted), category).toEqual(expected);
    expect(await stored(app, omitted), category).toEqual([expected]);
  }
});

it('[AC-F1-02zzo#10] earlier status, category and help_section CHECKs still fire alongside a valid rank', async () => {
  await ready(app);
  for (const status of ['', 'archived', 'Published']) {
    const row = article({ status, faq_rank: 1 });
    await expect(insert(app, row), status).rejects.toMatchObject({
      code: '23514',
      constraint: 'articles_status_check',
    });
    expect(await stored(app, row)).toEqual([]);
  }
  for (const category of ['', 'unknown_category', 'Help']) {
    const row = article({ category, faq_rank: null });
    await expect(insert(app, row), category).rejects.toMatchObject({
      code: '23514',
      constraint: 'articles_category_check',
    });
    expect(await stored(app, row)).toEqual([]);
  }
  const badSection = article({ help_section: 'Invite', faq_rank: 1 });
  await expect(insert(app, badSection)).rejects.toMatchObject({
    code: '23514',
    constraint: 'articles_help_section_check',
  });
  expect(await stored(app, badSection)).toEqual([]);
});
