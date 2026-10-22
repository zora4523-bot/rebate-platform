// B1-15f: the expiry as app.module assembles it for the worker, over PostgreSQL with real ledger
// rows (brief §9.2 #4: the balance port is B1-15d's, over the ledger's getBalances on the caller's
// transaction, no account → 0; the withdrawal port is app.module's truthful "none" until B2-05).
// The module is built from the options app.module passes (captured on the worker entry, names not
// read) in a harness with CLOCK, ROOT_LOGGER, APP_CONFIG and DB only. Nothing here mocks the ledger.
import { createDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  capturedWorkerOptions,
  identity,
  owner,
  ports,
  request,
  seedLedgerBalance,
  seedRequest,
  userRow,
  workerHarness,
  type Runner,
} from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 6 });
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
    const context = await workerHarness(p, module, 'test', db);
    const runner = context.get(api.deletionExpiryToken()) as Runner;
    return { p, runner, close: () => context.close() };
  } finally {
    vi.restoreAllMocks();
  }
}

it('[AC-B1-15f#31] 装配版：账本余额 -1 分 → cancelled（negative_balance）；0 分、正数、无账户 → processing 且 users=deleting', async () => {
  const negative = await owner(db);
  const zero = await owner(db, { appId: negative.appId });
  const positive = await owner(db, { appId: negative.appId });
  const none = await owner(db, { appId: negative.appId });
  await seedLedgerBalance(db, negative, -1n);
  await seedLedgerBalance(db, zero, 0n);
  await seedLedgerBalance(db, positive, 9_007_199_254_740_993n);
  const rows = {
    negative: await seedRequest(db, negative),
    zero: await seedRequest(db, zero),
    positive: await seedRequest(db, positive),
    none: await seedRequest(db, none),
  };
  const negativeUser = await userRow(db, negative);
  const a = await assembledRunner();
  try {
    await a.runner.runOnce();
    const now = a.p.clock.now();
    expect(await request(db, rows.negative.id)).toEqual({
      ...rows.negative,
      status: 'cancelled',
      cancel_reason: 'negative_balance',
      cancelled_at: now,
      row_version: rows.negative.row_version + 1,
      updated_at: now,
    });
    expect(await userRow(db, negative)).toEqual(negativeUser);
    for (const [o, row] of [
      [zero, rows.zero],
      [positive, rows.positive],
      [none, rows.none],
    ] as const) {
      expect(await request(db, row.id)).toEqual({
        ...row,
        status: 'processing',
        row_version: row.row_version + 1,
        updated_at: now,
      });
      expect((await userRow(db, o)).status).toBe('deleting');
    }
  } finally {
    await a.close();
  }
}, 60_000);
