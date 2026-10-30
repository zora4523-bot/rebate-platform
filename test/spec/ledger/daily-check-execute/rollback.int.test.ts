// B2-02p: a failing step rolls the whole difference back — never a diff without its holds or a
// hold without its diff — and the run fails; a later run of the same day completes it. The switch
// alert never follows a failed switch-off.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  DAY,
  TIMEOUT,
  balanceCacheDiff,
  diffByRef,
  diffsOf,
  duplicateCredits,
  executedOf,
  expectHold,
  holdsOf,
  orderKey,
  platformAccount,
  userAccount,
  withHarness,
} from './kit.ts';

it(
  '[AC-B2-02p#27] 冻结端口失败：本次运行失败，差错单与冻结都不留下；重跑同日补齐差错单与冻结',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const differences = [balanceCacheDiff(account, { expected: 300n, cache: 500n })];
      h.holds.failAt = 0;
      await expect(
        h.executor.execute(h.db, { accountingDate: DAY, differences }),
      ).rejects.toThrow();
      expect(h.holds.calls).toHaveLength(1);
      expect(await diffsOf(h)).toEqual([]);
      expect(await holdsOf(h)).toEqual([]);

      h.holds.failAt = null;
      const execution = await h.executor.execute(h.db, { accountingDate: DAY, differences });
      const diff = await diffByRef(h, `01:${account.accountId}`);
      expect(executedOf(execution, diff)).toMatchObject({
        inserted: true,
        heldUserIds: [account.userId],
      });
      const holds = await holdsOf(h);
      expect(holds).toHaveLength(1);
      expectHold(holds[0], diff, account.userId, h);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#28] 同一差错单的第二位用户冻结失败：第一位的冻结与差错单一起回滚；重跑后两人各 1 条',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const first = await userAccount(h);
      const second = await userAccount(h);
      const receivable = await platformAccount(h);
      const key = orderKey();
      const differences = [
        await duplicateCredits(h, key, first, 'self', receivable),
        await duplicateCredits(h, key, second, 'parent', receivable),
      ];
      h.holds.failAt = 1;
      await expect(
        h.executor.execute(h.db, { accountingDate: DAY, differences }),
      ).rejects.toThrow();
      expect(h.holds.calls).toHaveLength(2);
      expect(await diffsOf(h)).toEqual([]);
      expect(await holdsOf(h)).toEqual([]);

      h.holds.failAt = null;
      await h.executor.execute(h.db, { accountingDate: DAY, differences });
      const diff = await diffByRef(h, `03:${key}`);
      const holds = await holdsOf(h);
      expect(holds.map((hold) => hold.user_id).sort()).toEqual(
        [first.userId, second.userId].sort(),
      );
      for (const hold of holds) expectHold(hold, diff, hold.user_id, h);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02p#29] 关开关失败：本次运行失败且不告警；重跑同日照样关开关并在提交后告警，差错单与每人冻结仍各只 1 份',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const account = await userAccount(h);
      const receivable = await platformAccount(h);
      const key = orderKey();
      const differences = [await duplicateCredits(h, key, account, 'self', receivable)];
      h.settle.fail = true;
      await expect(
        h.executor.execute(h.db, { accountingDate: DAY, differences }),
      ).rejects.toThrow();
      expect(h.settle.events.filter((event) => event.startsWith('turnOff:'))).toHaveLength(1);
      expect(h.settle.alerts).toEqual([]);

      h.settle.fail = false;
      const execution = await h.executor.execute(h.db, { accountingDate: DAY, differences });
      expect(h.settle.turnOffs).toHaveLength(1);
      expect(h.settle.alerts).toHaveLength(1);
      expect(await Promise.all(h.settle.alertChecks)).toEqual([true]);
      expect(execution.autoSettlementOff).toEqual([h.settle.turnOffs[0]!.input.appId]);
      const diff = await diffByRef(h, `03:${key}`);
      const holds = await holdsOf(h);
      expect(holds).toHaveLength(1);
      expectHold(holds[0], diff, account.userId, h);
    });
  },
  TIMEOUT,
);
