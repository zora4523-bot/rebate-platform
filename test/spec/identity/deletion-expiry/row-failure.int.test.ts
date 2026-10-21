// B1-15f (rule-test review r1, S1): 08 BR-ID-27; brief §9.2 #2 「单行出错 warn（error_name）继续」.
// In one round, a due request whose processing fails on every attempt (the withdrawal port throws
// for that user only: a deterministic injection, no timing) is one warn line {error_name} and stays
// as it was; the later due requests of the same round still reach their outcome. The runner is
// built in the test body over kit.ts's database, clock and logger, with ports answering from the
// kit's per-user tables. The baseline red is NotImplemented.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  DEFERRED,
  NOW,
  close,
  fields,
  open,
  owner,
  request,
  reset,
  seedRequest,
  userRow,
  type BalancePort,
  type Kit,
  type Owner,
  type PortInput,
  type WithdrawalsPort,
} from './kit.ts';

let database: TestDatabase;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  kit = await open(database);
}, 180_000);
beforeEach(async () => {
  await reset(kit);
});
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    await database?.drop();
  }
});

const key = (input: PortInput) => `${input.appId}/${input.userId}`;

/** Answers from the kit's per-user table, except that it throws a TypeError for `broken`. */
function failingFor(broken: Owner): WithdrawalsPort & { failures: () => number } {
  let failures = 0;
  return {
    hasNonTerminal(_trx: Transaction<DB>, input: PortInput) {
      if (input.appId === broken.appId && input.userId === broken.uid) {
        failures += 1;
        return Promise.reject(new TypeError('synthetic-withdrawal-port-detail'));
      }
      return Promise.resolve(kit.nonTerminal.get(key(input)) ?? false);
    },
    failures: () => failures,
  };
}

const balance: BalancePort = {
  availableFen: (_trx: Transaction<DB>, input: PortInput) =>
    Promise.resolve(kit.balances.get(key(input)) ?? 0n),
};

it('[AC-B1-15f#39] 同一轮里前一张到期单处理出错 → 一行 warn（error_name）且该单不动，后面的到期单照常处理', async () => {
  const broken = await owner(kit.db);
  const later = await owner(kit.db);
  const negative = await owner(kit.db);
  const brokenRow = await seedRequest(kit.db, broken, {
    coolingUntil: new Date(Date.parse(NOW) - 3 * 3_600_000),
  });
  const laterRow = await seedRequest(kit.db, later, {
    coolingUntil: new Date(Date.parse(NOW) - 2 * 3_600_000),
  });
  const negativeRow = await seedRequest(kit.db, negative, { coolingUntil: new Date(NOW) });
  kit.setBalance(negative, -5n);
  const brokenUser = await userRow(kit.db, broken);
  const withdrawals = failingFor(broken);
  const runner = kit.api.createDeletionExpiry({
    db: kit.db,
    clock: kit.clock,
    logger: kit.logger,
    withdrawals,
    balance,
    calendar: { configValue: async () => null },
  });
  await runner.runOnce();
  expect(withdrawals.failures()).toBe(1);
  expect(await request(kit.db, brokenRow.id)).toEqual(brokenRow);
  expect(await userRow(kit.db, broken)).toEqual(brokenUser);
  const now = kit.clock.now();
  expect(await request(kit.db, laterRow.id)).toEqual({
    ...laterRow,
    status: 'processing',
    row_version: laterRow.row_version + 1,
    updated_at: now,
  });
  expect((await userRow(kit.db, later)).status).toBe('deleting');
  expect(await request(kit.db, negativeRow.id)).toMatchObject({
    status: 'cancelled',
    cancel_reason: 'negative_balance',
    cancelled_at: now,
  });
  const failed = kit.logs().filter((line) => line['level'] === 40 && line['msg'] !== DEFERRED);
  expect(failed).toHaveLength(1);
  expect(fields(failed[0]!)).toEqual({ error_name: 'TypeError' });
  expect(kit.lines.join('')).not.toContain('synthetic-withdrawal-port-detail');
  // The failing request is retried by the next round (it is still cooling and due).
  await runner.runOnce();
  expect(withdrawals.failures()).toBe(2);
  expect(await request(kit.db, brokenRow.id)).toEqual(brokenRow);
});
