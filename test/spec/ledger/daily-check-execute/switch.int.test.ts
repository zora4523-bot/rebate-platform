// B2-02p: an app with a non pay- global difference gets settle.auto.enabled switched off once
// through the content port (系统关闭不需 step-up), alerted only after the commit; account-level
// and pay- differences never switch it.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  APP,
  DAY,
  OTHER,
  SWITCH_KEY,
  SWITCH_REASON_MAX,
  SWITCH_SOURCE,
  SWITCH_SOURCE_MAX,
  TIMEOUT,
  balanceCacheDiff,
  diffsOf,
  duplicateCredits,
  entry,
  holdsOf,
  mentionsCode,
  orderKey,
  payAccountDiff,
  paySuspenseDiff,
  platformAccount,
  receivableDiff,
  userAccount,
  voucher,
  voucherDiff,
  withHarness,
  type SwitchCall,
} from './kit.ts';

function expectSwitchInput(call: SwitchCall, appId: string, codes: readonly string[]): void {
  expect(call.input.appId).toBe(appId);
  expect(call.input.key).toBe(SWITCH_KEY);
  expect(call.input.source).toMatch(SWITCH_SOURCE);
  expect(call.input.source.length).toBeLessThanOrEqual(SWITCH_SOURCE_MAX);
  expect(call.input.reason.trim().length).toBeGreaterThan(0);
  expect([...call.input.reason].length).toBeLessThanOrEqual(SWITCH_REASON_MAX);
  expect(call.input.reason).not.toMatch(/\p{Cc}/u);
  expect(call.input.reason).toContain(DAY);
  for (const code of codes) {
    const named = mentionsCode(call.input.reason, code);
    expect(named, `reason names ${code}: ${call.input.reason}`).toBe(true);
  }
}

it(
  '[AC-B2-02p#20] 非 pay- 全局差异：该 app 调一次 turnOff（settle.auto.enabled，原因含 D 与不变量），提交后才 alertCommitted，入参与结果原样',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const receivable = await platformAccount(h);
      const difference = await duplicateCredits(h, orderKey(), account, 'self', receivable);
      const execution = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [difference],
      });
      expect(h.settle.turnOffs).toHaveLength(1);
      const [turnOff] = h.settle.turnOffs;
      expectSwitchInput(turnOff!, APP, ['03']);
      expect(h.settle.alerts).toHaveLength(1);
      expect(h.settle.alerts[0]!.input).toEqual(turnOff!.input);
      expect(h.settle.alerts[0]!.result).toEqual(turnOff!.result);
      expect(h.settle.events).toEqual([`turnOff:${APP}`, `alert:${APP}`]);
      expect(await Promise.all(h.settle.alertChecks)).toEqual([true]);
      expect(execution.autoSettlementOff).toEqual([APP]);
      expect(await diffsOf(h)).toHaveLength(1);
      expect(await holdsOf(h)).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#21] 同一 app 多条全局差异（②③⑤）：只关一次，原因列出这些不变量',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const receivable = await platformAccount(h);
      const cash = await platformAccount(h, 'CASH');
      const v = await voucher(h);
      await entry(h, v.id, account.accountId, -100n, true);
      await entry(h, v.id, cash, 107n, false);
      const short = { expected: 1000n, actual: 900n };
      const differences = [
        voucherDiff(v, 7n, 2),
        await duplicateCredits(h, orderKey(), account, 'self', receivable),
        receivableDiff(orderKey(), randomUUID(), account.userId, short),
      ];
      const execution = await h.executor.execute(h.db, { accountingDate: DAY, differences });
      expect(h.settle.turnOffs).toHaveLength(1);
      expectSwitchInput(h.settle.turnOffs[0]!, APP, ['02', '03', '05']);
      expect(h.settle.alerts).toHaveLength(1);
      expect(await Promise.all(h.settle.alertChecks)).toEqual([true]);
      expect(execution.autoSettlementOff).toEqual([APP]);
      expect(await diffsOf(h)).toHaveLength(3);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#22] 只有账户级差异：照常登记与冻结，不关开关、不告警',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const execution = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [balanceCacheDiff(account, { expected: 300n, cache: 500n })],
      });
      expect(await diffsOf(h)).toHaveLength(1);
      expect(await holdsOf(h)).toHaveLength(1);
      expect(h.settle.turnOffs).toEqual([]);
      expect(h.settle.alerts).toEqual([]);
      expect(execution.autoSettlementOff).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#23] 只有 pay- 全局差异：只登记差错单，不关开关、不冻结',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const execution = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [paySuspenseDiff(), paySuspenseDiff(OTHER)],
      });
      expect(await diffsOf(h, APP)).toHaveLength(1);
      expect(await diffsOf(h, OTHER)).toHaveLength(1);
      expect(h.settle.turnOffs).toEqual([]);
      expect(h.settle.alerts).toEqual([]);
      expect(h.holds.calls).toEqual([]);
      expect(execution.autoSettlementOff).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#24] pay- 全局差异与非 pay- 账户级差异同时出现：冻结账户 owner，不关开关',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [balanceCacheDiff(account, { expected: 1n, cache: 2n }), paySuspenseDiff()],
      });
      expect(await diffsOf(h)).toHaveLength(2);
      const holds = await holdsOf(h);
      expect(holds.map((hold) => hold.user_id)).toEqual([account.userId]);
      expect(h.settle.turnOffs).toEqual([]);
      expect(h.settle.alerts).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#25] 按 app 关开关：有全局差异的 app 各关一次，只有账户级或 pay- 差异的 app 不关',
  async () => {
    const THIRD = 'dce-app-c';
    await withHarness(createTestDatabase, async (h) => {
      const mine = await userAccount(h, APP);
      const receivable = await platformAccount(h, 'UNION_RECEIVABLE:taobao', APP);
      const theirs = await userAccount(h, OTHER);
      const cash = await platformAccount(h, 'CASH', OTHER);
      const v = await voucher(h, { appId: OTHER });
      await entry(h, v.id, theirs.accountId, -100n, true, OTHER);
      await entry(h, v.id, cash, 107n, false, OTHER);
      const third = await userAccount(h, THIRD);
      const execution = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [
          await duplicateCredits(h, orderKey(), mine, 'self', receivable),
          voucherDiff(v, 7n, 2, OTHER),
          balanceCacheDiff(third, { expected: 1n, cache: 2n }),
          payAccountDiff(third),
          paySuspenseDiff(THIRD),
        ],
      });
      const switched = h.settle.turnOffs.map((call) => call.input.appId).sort();
      expect(switched).toEqual([APP, OTHER].sort());
      const byApp = new Map(h.settle.turnOffs.map((call) => [call.input.appId, call]));
      expectSwitchInput(byApp.get(APP)!, APP, ['03']);
      expectSwitchInput(byApp.get(OTHER)!, OTHER, ['02']);
      expect(h.settle.alerts.map((call) => call.input.appId).sort()).toEqual([APP, OTHER].sort());
      expect(await Promise.all(h.settle.alertChecks)).toEqual([true, true]);
      expect([...execution.autoSettlementOff].sort()).toEqual([APP, OTHER].sort());
      expect(await holdsOf(h, THIRD)).toHaveLength(1);
      expect(await holdsOf(h, OTHER)).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#26] 全局差异即使解析不到任何用户也关开关',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const cash = await platformAccount(h, 'CASH');
      const receivable = await platformAccount(h);
      const v = await voucher(h);
      await entry(h, v.id, cash, 10n, false);
      await entry(h, v.id, receivable, -3n, false);
      const execution = await h.executor.execute(h.db, {
        accountingDate: DAY,
        differences: [voucherDiff(v, 7n, 2)],
      });
      expect(h.holds.calls).toEqual([]);
      expect(h.settle.turnOffs).toHaveLength(1);
      expectSwitchInput(h.settle.turnOffs[0]!, APP, ['02']);
      expect(h.settle.alerts).toHaveLength(1);
      expect(await Promise.all(h.settle.alertChecks)).toEqual([true]);
      expect(execution.autoSettlementOff).toEqual([APP]);
    });
  },
  TIMEOUT,
);
