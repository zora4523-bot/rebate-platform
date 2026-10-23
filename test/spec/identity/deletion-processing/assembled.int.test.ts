// B1-15g (brief §9.2 #1; §9.3 item 13): the worker's deletion runner as app.module assembles it,
// over PostgreSQL. No new timer: the token of IdentityDeletionExpiryModule (deletionExpiryToken)
// is one runner that does the processing round first and the cooling-period expiry second, so a
// request that enters processing in this round is cleaned only in the next one. The module is
// built from the options app.module passes on the worker entry (names not read), in a harness that
// offers CLOCK, ROOT_LOGGER, APP_CONFIG, DB and FIELD_CRYPTO only. Only facts that hold whichever
// owner ports are shipped are asserted (the cleanup runs, the order of the two rounds).
import { createDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  TOMBSTONE_NICKNAME,
  capturedWorkerOptions,
  device,
  fieldCrypto,
  identity,
  member,
  ports,
  processing,
  request,
  seedRequest,
  session,
  sessionsOf,
  userRow,
  workerHarness,
  type Runner,
} from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    await db?.destroy();
  } finally {
    await database?.drop();
  }
});

async function assembledRunner() {
  const api = await identity();
  const p = await ports();
  try {
    const options = await capturedWorkerOptions(api, p);
    const module = api.IdentityDeletionExpiryModule.forWorker(options as never);
    const context = await workerHarness(p, module, 'test', db, await fieldCrypto());
    const runner = context.get(api.deletionExpiryToken()) as Runner;
    return { p, runner, close: () => context.close() };
  } finally {
    vi.restoreAllMocks();
  }
}

it('[AC-B1-15g#33] 装配版：一轮先处理 processing（清理照常进行）、后做冷静期到期；同轮新进 processing 的单下一轮才清理', async () => {
  const old = await processing(db);
  const oldDevice = await device(db, old.m.appId);
  await session(db, old.m, oldDevice.id);
  const fresh = await member(db, { status: 'normal' });
  const freshRow = await seedRequest(db, fresh, { status: 'cooling' });
  const freshDevice = await device(db, fresh.appId);
  await session(db, fresh, freshDevice.id);
  const a = await assembledRunner();
  try {
    await a.runner.runOnce();
    expect((await userRow(db, old.m)).nickname).toBe(TOMBSTONE_NICKNAME);
    expect((await sessionsOf(db, old.m.appId)).map((s) => s.revoke_reason)).toEqual([
      'account_deleted',
    ]);
    // The cooling request moved to processing in this round (B1-15f), after the processing round.
    expect(await request(db, freshRow.id)).toMatchObject({
      status: 'processing',
      cleaned_at: null,
    });
    expect(await userRow(db, fresh)).toMatchObject({ status: 'deleting', nickname: '小狸' });
    expect((await sessionsOf(db, fresh.appId)).map((s) => s.revoked_at)).toEqual([null]);
    await a.runner.runOnce();
    expect((await userRow(db, fresh)).nickname).toBe(TOMBSTONE_NICKNAME);
    expect((await sessionsOf(db, fresh.appId)).map((s) => s.revoke_reason)).toEqual([
      'account_deleted',
    ]);
  } finally {
    await a.close();
  }
}, 60_000);
