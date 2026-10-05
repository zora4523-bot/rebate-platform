// B1-05a: 04 §2.1 / §3.2; BR-PROD-02, 03, 05, 10; ADR-0001 §4.
// No migration-number dependency. Each test first asserts catalog metadata: absent tables
// must fail an assertion, never an undefined-table SQL error. Only business-role connections.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

let database: TestDatabase;
let app: Kysely<DB>;
const TABLES = ['platforms', 'product_refs', 'product_key_aliases', 'category_blocklist'] as const;
type Table = (typeof TABLES)[number];
type Column = { name: string; type: string; nullable: boolean; has_default: boolean };
const NOW = new Date('2026-10-05T08:00:00Z');
const PREFIXES = {
  taobao: 'tb',
  jd: 'jd',
  pdd: 'pdd',
  meituan: 'mt',
  vip: 'vip',
  douyin: 'dy',
  eleme: null,
  kuaishou: 'ks',
  suning: 'sn',
};

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

async function columns(table: Table): Promise<Column[]> {
  const relation = await sql<{ kind: string }>`
    SELECT c.relkind::text AS kind FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = ${table}
  `.execute(app);
  expect(relation.rows, `app.${table} exists as a table`).toHaveLength(1);
  expect(['r', 'p']).toContain(relation.rows[0]?.kind);
  const result = await sql<Column>`
    SELECT a.attname AS name, t.typname AS type, NOT a.attnotnull AS nullable,
           (a.atthasdef OR a.attidentity <> '' OR a.attgenerated <> '') AS has_default
    FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
    WHERE a.attrelid = to_regclass(${`app.${table}`})
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
  `.execute(app);
  return result.rows;
}

async function requireColumns(table: Table, names: string[]): Promise<Column[]> {
  const cols = await columns(table);
  for (const name of names)
    expect(
      cols.map((c) => c.name),
      `${table}.${name}`,
    ).toContain(name);
  return cols;
}

async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // An assertion from the metadata precondition must remain an AssertionError for red-check.
    if (typeof code !== 'string') throw error;
    return code;
  }
}

// Fill only unspecified required bookkeeping fields, never infer values being tested from DDL.
async function insertRow(table: Table, values: Record<string, unknown>): Promise<void> {
  const cols = await requireColumns(table, Object.keys(values));
  const row = { ...values };
  for (const col of cols) {
    if (col.name in row || col.nullable || col.has_default) continue;
    if (col.name === 'app_id') row[col.name] = 'couli';
    else if (col.type === 'uuid') row[col.name] = randomUUID();
    else if (['int2', 'int4', 'int8'].includes(col.type)) row[col.name] = 0;
    else if (col.type === 'timestamptz') row[col.name] = NOW;
    else {
      expect.fail(`Fixture needs an explicit value for ${table}.${col.name} (${col.type})`);
    }
  }
  const names = Object.keys(row);
  await sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))})`.execute(app);
}

async function newRef(values: Record<string, unknown> = {}): Promise<void> {
  await insertRow('product_refs', {
    app_id: 'couli',
    product_key: `tb:${randomUUID()}`,
    platform: 'taobao',
    raw_item_id: '0001-AbC-item',
    raw_fetched_at: NOW,
    canonical_url: null,
    title: '规则测试商品',
    shop_id: '0007',
    shop_type: 'tmall',
    source: 'search',
    refreshed_at: NOW,
    ...values,
  });
}

async function newAlias(oldKey: string, newKey: string): Promise<void> {
  await insertRow('product_key_aliases', {
    old_key: oldKey,
    new_key: newKey,
    reason: '一对一派生规则变更',
    adr_id: 'ADR-CATALOG-TEST',
    created_at: NOW,
  });
}

async function seeds(): Promise<Record<string, unknown>[]> {
  await requireColumns('platforms', ['code', 'key_prefix', 'key_stability']);
  const result = await sql<Record<string, unknown>>`SELECT * FROM app.platforms`.execute(app);
  expect(result.rows).toHaveLength(9);
  return result.rows;
}

it('[AC-B1-05a#1] catalog tables contain the explicitly specified columns', async () => {
  await requireColumns('platforms', ['code', 'key_prefix', 'key_stability']);
  await requireColumns('product_refs', [
    'app_id',
    'product_key',
    'platform',
    'raw_item_id',
    'raw_fetched_at',
    'canonical_url',
    'title',
    'shop_id',
    'shop_type',
    'source',
    'refreshed_at',
  ]);
  await requireColumns('product_key_aliases', [
    'old_key',
    'new_key',
    'reason',
    'adr_id',
    'created_at',
  ]);
  await requireColumns('category_blocklist', [
    'platform',
    'category_id',
    'keyword',
    'reason',
    'status',
    'updated_by',
  ]);
});

it('[AC-B1-05a#2] seeds contain exactly nine string platform codes, bare prefixes and unverified stability', async () => {
  const rows = await seeds();
  expect(rows.map((r) => r['code']).sort()).toEqual(Object.keys(PREFIXES).sort());
  for (const [code, prefix] of Object.entries(PREFIXES)) {
    const row = rows.find((r) => r['code'] === code);
    expect(row, code).toMatchObject({ code, key_prefix: prefix, key_stability: 'unverified' });
  }
  expect((await columns('platforms')).find((c) => c.name === 'code')?.type).toBe('text');
});

// Capability column names / enum encodings are not specified. Compare equality classes of
// their stored values (including JSON leaves), not invented SQL names or enum literals.
function leaves(value: unknown, path = ''): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) =>
        Object.entries(leaves(child, `${path}.${key}`)),
      ),
    );
  }
  return { [path]: value };
}

function signature(values: unknown[]): string {
  const distinct: string[] = [];
  return values
    .map((value) => {
      const encoded = JSON.stringify(value) ?? 'undefined';
      if (!distinct.includes(encoded)) distinct.push(encoded);
      return String(distinct.indexOf(encoded));
    })
    .join('');
}

it('[AC-B1-05a#3] seeds preserve the search, conversion, order-sync and rollout distinctions of 04 §2.1', async () => {
  const rows = await seeds();
  const ordered = Object.keys(PREFIXES).map((code) => leaves(rows.find((r) => r['code'] === code)));
  const paths = Object.keys(ordered[0] ?? {});
  const signatures = paths.map((path) => signature(ordered.map((row) => row[path])));
  // Order: taobao, jd, pdd, meituan, vip, douyin, eleme, kuaishou, suning.
  // In particular MT search "unverified" is distinct from "no search" and planned P1.
  expect(signatures, 'search: supported / unverified / P1 / none').toContain('000122333');
  expect(signatures, 'convert: supported / activity / P1 / P2').toContain('000122233');
  expect(signatures, 'order_sync: supported / P1 / P2').toContain('000011122');
  // MT may store the D15 annotation separately, or retain it in its stage value.
  // In the latter case stage and conversion have the same grouping, but still need
  // separate stored fields; a conversion flag alone must not stand in for rollout stage.
  expect(
    signatures.includes('000111122') || signatures.filter((s) => s === '000122233').length >= 2,
    'M / P1 / P2 stage',
  ).toBe(true);
});

it('[AC-B1-05a#4] platform codes are unique and adding a dictionary row needs no platform enum change', async () => {
  const rows = await seeds();
  const template = rows.find((r) => r['code'] === 'taobao');
  expect(template).toBeDefined();
  const cols = await columns('platforms');
  const values = Object.fromEntries(
    Object.entries(template ?? {}).filter(
      ([name]) => !cols.find((c) => c.name === name)?.has_default && name !== 'id',
    ),
  );
  const code = `test_${randomUUID().replaceAll('-', '')}`;
  // Roll back the temporary platform so the exact-nine-seeds tests are order-independent.
  await app.transaction().execute(async (trx) => {
    const names = Object.keys({ ...values, code, key_prefix: 'test' });
    const row = { ...values, code, key_prefix: 'test' } as Record<string, unknown>;
    for (const col of cols) {
      if (col.name === 'id' && !col.has_default) {
        names.push('id');
        row['id'] = randomUUID();
      }
    }
    await sql`SAVEPOINT dictionary_insert`.execute(trx);
    expect(
      await sqlState(
        sql`INSERT INTO app.platforms (${sql.join(names.map((n) => sql.ref(n)))})
      VALUES (${sql.join(names.map((n) => row[n]))})`.execute(trx),
      ),
    ).toBe('ok');
    await sql`SAVEPOINT duplicate_code`.execute(trx);
    // Change every other potentially unique identity; the duplicate code itself must reject.
    row['key_prefix'] = 'test2';
    if ('id' in row) row['id'] = randomUUID();
    expect(
      await sqlState(
        sql`INSERT INTO app.platforms (${sql.join(names.map((n) => sql.ref(n)))})
      VALUES (${sql.join(names.map((n) => row[n]))})`.execute(trx),
      ),
    ).toBe('23505');
    await sql`ROLLBACK TO SAVEPOINT dictionary_insert`.execute(trx);
  });
});

it('[AC-B1-05a#5] key_stability accepts the four specified values and rejects unknown values with CHECK', async () => {
  await requireColumns('platforms', ['code', 'key_stability']);
  try {
    for (const value of ['unverified', 'stable_24h', 'stable_7d', 'unstable']) {
      const result = await sql`UPDATE app.platforms SET key_stability = ${value}
        WHERE code = 'taobao'`.execute(app);
      expect(result.numAffectedRows).toBe(1n);
    }
    for (const value of ['', 'stable', 'STABLE_7D']) {
      expect(
        await sqlState(
          sql`UPDATE app.platforms SET key_stability = ${value}
        WHERE code = 'taobao'`.execute(app),
        ),
      ).toBe('23514');
    }
  } finally {
    await sql`UPDATE app.platforms SET key_stability = 'unverified' WHERE code = 'taobao'`.execute(
      app,
    );
  }
});

it('[AC-B1-05a#6] product_refs primary key is exactly (app_id, product_key)', async () => {
  await requireColumns('product_refs', ['app_id', 'product_key']);
  const pk = await sql<{ names: string[] }>`
    SELECT array_agg(a.attname::text ORDER BY k.ord) AS names
    FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(num, ord)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
    WHERE c.conrelid = to_regclass('app.product_refs') AND c.contype = 'p'
    GROUP BY c.oid
  `.execute(app);
  expect(pk.rows).toEqual([{ names: ['app_id', 'product_key'] }]);
  const key = `tb:${randomUUID()}`;
  expect(await sqlState(newRef({ product_key: key }))).toBe('ok');
  expect(await sqlState(newRef({ product_key: key }))).toBe('23505');
  expect(await sqlState(newRef({ product_key: key, app_id: 'couli_two' }))).toBe('ok');
  expect(await sqlState(newRef({ product_key: `${key}x` }))).toBe('ok');
});

it('[AC-B1-05a#7] product_key accepts boundary lengths, case and every allowed printable ASCII character', async () => {
  await requireColumns('product_refs', ['product_key']);
  const printable = Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i))
    .filter((c) => !['#', '/', '?'].includes(c))
    .join('');
  for (const [platform, key] of [
    ['taobao', 'tb:A'],
    ['taobao', 'tb:a'],
    ['taobao', `tb:${printable}`],
    ['taobao', `tb:${'X'.repeat(124)}`],
    ['pdd', `pdd:${'X'.repeat(124)}`],
    ['jd', 'jd:i_AbC_00001'],
  ]) {
    expect(await sqlState(newRef({ platform, product_key: key })), key).toBe('ok');
    const stored = await sql<{ key: string }>`SELECT product_key AS key FROM app.product_refs
      WHERE app_id = 'couli' AND product_key = ${key}`.execute(app);
    expect(stored.rows).toEqual([{ key }]);
  }
});

it('[AC-B1-05a#8] product_key CHECK rejects empty IDs, overlong IDs, missing separators and forbidden characters', async () => {
  await requireColumns('product_refs', ['product_key']);
  for (const key of [
    '',
    'tb',
    'tb:',
    ':abc',
    'tbabc',
    `tb:${'x'.repeat(125)}`,
    `pdd:${'x'.repeat(125)}`,
    'tb:a#b',
    'tb:a/b',
    'tb:a?b',
    'tb: x',
    'tb:x ',
    'tb:a\tb',
    'tb:a\nb',
    'tb:x\n',
    'tb:a\rb',
    'tb:\u001f',
    'tb:\u007f',
    'tb:中文',
    'tb:é',
  ]) {
    expect(
      await sqlState(
        newRef({ product_key: key, platform: key.startsWith('pdd:') ? 'pdd' : 'taobao' }),
      ),
      JSON.stringify(key),
    ).toBe('23514');
  }
});

it('[AC-B1-05a#9] product_refs accepts only search, detail, parse and pool sources', async () => {
  await requireColumns('product_refs', ['source']);
  for (const source of ['search', 'detail', 'parse', 'pool']) {
    expect(await sqlState(newRef({ source })), source).toBe('ok');
  }
  for (const source of ['order', 'order_sync', 'sync', 'SEARCH', '']) {
    expect(await sqlState(newRef({ source })), source).toBe('23514');
  }
  expect(await sqlState(newRef({ source: null }))).toBe('23502');
});

it('[AC-B1-05a#10] raw_item_id is text preserved verbatim and canonical_url can be null', async () => {
  const cols = await requireColumns('product_refs', [
    'raw_item_id',
    'canonical_url',
    'raw_fetched_at',
    'refreshed_at',
  ]);
  expect(cols.find((c) => c.name === 'raw_item_id')?.type).toBe('text');
  expect(cols.find((c) => c.name === 'canonical_url')?.nullable).toBe(true);
  for (const name of ['raw_fetched_at', 'refreshed_at']) {
    expect(cols.find((c) => c.name === name)?.type).toBe('timestamptz');
  }
  for (const platform of ['taobao', 'jd', 'pdd'] as const) {
    const key = `${PREFIXES[platform]}:${randomUUID()}`;
    const raw = `0000-AbC_签名 +/%?=#${'Z'.repeat(256)}`;
    expect(await sqlState(newRef({ product_key: key, platform, raw_item_id: raw }))).toBe('ok');
    const stored = await sql<{ raw: string; url: string | null; fetched: Date; refreshed: Date }>`
      SELECT raw_item_id AS raw, canonical_url AS url, raw_fetched_at AS fetched, refreshed_at AS refreshed
      FROM app.product_refs WHERE app_id = 'couli' AND product_key = ${key}
    `.execute(app);
    expect(stored.rows).toEqual([{ raw, url: null, fetched: NOW, refreshed: NOW }]);
  }
});

it('[AC-B1-05a#11] a written product_key cannot change while raw references can refresh', async () => {
  await requireColumns('product_refs', ['product_key', 'raw_item_id', 'refreshed_at']);
  const key = `tb:${randomUUID()}`;
  expect(await sqlState(newRef({ product_key: key }))).toBe('ok');
  const triggers = await sql<{ count: string }>`SELECT count(*)::text AS count FROM pg_trigger
    WHERE tgrelid = to_regclass('app.product_refs') AND NOT tgisinternal
      AND tgenabled IN ('O', 'A') AND (tgtype::int & 16) = 16`.execute(app);
  expect(Number(triggers.rows[0]?.count), 'enabled UPDATE prohibition trigger').toBeGreaterThan(0);
  for (const next of [`tb:${randomUUID()}`, null]) {
    const result = await sqlState(
      sql`UPDATE app.product_refs SET product_key = ${next}
      WHERE app_id = 'couli' AND product_key = ${key}`.execute(app),
    );
    expect(['P0001', '23514', '23502', '55000', '42501']).toContain(result);
    const stored = await sql<{ key: string }>`SELECT product_key AS key FROM app.product_refs
      WHERE app_id = 'couli' AND product_key = ${key}`.execute(app);
    expect(stored.rows).toEqual([{ key }]);
  }
  const later = new Date('2026-10-05T08:10:00Z');
  const updated = await sql`UPDATE app.product_refs SET raw_item_id = 'fresh-original',
    raw_fetched_at = ${later}, refreshed_at = ${later}
    WHERE app_id = 'couli' AND product_key = ${key}`.execute(app);
  expect(updated.numAffectedRows).toBe(1n);
  const stored = await sql<{ raw: string; refreshed: Date }>`SELECT raw_item_id AS raw,
    refreshed_at AS refreshed FROM app.product_refs WHERE app_id = 'couli' AND product_key = ${key}`.execute(
    app,
  );
  expect(stored.rows).toEqual([{ raw: 'fresh-original', refreshed: later }]);
});

it('[AC-B1-05a#12] product key aliases persist their audit data and remain one-to-one', async () => {
  await requireColumns('product_key_aliases', [
    'old_key',
    'new_key',
    'reason',
    'adr_id',
    'created_at',
  ]);
  const oldKey = `tb:${randomUUID()}`;
  const newKey = `tb:${randomUUID()}`;
  expect(await sqlState(newAlias(oldKey, newKey))).toBe('ok');
  const stored = await sql<
    Record<string, unknown>
  >`SELECT old_key, new_key, reason, adr_id, created_at
    FROM app.product_key_aliases WHERE old_key = ${oldKey}`.execute(app);
  expect(stored.rows).toEqual([
    {
      old_key: oldKey,
      new_key: newKey,
      reason: '一对一派生规则变更',
      adr_id: 'ADR-CATALOG-TEST',
      created_at: NOW,
    },
  ]);
  expect(await sqlState(newAlias(oldKey, `tb:${randomUUID()}`))).toBe('23505');
  expect(await sqlState(newAlias(`tb:${randomUUID()}`, newKey))).toBe('23505');
});

it('[AC-B1-05a#13] aliases are insert-only for the application role, including column-level privileges', async () => {
  await requireColumns('product_key_aliases', ['old_key', 'new_key']);
  const oldKey = `tb:${randomUUID()}`;
  const newKey = `tb:${randomUUID()}`;
  expect(await sqlState(newAlias(oldKey, newKey))).toBe('ok');
  const privileges = await sql<{ update: boolean; delete: boolean; truncate: boolean }>`
    SELECT has_any_column_privilege('couli_app', 'app.product_key_aliases', 'UPDATE') AS update,
      has_table_privilege('couli_app', 'app.product_key_aliases', 'DELETE') AS delete,
      has_table_privilege('couli_app', 'app.product_key_aliases', 'TRUNCATE') AS truncate
  `.execute(app);
  expect(privileges.rows).toEqual([{ update: false, delete: false, truncate: false }]);
  expect(
    await sqlState(
      sql`UPDATE app.product_key_aliases SET reason = 'changed'
    WHERE old_key = ${oldKey}`.execute(app),
    ),
  ).toBe('42501');
  expect(
    await sqlState(sql`DELETE FROM app.product_key_aliases WHERE old_key = ${oldKey}`.execute(app)),
  ).toBe('42501');
  const remaining = await sql<{ new_key: string }>`SELECT new_key FROM app.product_key_aliases
    WHERE old_key = ${oldKey}`.execute(app);
  expect(remaining.rows).toEqual([{ new_key: newKey }]);
});

it('[AC-B1-05a#14] tenant business tables require app_id and blocklist keyword is nullable', async () => {
  for (const table of ['product_refs', 'category_blocklist'] as const) {
    const cols = await requireColumns(table, ['app_id']);
    expect(cols.find((c) => c.name === 'app_id')).toMatchObject({ type: 'text', nullable: false });
  }
  // Dictionary / global derivation aliases need not be tenant-scoped. If scoped, no NULL tenant.
  for (const table of ['platforms', 'product_key_aliases'] as const) {
    const appId = (await columns(table)).find((c) => c.name === 'app_id');
    if (appId) expect(appId.nullable, `${table}.app_id`).toBe(false);
  }
  const cols = await requireColumns('category_blocklist', ['keyword', 'category_id']);
  expect(cols.find((c) => c.name === 'keyword')?.nullable).toBe(true);
  expect(cols.find((c) => c.name === 'category_id')?.type).toBe('text');
  expect(await sqlState(newRef({ app_id: null }))).toBe('23502');
  expect(await sqlState(newRef({ product_key: null }))).toBe('23502');
});

it('[AC-B1-05a#15] platform references retain foreign keys and no catalog foreign key cascades', async () => {
  for (const table of TABLES) {
    await columns(table);
    const fks = await sql<{
      column: string;
      schema: string;
      target: string;
      ref: string;
      del: string;
      upd: string;
    }>`
      SELECT a.attname AS column, n.nspname AS schema, t.relname AS target, fa.attname AS ref,
        c.confdeltype::text AS del, c.confupdtype::text AS upd
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.confrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey) k(num, fnum)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num
      JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fnum
      WHERE c.conrelid = to_regclass(${`app.${table}`}) AND c.contype = 'f'
    `.execute(app);
    if (table === 'product_refs' || table === 'category_blocklist') {
      expect(fks.rows, `${table}.platform -> platforms.code`).toContainEqual(
        expect.objectContaining({
          column: 'platform',
          schema: 'app',
          target: 'platforms',
          ref: 'code',
        }),
      );
    }
    for (const fk of fks.rows) {
      expect(['a', 'r'], `${table}.${fk.column} ON DELETE`).toContain(fk.del);
      expect(['a', 'r'], `${table}.${fk.column} ON UPDATE`).toContain(fk.upd);
    }
  }
  expect(await sqlState(newRef({ platform: 'nonexistent_platform' }))).toBe('23503');
});

it('[AC-B1-05a#16] catalog grants allow the writer and reader, never unrelated-role writes or PUBLIC access', async () => {
  for (const table of TABLES) {
    await columns(table);
    const name = `app.${table}`;
    const writer = await sql<{ select: boolean; insert: boolean; update: boolean }>`
      SELECT has_table_privilege('couli_app', ${name}, 'SELECT') AS select,
        has_table_privilege('couli_app', ${name}, 'INSERT') AS insert,
        has_any_column_privilege('couli_app', ${name}, 'UPDATE') AS update
    `.execute(app);
    expect(writer.rows, table).toEqual([
      { select: true, insert: true, update: table !== 'product_key_aliases' },
    ]);
    const reader = await sql<{
      held: boolean;
    }>`SELECT has_table_privilege('couli_readonly', ${name}, 'SELECT') AS held`.execute(app);
    expect(reader.rows, table).toEqual([{ held: true }]);
    const excessive = await sql<{ role: string; privilege: string }>`
      SELECT r AS role, p AS privilege
      FROM unnest(ARRAY['couli_readonly', 'couli_payout', 'couli_maint']) r
      CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
      WHERE has_table_privilege(r, ${name}, p)
        OR CASE WHEN p IN ('INSERT', 'UPDATE', 'REFERENCES')
          THEN has_any_column_privilege(r, ${name}, p) ELSE false END
    `.execute(app);
    expect(excessive.rows, table).toEqual([]);
    const publicAcl = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM (
        SELECT acl.grantee FROM pg_class c
        CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
        WHERE c.oid = to_regclass(${name})
        UNION ALL
        SELECT acl.grantee FROM pg_attribute a
        CROSS JOIN LATERAL aclexplode(a.attacl) acl
        WHERE a.attrelid = to_regclass(${name}) AND a.attnum > 0 AND NOT a.attisdropped
      ) grants WHERE grantee = 0
    `.execute(app);
    expect(publicAcl.rows, table).toEqual([{ n: '0' }]);
    const ddl = await sql<{
      held: boolean;
    }>`SELECT has_table_privilege('couli_app', ${name}, 'TRUNCATE')
      OR has_table_privilege('couli_app', ${name}, 'TRIGGER')
      OR has_any_column_privilege('couli_app', ${name}, 'REFERENCES') AS held`.execute(app);
    expect(ddl.rows, table).toEqual([{ held: false }]);
  }
});
