// B3-08e §9 (attempt 2), BR-AI-04 / BR-AI-07. Source eligibility/synchronization
// belongs to B3-08i; all article fixtures here are published help/rule revisions.
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { APP_ID, AT, LATER, createKit, sqlState, type Row } from './kit.ts';

let kit: Awaited<ReturnType<typeof createKit>>;
beforeAll(async () => {
  kit = await createKit(createTestDatabase);
});
afterAll(async () => {
  if (kit) await kit.close();
});

for (const category of ['help', 'rule'] as const) {
  it(`[AC-B3-08e#1][BR-AI-04][BR-AI-07] published ${category}: seq 0/1 default to active with no retirement`, async () => {
    const row = await kit.fixture(category);
    for (const seq of [0, 1]) {
      const chunk = { ...row, chunk_id: randomUUID(), seq };
      expect(await sqlState(kit.insert(chunk))).toBe('OK');
      expect(await kit.stored(chunk.chunk_id)).toEqual({
        ...chunk,
        status: 'active',
        retired_at: null,
        created_at: expect.any(Date),
      });
    }
    const withoutId: Row = { ...row, seq: 2 };
    delete withoutId['chunk_id'];
    expect(await sqlState(kit.insert(withoutId))).toBe('23502');
  });
}

it('[AC-B3-08e#2][BR-AI-04][BR-AI-07] chunk IDs and article/version/seq are unique; different versions reuse seq', async () => {
  const row = await kit.fixture();
  expect(await sqlState(kit.insert(row))).toBe('OK');
  expect(await sqlState(kit.insert({ ...row, chunk_id: randomUUID() }))).toBe('23505');
  expect(await sqlState(kit.insert({ ...row, seq: 1 }))).toBe('23505');
  await kit.article('help', String(row['article_id']), 2);
  expect(await sqlState(kit.insert({ ...row, chunk_id: randomUUID(), published_version: 2 }))).toBe(
    'OK',
  );
});

const INVALID: [string, unknown, string][] = [
  ['text', '', '23514'],
  ['text', '规'.repeat(201), '23514'],
  ['title', '', '23514'],
  ['seq', -1, '23514'],
  ['published_version', 0, '23514'],
  ['status', 'deleted', '23514'],
  ...[
    'chunk_id',
    'app_id',
    'article_id',
    'published_version',
    'seq',
    'title',
    'text',
    'status',
    'created_at',
  ].map((name): [string, unknown, string] => [name, null, '23502']),
];
for (const [name, value, code] of INVALID) {
  it(`[AC-B3-08e#3][BR-AI-04][BR-AI-07] rejects ${name}=${String(value)} with ${code}`, async () => {
    const row = await kit.fixture();
    expect(await sqlState(kit.insert({ ...row, [name]: value }))).toBe(code);
  });
}

it('[AC-B3-08e#3][BR-AI-04][BR-AI-07] exactly 200 Chinese characters fit without truncation', async () => {
  const row: Row = { ...(await kit.fixture()), text: '规'.repeat(200) };
  expect(await sqlState(kit.insert(row))).toBe('OK');
  expect((await kit.stored(row['chunk_id']))['text']).toBe(row['text']);
});

it('[AC-B3-08e#4][BR-AI-04][BR-AI-07] absent article and absent revision both violate the composite foreign key', async () => {
  const row = await kit.fixture();
  expect(await sqlState(kit.insert({ ...row, article_id: randomUUID() }))).toBe('23503');
  expect(await sqlState(kit.insert({ ...row, published_version: 2 }))).toBe('23503');
});

it('[AC-B3-08e#4][BR-AI-04][BR-AI-07] validated FK targets app.articles(id, version) with NO ACTION both ways', async () => {
  await kit.requireTable();
  const result = await sql<{
    source: string[];
    target: string[];
    schema: string;
    table: string;
    on_delete: string;
    on_update: string;
    validated: boolean;
  }>`SELECT
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS source,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord) AS target,
    n.nspname AS schema, t.relname AS table,
    c.confdeltype::text AS on_delete, c.confupdtype::text AS on_update, c.convalidated AS validated
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conrelid = to_regclass('app.agent_rule_chunks') AND c.contype = 'f'`.execute(kit.app);
  expect(result.rows).toContainEqual({
    source: ['article_id', 'published_version'],
    target: ['id', 'version'],
    schema: 'app',
    table: 'articles',
    on_delete: 'a',
    on_update: 'a',
    validated: true,
  });
});

it('[AC-B3-08e#5][BR-AI-04][BR-AI-07] retirement is atomic, permanent, and permits identical retired-row replay', async () => {
  const row = await kit.fixture();
  await kit.insert(row);
  const id = row['chunk_id'];
  const before = await kit.stored(id);
  for (const patch of [{ status: 'retired' }, { retired_at: AT }]) {
    expect(await sqlState(kit.update(id, patch))).toBe('23001');
    expect(await kit.stored(id)).toEqual(before);
  }
  expect(await sqlState(kit.update(id, { status: 'retired', retired_at: AT }))).toBe('OK');
  const retired = { ...before, status: 'retired', retired_at: AT };
  expect(await kit.stored(id)).toEqual(retired);
  const forbidden: Row[] = [
    { status: 'active' },
    { status: 'active', retired_at: null },
    { retired_at: LATER },
    { retired_at: null },
  ];
  for (const patch of forbidden) {
    expect(await sqlState(kit.update(id, patch))).toBe('23001');
    expect(await kit.stored(id)).toEqual(retired);
  }
  expect(await sqlState(kit.update(id, { status: 'retired', retired_at: AT }))).toBe('OK');
  expect(await kit.stored(id)).toEqual(retired);
});

for (const [name, value] of [
  ['chunk_id', '0199bdc0-0000-7000-8000-000000000001'],
  ['app_id', 'other-app'],
  ['article_id', '0199bdc0-0000-7000-8000-000000000002'],
  ['published_version', 2],
  ['seq', 2],
  ['title', '改写标题'],
  ['text', '改写正文'],
  ['created_at', LATER],
] as const) {
  it(`[AC-B3-08e#5][BR-AI-04][BR-AI-07] couli_app cannot UPDATE immutable ${name} (42501)`, async () => {
    const row = await kit.fixture();
    await kit.insert(row);
    const before = await kit.stored(row['chunk_id']);
    expect(await sqlState(kit.update(row['chunk_id'], { [name]: value }))).toBe('42501');
    expect(await kit.stored(row['chunk_id'])).toEqual(before);
    // Combining forbidden edits with the permitted retirement cannot bypass the column grant.
    expect(
      await sqlState(
        kit.update(row['chunk_id'], {
          [name]: value,
          status: 'retired',
          retired_at: AT,
        }),
      ),
    ).toBe('42501');
    expect(await kit.stored(row['chunk_id'])).toEqual(before);
  });
}

it('[AC-B3-08e#5][BR-AI-04][BR-AI-07] INSERT enforces retirement timestamp equivalence', async () => {
  const row = await kit.fixture();
  expect(await sqlState(kit.insert({ ...row, status: 'active', retired_at: AT }))).toBe('23514');
  expect(await sqlState(kit.insert({ ...row, status: 'retired' }))).toBe('23514');
  expect(await sqlState(kit.insert({ ...row, status: 'retired', retired_at: AT }))).toBe('OK');
});

it('[AC-B3-08e#6][BR-AI-04][BR-AI-07] couli_app cannot DELETE or TRUNCATE chunks', async () => {
  const row = await kit.fixture();
  await kit.insert(row);
  const before = await kit.stored(row['chunk_id']);
  expect(
    await sqlState(
      sql`DELETE FROM app.agent_rule_chunks WHERE chunk_id = ${row['chunk_id']}`.execute(kit.app),
    ),
  ).toBe('42501');
  expect(await sqlState(sql`TRUNCATE app.agent_rule_chunks`.execute(kit.app))).toBe('42501');
  expect(await kit.stored(row['chunk_id'])).toEqual(before);
});

it('[AC-B3-08e#7][BR-AI-04][BR-AI-07] readonly reads metadata but cannot read title/text or write', async () => {
  const row = await kit.fixture();
  await kit.insert(row);
  const before = await kit.stored(row['chunk_id']);
  const metadata = await sql`SELECT chunk_id, app_id, article_id, published_version,
    seq, status, created_at, retired_at FROM app.agent_rule_chunks
    WHERE chunk_id = ${row['chunk_id']}`.execute(kit.readonly);
  expect(metadata.rows).toEqual([
    {
      chunk_id: row['chunk_id'],
      app_id: APP_ID,
      article_id: row['article_id'],
      published_version: 1,
      seq: 0,
      status: 'active',
      created_at: before['created_at'],
      retired_at: null,
    },
  ]);
  for (const column of ['title', 'text']) {
    expect(
      await sqlState(
        sql`SELECT ${sql.ref(column)} FROM app.agent_rule_chunks`.execute(kit.readonly),
      ),
    ).toBe('42501');
  }
  expect(await sqlState(kit.insert({ ...row, chunk_id: randomUUID(), seq: 1 }, kit.readonly))).toBe(
    '42501',
  );
  expect(
    await sqlState(
      kit.update(row['chunk_id'], { status: 'retired', retired_at: AT }, kit.readonly),
    ),
  ).toBe('42501');
  expect(
    await sqlState(
      sql`DELETE FROM app.agent_rule_chunks WHERE chunk_id = ${row['chunk_id']}`.execute(
        kit.readonly,
      ),
    ),
  ).toBe('42501');
  expect(await sqlState(sql`TRUNCATE app.agent_rule_chunks`.execute(kit.readonly))).toBe('42501');
  expect(await kit.stored(row['chunk_id'])).toEqual(before);
});

for (const role of ['couli_payout', 'couli_maint']) {
  it(`[AC-B3-08e#7][BR-AI-04][BR-AI-07] ${role} has no table or column privileges`, async () => {
    await kit.requireTable();
    for (const privilege of [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
      'MAINTAIN',
    ]) {
      const result = await sql<{ allowed: boolean }>`
        SELECT has_table_privilege(${role}, 'app.agent_rule_chunks', ${privilege}) AS allowed`.execute(
        kit.app,
      );
      expect(result.rows, `${role} ${privilege}`).toEqual([{ allowed: false }]);
    }
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
      const result = await sql<{ allowed: boolean }>`
        SELECT has_any_column_privilege(${role}, 'app.agent_rule_chunks', ${privilege}) AS allowed`.execute(
        kit.app,
      );
      expect(result.rows, `${role} column ${privilege}`).toEqual([{ allowed: false }]);
    }
  });
}

it('[AC-B3-08e#8][BR-AI-04][BR-AI-07] exact enumerated columns, no vector, and only prescribed defaults', async () => {
  await kit.requireTable();
  const columns = await sql<{
    name: string;
    type: string;
    nullable: string;
    default_value: string | null;
  }>`
    SELECT column_name AS name, udt_name AS type, is_nullable AS nullable, column_default AS default_value
    FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'agent_rule_chunks'
    ORDER BY column_name`.execute(kit.app);
  const expected: [string, string][] = [
    ['chunk_id', 'uuid'],
    ['app_id', 'text'],
    ['article_id', 'uuid'],
    ['published_version', 'int4'],
    ['seq', 'int4'],
    ['title', 'text'],
    ['text', 'text'],
    ['status', 'text'],
    ['created_at', 'timestamptz'],
    ['retired_at', 'timestamptz'],
  ];
  // §9 says eleven, but explicitly enumerates ten fields; use that complete field list,
  // without inventing an eleventh column or reintroducing the deferred embedding column.
  expect(columns.rows).toEqual(
    expected
      .map(([name, type]) => ({
        name,
        type,
        nullable: name === 'retired_at' ? 'YES' : 'NO',
        default_value:
          name === 'status' ? "'active'::text" : name === 'created_at' ? 'now()' : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
});

it('[AC-B3-08e#8][BR-AI-04][BR-AI-07] keeps the pre-task extension set and app/status lookup index', async () => {
  await kit.requireTable();
  // Frozen pre-task baseline: PostgreSQL installs plpgsql; bootstrap/extensions.sql adds vector.
  // The test factory clones after migrations, so taking a baseline in beforeAll would hide additions.
  const extensions = await sql<{
    name: string;
  }>`SELECT extname AS name FROM pg_extension ORDER BY extname`.execute(kit.app);
  expect(extensions.rows).toEqual([{ name: 'plpgsql' }, { name: 'vector' }]);
  const indexes = await sql<{ columns: string[] }>`SELECT ARRAY(
    SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(num, ord)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
    WHERE k.ord <= i.indnkeyatts ORDER BY k.ord
  ) AS columns FROM pg_index i WHERE i.indrelid = to_regclass('app.agent_rule_chunks')
    AND i.indisvalid AND i.indisready AND i.indpred IS NULL`.execute(kit.app);
  expect(indexes.rows).toContainEqual({ columns: ['app_id', 'status'] });
  const primary = await sql<{ columns: string[] }>`SELECT ARRAY(
    SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord
  ) AS columns FROM pg_constraint c WHERE c.conrelid = to_regclass('app.agent_rule_chunks') AND c.contype = 'p'`.execute(
    kit.app,
  );
  expect(primary.rows).toEqual([{ columns: ['chunk_id'] }]);
});
