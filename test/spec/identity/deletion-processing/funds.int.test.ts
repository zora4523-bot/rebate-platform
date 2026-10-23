// B1-15g: the closing-adjustment gate of the completion transaction (D10-137 ①: a balance never
// passes to done; BR-FUND-24 ⑧: the ACCOUNT_CLOSED adjustment must be finished before done;
// brief §9.2 #3 ③, #4 funds; §9.3 item 8). The port is asked inside the completion transaction
// with the user's row locked; anything but none_needed / done keeps the request in processing with
// one identity_deletion_adjustment_pending line a day. Until the funds port exists the stand-in
// closingAdjustmentFromBalance (identity) judges by available_fen on the same transaction.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  ADJUSTMENT_PENDING,
  DAY_MS,
  HOUR_MS,
  at,
  close,
  deletedIdentitiesOf,
  open,
  processing,
  request,
  reset,
  userRow,
  warnings,
  type Kit,
  type Member,
} from './kit.ts';

let database: TestDatabase;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  kit = await open(database);
}, 180_000);
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    await database?.drop();
  }
});
beforeEach(async () => {
  await reset(kit);
});

it('[AC-B1-15g#17] 调账端口答 pending → 清理与 Apple 照常、不置 done、users 不成墓碑、不写 deleted_identities；同日只 warn 一次 adjustment_pending', async () => {
  const { m, row } = await processing(kit.db);
  kit.setAdjustment(m, 'pending');
  const runner = kit.runner();
  await runner.runOnce();
  kit.clock.set(at(HOUR_MS));
  await runner.runOnce();
  const req = await request(kit.db, row.id);
  expect(req).toMatchObject({ status: 'processing', processed_at: null });
  expect(req.cleaned_at).not.toBeNull();
  expect((await userRow(kit.db, m)).status).toBe('deleting');
  expect(await deletedIdentitiesOf(kit.db, m.appId)).toEqual([]);
  const pending = warnings(kit, ADJUSTMENT_PENDING, m.appId);
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ app_id: m.appId, deletion_request_id: row.id });
  expect(kit.callsOf('funds', m)).toEqual(
    Array.from({ length: 2 }, () => ({
      port: 'funds',
      input: { appId: m.appId, userId: m.uid },
      inTransaction: true,
      userRowLocked: true,
    })),
  );
  // Next day, still pending: one more line; then approved → done on the next round.
  kit.clock.set(at(DAY_MS));
  await runner.runOnce();
  expect(warnings(kit, ADJUSTMENT_PENDING, m.appId)).toHaveLength(2);
  kit.setAdjustment(m, 'done');
  kit.clock.set(at(DAY_MS + HOUR_MS));
  await runner.runOnce();
  expect(await request(kit.db, row.id)).toMatchObject({
    status: 'done',
    processed_at: kit.clock.now(),
  });
  expect((await userRow(kit.db, m)).status).toBe('deleted');
});

it.each(['none_needed', 'done'] as const)(
  '[AC-B1-15g#18] 调账端口答 %s → 同轮完成，不告警',
  async (answer) => {
    const { m, row } = await processing(kit.db);
    kit.setAdjustment(m, answer);
    await kit.runner().runOnce();
    expect((await request(kit.db, row.id)).status).toBe('done');
    expect(warnings(kit, ADJUSTMENT_PENDING)).toEqual([]);
  },
);

it('[AC-B1-15g#19] 调账端口未上线时按余额判定（同事务读 available_fen）：> 0 或 < 0 → 不置 done 并告警；回到 0 → 完成', async () => {
  const balances = new Map<string, bigint>();
  const balanceCalls: { inTransaction: boolean; input: object }[] = [];
  const balance = {
    async availableFen(trx: Transaction<DB>, input: { appId: string; userId: string }) {
      balanceCalls.push({ inTransaction: trx.isTransaction, input: { ...input } });
      return balances.get(input.userId) ?? 0n;
    },
  };
  const positive = await processing(kit.db);
  const negative = await processing(kit.db);
  const zero = await processing(kit.db);
  const set = (o: Member, fen: bigint) => balances.set(o.uid, fen);
  set(positive.m, 800n);
  set(negative.m, -5n);
  set(zero.m, 0n);
  const runner = kit.runner({ funds: kit.api.closingAdjustmentFromBalance(balance) });
  await runner.runOnce();
  expect((await request(kit.db, positive.row.id)).status).toBe('processing');
  expect((await request(kit.db, negative.row.id)).status).toBe('processing');
  expect((await request(kit.db, zero.row.id)).status).toBe('done');
  expect(
    warnings(kit, ADJUSTMENT_PENDING)
      .map((line) => line['deletion_request_id'])
      .sort(),
  ).toEqual([positive.row.id, negative.row.id].sort());
  expect(balanceCalls.every((call) => call.inTransaction)).toBe(true);
  expect(balanceCalls.map((call) => call.input)).toEqual(
    expect.arrayContaining(
      [positive.m, negative.m, zero.m].map((o) => ({ appId: o.appId, userId: o.uid })),
    ),
  );
  set(positive.m, 0n);
  set(negative.m, 0n);
  kit.clock.set(at(HOUR_MS));
  await runner.runOnce();
  for (const r of [positive.row, negative.row]) {
    expect((await request(kit.db, r.id)).status).toBe('done');
  }
});
