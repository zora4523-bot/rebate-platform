// B1-28f (brief B.5): the catalog cleanup port as app.module assembles it, over PostgreSQL as
// couli_app. First the assembled step itself on a caller's transaction, then the worker's deletion
// round (IdentityDeletionExpiryModule built from the options app.module passes on the worker entry,
// in a harness that offers CLOCK, ROOT_LOGGER, APP_CONFIG, DB and FIELD_CRYPTO only): after the
// round the processing user's favorites are gone and no cleanup_blocked line names catalog. Facts
// about the other owners' ports (still markers or shipped) are not asserted.
// Only the orchestrator runs this file, with the shared integration global setup.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { DeletionCleanupStep } from '../../../../apps/api/src/modules/identity/ports/deletion-cleanup.ts';
import {
  CLEANUP_BLOCKED,
  capturedWorkerOptions,
  fieldCrypto,
  identity,
  member,
  ports,
  processing,
  warnings,
  workerHarness,
  type Runner,
} from '../../identity/deletion-processing/kit.ts';
import { countOf } from '../favorites/db-kit.ts';
import { assembledCleanup, bystanders, fixture, lockUserRow } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

it('[AC-B1-28f#8] 装配版 catalog 端口在调用方事务里删掉该用户本 app 的全部收藏，别人的不动', async () => {
  const api = await identity();
  const p = await ports();
  const cleanup = assembledCleanup(await capturedWorkerOptions(api, p), p);
  vi.restoreAllMocks();
  expect(cleanup.catalog).toBeTypeOf('function');
  const step = cleanup.catalog as DeletionCleanupStep;
  const m = await member(db);
  const f = await fixture(db, { appId: m.appId, userId: m.uid });
  const before = await bystanders(db, f);
  await db.transaction().execute(async (trx) => {
    expect(await lockUserRow(trx, m.appId, m.uid)).toBe(1);
    await step(trx, f.input);
    expect(await countOf(trx, f.appId, f.userId)).toBe(0);
    expect(await countOf(db, f.appId, f.userId)).toBe(f.seeded);
  });
  expect(await countOf(db, f.appId, f.userId)).toBe(0);
  expect(await bystanders(db, f)).toStrictEqual(before);
}, 60_000);

it('[AC-B1-28f#9] 装配版注销清理跑完一轮：processing 用户的收藏为空，cleanup_blocked 不再点名 catalog', async () => {
  const api = await identity();
  const p = await ports();
  let options: unknown;
  try {
    options = await capturedWorkerOptions(api, p);
  } finally {
    vi.restoreAllMocks();
  }
  const { m, row } = await processing(db);
  const f = await fixture(db, { appId: m.appId, userId: m.uid });
  const before = await bystanders(db, f);
  const context = await workerHarness(
    p,
    api.IdentityDeletionExpiryModule.forWorker(options as never),
    'test',
    db,
    await fieldCrypto(),
  );
  try {
    const runner = context.get(api.deletionExpiryToken()) as Runner;
    await runner.runOnce();
  } finally {
    await context.close();
  }
  expect(await countOf(db, f.appId, f.userId)).toBe(0);
  expect(await bystanders(db, f)).toStrictEqual(before);
  const blocked = warnings(p, CLEANUP_BLOCKED, m.appId).filter(
    (line) => line['deletion_request_id'] === row.id,
  );
  expect(blocked.map((line) => line['port'])).not.toContain('catalog');
}, 60_000);
