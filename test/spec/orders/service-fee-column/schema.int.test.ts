import { readFile, readdir } from 'node:fs/promises';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fresh, fakePort, runFresh } from '../commission-snapshot/db-kit.ts';
import { requireFeeColumn, readFee, setFee } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-08v#1] 父表与默认分区均有 bigint 可空无默认服务费列', async () => {
  await requireFeeColumn(db);
  const inherited = await sql<{ parent: string; child: string }>`
    select inhparent::regclass::text as parent, inhrelid::regclass::text as child
    from pg_inherits where inhparent = 'app.orders'::regclass
      and inhrelid = 'app.orders_default'::regclass`.execute(db);
  expect(inherited.rows).toEqual([{ parent: 'app.orders', child: 'app.orders_default' }]);
});

it('[AC-B1-08v#2] 业务角色可插入和更新服务费，支持大整数及 NULL', async () => {
  await requireFeeColumn(db);
  const f = await fresh(db, {
    service_fee_fen: 9_007_199_254_740_993n,
    est_commission_fen: 9_007_199_254_741_782n,
  });
  expect(await runFresh(f, fakePort())).toMatchObject({ ok: true, value: { kind: 'inserted' } });
  expect(await readFee(db, f.ctx.app_id)).toEqual([
    { order_id: (await f.read()).orders[0]!.order_id, service_fee_fen: 9_007_199_254_740_993n },
  ]);
  await setFee(db, f.ctx.app_id, 9_007_199_254_740_995n);
  expect((await readFee(db, f.ctx.app_id))[0]?.service_fee_fen).toBe(9_007_199_254_740_995n);
  await setFee(db, f.ctx.app_id, null);
  expect((await readFee(db, f.ctx.app_id))[0]?.service_fee_fen).toBeNull();
});

it('[AC-B1-08v#3] 新迁移只扩展父表，不回填、不给默认值、不改约束或授权', async () => {
  const dir = new URL('../../../../db/migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((name) => /^\d{4}_orders-service-fee\.sql$/.test(name));
  expect(files).toHaveLength(1);
  const migration = await readFile(new URL(files[0]!, dir), 'utf8');
  expect(migration.startsWith('-- Up Migration')).toBe(true);
  const statements = migration
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  expect(statements).toHaveLength(3);
  expect(statements[0]).toMatch(/^SET\s+LOCAL\s+lock_timeout\s*=\s*'[1-9]\d*(?:ms|s|min)'$/i);
  expect(statements[1]).toMatch(/^SET\s+LOCAL\s+statement_timeout\s*=\s*'[1-9]\d*(?:ms|s|min)'$/i);
  expect(statements[2]).toMatch(
    /^ALTER\s+TABLE\s+app\.orders\s+ADD\s+COLUMN\s+service_fee_fen\s+bigint$/i,
  );
});
