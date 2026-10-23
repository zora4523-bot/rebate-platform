import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { gate, TIMEOUTS } from '../lint-migrations/kit.ts';
import { AT, TIMEOUT, close, insert, open, sqlState, type Harness, type Row } from './kit.ts';
import {
  SHAPES,
  TABLES,
  attempt,
  batch,
  columns,
  fixture,
  item,
  ready,
  stored,
  watermark,
  writer,
  type CoreTable,
} from './core-kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

for (const table of TABLES) {
  it(`[AC-B2-06a#1] ${table} 列名、类型、可空性和默认值逐一匹配，无批准或完成状态字段`, async () => {
    await ready(h.app);
    const found = await columns(h.app, table);
    expect(found.map((c) => c.name).sort()).toEqual(Object.keys(SHAPES[table]).sort());
    for (const [name, [type, nullable, default_expr]] of Object.entries(SHAPES[table])) {
      expect(found, name).toContainEqual({ name, type, nullable, default_expr });
    }
  });

  it(`[AC-B2-06a#2] ${table} 必填列拒绝 NULL，主键全局唯一，显式业务时刻原样保留`, async () => {
    await ready(h.app);
    const f = await fixture(h);
    const rows = {
      payout_batches: batch(f.owner.app_id),
      payout_batch_items: item(f),
      payout_attempts: attempt(f),
      payout_watermarks: watermark(f.owner.app_id),
    };
    const row = rows[table];
    const db = writer(h, table);
    for (const [name, [, nullable]] of Object.entries(SHAPES[table])) {
      if (!nullable)
        expect(await sqlState(insert(db, table, { ...row, [name]: null })), name).toBe('23502');
    }
    expect(await sqlState(insert(db, table, row))).toBe('ok');
    expect(await sqlState(insert(db, table, { ...row, app_id: `other-${randomUUID()}` }))).toBe(
      '23505',
    );
    const clockColumn =
      table === 'payout_batches' || table === 'payout_watermarks' ? 'created_at' : 'at';
    expect((await stored(h.app, table, row['id']))[0]).toMatchObject({ [clockColumn]: AT });
    const withoutDefault: Row = { ...row, id: randomUUID() };
    delete withoutDefault[clockColumn];
    await insert(db, table, withoutDefault);
    expect((await stored(h.app, table, withoutDefault['id']))[0]?.[clockColumn]).toBeInstanceOf(
      Date,
    );
    const pk = await sql<{ keys: string[] }>`SELECT
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS keys
      FROM pg_constraint c WHERE c.conrelid = to_regclass(${`app.${table}`}) AND c.contype = 'p'`.execute(
      h.app,
    );
    expect(pk.rows).toEqual([{ keys: ['id'] }]);
  });
}

const INDEXES: { table: CoreTable; keys: string[]; transfer?: boolean; descending?: boolean }[] = [
  { table: 'payout_batches', keys: ['app_id', 'created_at'] },
  { table: 'payout_batch_items', keys: ['batch_id', 'at'] },
  { table: 'payout_batch_items', keys: ['withdrawal_id', 'at'] },
  { table: 'payout_attempts', keys: ['withdrawal_id', 'at'] },
  { table: 'payout_attempts', keys: ['app_id', 'at'], transfer: true },
  { table: 'payout_watermarks', keys: ['app_id', 'channel', 'measured_at'], descending: true },
];
for (const { table, keys, transfer, descending } of INDEXES) {
  it(`[AC-B2-06a#3] ${table} (${keys.join(',')}) 索引列顺序、方向与筛选范围正确`, async () => {
    await ready(h.app);
    const found = await sql<{
      keys: string[];
      valid: boolean;
      ready: boolean;
      unique: boolean;
      method: string;
      predicate: string | null;
      directions: number[];
    }>`SELECT ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
        WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS keys,
      i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique, am.amname::text AS method,
      pg_get_expr(i.indpred, i.indrelid) AS predicate,
      ARRAY(SELECT (v::integer & 1) FROM unnest(i.indoption) WITH ORDINALITY o(v, n) ORDER BY n) AS directions
      FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid JOIN pg_am am ON am.oid = idx.relam
      WHERE i.indrelid = to_regclass(${`app.${table}`})`.execute(h.app);
    const matches = found.rows.filter((r) => r.keys.join(',') === keys.join(','));
    expect(matches).not.toHaveLength(0);
    const index = matches.find((r) => (transfer ? r.predicate !== null : r.predicate === null));
    expect(index).toMatchObject({
      valid: true,
      ready: true,
      unique: false,
      method: 'btree',
      directions: keys.map((_, n) => (descending && n === keys.length - 1 ? 1 : 0)),
    });
    if (!transfer) expect(index?.predicate).toBeNull();
    else {
      expect(index?.predicate).toBeTypeOf('string');
      // Evaluate the actual predicate instead of coupling to PostgreSQL's SQL formatting.
      const values = await sql
        .raw<{ kind: string; included: boolean }>(
          `SELECT kind, (${index!.predicate}) AS included FROM (VALUES ('transfer'), ('query'), ('cancel')) s(kind) ORDER BY kind`,
        )
        .execute(h.app);
      expect(values.rows).toEqual([
        { kind: 'cancel', included: false },
        { kind: 'query', included: false },
        { kind: 'transfer', included: true },
      ]);
    }
  });
}

it('[AC-B2-06a#4] 全部外键已验证且禁止级联，withdrawals.batch_id 补上批次引用', async () => {
  await ready(h.app);
  for (const [table, column, target] of [
    ['payout_batch_items', 'batch_id', 'payout_batches'],
    ['payout_batch_items', 'withdrawal_id', 'withdrawals'],
    ['payout_batch_items', 'moved_to_batch_id', 'payout_batches'],
    ['payout_attempts', 'withdrawal_id', 'withdrawals'],
    ['withdrawals', 'batch_id', 'payout_batches'],
  ] as const) {
    const found = await sql<{
      name: string;
      source: string[];
      target: string;
      target_columns: string[];
      valid: boolean;
      deletion: string;
      updating: string;
    }>`SELECT c.conname::text AS name,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS source,
      c.confrelid::regclass::text AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord) AS target_columns,
      c.convalidated AS valid, c.confdeltype::text AS deletion, c.confupdtype::text AS updating
      FROM pg_constraint c WHERE c.conrelid = to_regclass(${`app.${table}`}) AND c.contype = 'f'`.execute(
      h.app,
    );
    const fk = found.rows.find((r) => r.source.join(',') === column);
    expect(fk, `${table}.${column}`).toMatchObject({
      target: `app.${target}`,
      target_columns: ['id'],
      valid: true,
    });
    expect(fk?.name).toBeTruthy();
    expect(['a', 'r']).toContain(fk?.deletion);
    expect(['a', 'r']).toContain(fk?.updating);
    if (table === 'withdrawals') expect(fk?.name).toBe('withdrawals_batch_fkey');
  }
});

it('[AC-B2-06a#5] 四张打款表均受资金迁移门禁保护，不允许 squawk-ignore 豁免', async () => {
  await ready(h.app);
  const guard = await gate();
  for (const table of TABLES) {
    expect(guard.isFundsTable(`app.${table}`), table).toBe(true);
    for (const ddl of [
      `DROP TABLE app.${table};`,
      `ALTER TABLE app.${table} RENAME TO removed;`,
      `TRUNCATE app.${table};`,
      `ALTER TABLE app.${table} ALTER COLUMN app_id TYPE varchar(100);`,
    ]) {
      const problems = guard.checkMigration(
        '9999_payout-guard-probe.sql',
        TIMEOUTS + '-- squawk-ignore ban-drop-table\n' + ddl,
      );
      expect(problems, ddl).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining('no exceptions there') }),
        ]),
      );
    }
  }
});
