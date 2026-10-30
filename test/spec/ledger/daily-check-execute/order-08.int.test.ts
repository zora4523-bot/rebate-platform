// B2-02p: ⑧ (CREDITED sub-order already invalid) is an account-level difference per BR-FUND-19
// (账户级差异（①⑥⑦⑧）：告警、生成差错单，并冻结涉及用户的提现) — whatever the scope of the SQL
// row, it never switches settle.auto.enabled off. One recon diff per sub-order (ref_type order,
// ref_id 08:<order_key>); every located beneficiary held once; for a row with no located account
// the users of detail.unlocated_user_ids are held, and with none the diff is only registered.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  APP,
  DAY,
  TIMEOUT,
  diffByRef,
  diffsOf,
  executedOf,
  expectDetailKept,
  expectHold,
  expectRegistered,
  holdInput,
  holdsOf,
  invalidCreditedAccountDiff,
  invalidCreditedGlobalDiff,
  member,
  orderKey,
  userAccount,
  withHarness,
} from './kit.ts';

it(
  '[AC-B2-02p#31] ⑧ 同一子订单两位受益人各一行 account：恰 1 张差错单（08:<子订单键>），两人各 1 条冻结，不关开关',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const first = await userAccount(h);
      const second = await userAccount(h);
      const bystander = await userAccount(h);
      const key = orderKey();
      const order = {
        orderKey: key,
        orderId: randomUUID(),
        beneficiaryUserIds: [first.userId, second.userId],
        unlocatedUserIds: [],
      };
      const execution = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [
          invalidCreditedAccountDiff(order, first),
          invalidCreditedAccountDiff(order, second),
        ],
      });
      const rows = await diffsOf(h);
      expect(rows.map((row) => row.ref_id)).toEqual([`08:${key}`]);
      const diff = rows[0]!;
      expectRegistered(diff, {
        refType: 'order',
        refId: `08:${key}`,
        expectedFen: 0n,
        actualFen: 0n,
      });
      const holds = await holdsOf(h);
      expect(holds.map((hold) => hold.user_id).sort()).toEqual(
        [first.userId, second.userId].sort(),
      );
      for (const hold of holds) expectHold(hold, diff, hold.user_id, h);
      expect(holds.some((hold) => hold.user_id === bystander.userId)).toBe(false);
      for (const call of h.holds.calls) {
        expect(call).toMatchObject({ diffInTransaction: true, diffOutside: false });
      }
      expect([...executedOf(execution, diff).heldUserIds].sort()).toEqual(
        [first.userId, second.userId].sort(),
      );
      expect(h.settle.turnOffs).toEqual([]);
      expect(h.settle.events).toEqual([]);
      expect(h.settle.alerts).toEqual([]);
      expect(execution.autoSettlementOff).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#32] ⑧ 的 global 行（受益人都没有账户）：仍不关开关；detail.unlocated_user_ids 给出的用户照样各加 1 条冻结',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const unlocated = await member(h);
      const key = orderKey();
      const difference = invalidCreditedGlobalDiff({
        orderKey: key,
        orderId: randomUUID(),
        beneficiaryUserIds: [unlocated],
        unlocatedUserIds: [unlocated],
      });
      const execution = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [difference],
      });
      const diff = await diffByRef(h, `08:${key}`);
      expectRegistered(diff, {
        refType: 'order',
        refId: `08:${key}`,
        expectedFen: 0n,
        actualFen: 0n,
      });
      expectDetailKept(diff, difference);
      expect(h.holds.calls.map((call) => call.input)).toEqual([holdInput(diff, unlocated)]);
      const holds = await holdsOf(h);
      expect(holds).toHaveLength(1);
      expectHold(holds[0], diff, unlocated, h);
      expect(executedOf(execution, diff).heldUserIds).toEqual([unlocated]);
      expect(h.settle.turnOffs).toEqual([]);
      expect(h.settle.events).toEqual([]);
      expect(h.settle.alerts).toEqual([]);
      expect(execution.autoSettlementOff).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#33] ⑧ 的 global 行没有任何可冻结的用户：只登记差错单并告警，不冻结、不关开关',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const key = orderKey();
      const execution = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [
          invalidCreditedGlobalDiff({
            orderKey: key,
            orderId: randomUUID(),
            beneficiaryUserIds: [],
            unlocatedUserIds: [],
          }),
        ],
      });
      const diff = await diffByRef(h, `08:${key}`);
      expect(executedOf(execution, diff)).toMatchObject({ inserted: true, heldUserIds: [] });
      expect(h.holds.calls).toEqual([]);
      expect(await holdsOf(h)).toEqual([]);
      expect(h.settle.turnOffs).toEqual([]);
      expect(h.settle.alerts).toEqual([]);
      expect(execution.autoSettlementOff).toEqual([]);
      // Warnings and errors only (the logger has no other level).
      const named = h.logs.filter((line) => line.fields['invariant'] === '08');
      expect(
        named.map((line) => line.fields['app_id']),
        JSON.stringify(h.logs),
      ).toContain(APP);
    });
  },
  TIMEOUT,
);
