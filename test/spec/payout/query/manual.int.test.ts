// B2-06e ⑥ (规划/08 BR-WDR-14, BR-WDR-15): at T + manual_after (24 hours; exactly 24 hours is
// due) a withdrawal still unknown gets needs_manual = true by CAS (row_version + 1, status PAYING,
// amounts untouched), an alert logger.warn({ withdrawal_id, out_biz_no, point },
// 'payout_needs_manual'), no channel call and no further job: automatic queries stop, the
// withdrawal can only end through W10 (B2-09). One millisecond earlier the point is queried as
// usual. A result that arrives after needs_manual was set is only recorded in payout_attempts.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DAY,
  NEEDS_MANUAL_ALERT,
  TIMEOUT,
  at,
  attempts,
  balanceOf,
  changes,
  close,
  entries,
  expectNoPayeeInLogs,
  jobsOf,
  open,
  queryScripted,
  querySuccess,
  querySummary,
  setup,
  withdrawal,
  withdrawalVouchers,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each([
  ['恰 T+24 小时（第 15 个时点）', DAY, 15],
  ['T+24 小时又过 1 毫秒', DAY + 1, 15],
  ['T+25 小时、任务晚到（第 14 个时点的任务）', DAY + 3_600_000, 14],
] as const)(
  '[AC-B2-06e#6] %s 仍未知：置 needs_manual=true（row_version+1，状态与金额不变）、告警，不调用查询、不投任务',
  async (_label, elapsed, point) => {
    const f = await setup(h);
    const owner = await f.newUser(2_000n);
    const w = await f.seedPaying(at(-elapsed), { userId: owner, net: 700n });
    const ch = queryScripted({ [w.outBizNo]: [querySuccess(`CH${w.outBizNo}`)] });
    const handler = f.queryJob(ch.channel);
    const before = await withdrawal(f, w.id);
    const tried = await attempts(f, w.id);
    await expect(handler(f.queryJobOf(w, point))).resolves.toBeUndefined();

    expect(ch.queries()).toEqual([]);
    expect(ch.transfers()).toBe(0);
    expect(f.sleep).not.toHaveBeenCalled();
    expect(await withdrawal(f, w.id)).toEqual({
      ...before,
      needs_manual: true,
      row_version: before.row_version + 1,
      updated_at: expect.any(Date),
    });
    expect(before).toMatchObject({ status: 'PAYING', needs_manual: false });
    expect(f.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ withdrawal_id: w.id, out_biz_no: w.outBizNo, point }),
      NEEDS_MANUAL_ALERT,
    );
    expect(await attempts(f, w.id)).toEqual(tried);
    expect(await jobsOf(f, w.id)).toEqual([]);
    expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_300n, frozen_fen: 700n });
    expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
      `wd:${w.id}:FREEZE`,
    ]);
    expectNoPayeeInLogs(f);
  },
);

it('[AC-B2-06e#6] T+24 小时差 1 毫秒：照常查询（三次未知），不置 needs_manual、不告警，投下一时点（point 15）', async () => {
  const f = await setup(h);
  const w = await f.seedPaying(at(-(DAY - 1)));
  const ch = queryScripted({});
  const handler = f.queryJob(ch.channel);
  await expect(handler(f.queryJobOf(w, 14))).resolves.toBeUndefined();
  expect(ch.queries()).toHaveLength(3);
  expect(await querySummary(f, w.id)).toEqual([
    ['unknown', 14, 1],
    ['unknown', 14, 2],
    ['unknown', 14, 3],
  ]);
  expect(await withdrawal(f, w.id)).toMatchObject({ status: 'PAYING', needs_manual: false });
  expect(f.logger.warn).not.toHaveBeenCalledWith(expect.anything(), NEEDS_MANUAL_ALERT);
  expect(await jobsOf(f, w.id)).toEqual([
    expect.objectContaining({
      queue: 'payout',
      singleton_key: `${w.id}:${w.executeSeq}:query:15`,
      state: 'created',
      data: {
        name: 'query',
        payload: { withdrawal_id: w.id, execute_seq: w.executeSeq, app_id: w.appId, point: 15 },
      },
    }),
  ]);
});

it('[AC-B2-06e#6] 第 15 个时点（T+24 小时）的任务执行时把单置为需人工后，再投同一时点任务：已 needs_manual，直接结束、不再告警', async () => {
  const f = await setup(h);
  const w = await f.seedPaying(at(-DAY));
  const ch = queryScripted({});
  const handler = f.queryJob(ch.channel);
  await handler(f.queryJobOf(w, 15));
  const after = await withdrawal(f, w.id);
  expect(after.needs_manual).toBe(true);
  await expect(handler(f.queryJobOf(w, 15, { attempt: 2 }))).resolves.toBeUndefined();
  expect(ch.queries()).toEqual([]);
  expect(await withdrawal(f, w.id)).toEqual(after);
  expect(f.logger.warn.mock.calls.filter((call) => call[1] === NEEDS_MANUAL_ALERT)).toHaveLength(1);
});

it('[AC-B2-06e#6] 查询途中单据已被置 needs_manual（另一处判定 24 小时到）：迟到的成功结果只记进 payout_attempts，不迁移状态、不记账、无事件', async () => {
  const f = await setup(h);
  const owner = await f.newUser(2_000n);
  const w = await f.seedPaying(at(-(DAY - 30_000)), { userId: owner, net: 500n });
  const ch = queryScripted(
    { [w.outBizNo]: [querySuccess(`CH${w.outBizNo}`)] },
    {
      before: async () => {
        await sql`UPDATE app.withdrawals SET needs_manual = true, row_version = row_version + 1
          WHERE id = ${w.id}`.execute(f.h.payout);
      },
    },
  );
  const handler = f.queryJob(ch.channel);
  await expect(handler(f.queryJobOf(w, 14))).resolves.toBeUndefined();
  expect(ch.queries()).toEqual([w.outBizNo]);
  expect(await querySummary(f, w.id)).toEqual([['success', 14, 1]]);
  expect(await withdrawal(f, w.id)).toMatchObject({
    status: 'PAYING',
    needs_manual: true,
    paid_at: null,
    channel_order_id: null,
  });
  expect(await entries(f, `wd:${w.id}:PAID`)).toEqual([]);
  expect(await balanceOf(f, owner)).toEqual({ available_fen: 1_500n, frozen_fen: 500n });
  const changed = (await changes(f)).filter((payload) => JSON.stringify(payload).includes(w.id));
  expect(changed).toEqual([]);
});
