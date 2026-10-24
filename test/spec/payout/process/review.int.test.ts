// B2-06d ③ (规划/08 BR-WDR-13 ③, BR-WDR-17, BR-WDR-05; state machine W9; 规划/12 §5.4 step ③):
// inside the daily lock the job re-checks, in this order, payout_disabled → queue_paused →
// channel_disabled → member_blocked → single_cap → daily_cap; the first failing check is W9:
// PAYING → APPROVED, hold_reason and hold_at written, executor_id / executed_at cleared,
// batch_id and execute_seq kept, row_version + 1, wallet.withdrawal_changed; no attempt, no
// channel call, no voucher, frozen untouched. member_blocked also enqueues one negative balance
// recheck {app_id, user_id} on queue evt.payout-went-negative (B2-05e's consumer, 规划/12 §5.7).
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DAILY_CAP,
  HOUR,
  NEGATIVE_QUEUE,
  NOW,
  SINGLE_CAP,
  TIMEOUT,
  attempts,
  balanceOf,
  changes,
  close,
  jobs,
  negativeJobs,
  open,
  queryJobs,
  scripted,
  setup,
  successStep,
  withdrawal,
  withdrawalVouchers,
  type Harness,
  type ProcessFixture,
  type ScriptedChannel,
  type SeedWithdrawal,
  type Seeded,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

type Row = Awaited<ReturnType<typeof withdrawal>>;

/** W9 exactly: only the hold, execution and version columns move; nothing else is written. */
async function expectHeld(
  f: ProcessFixture,
  w: Seeded,
  reason: string,
  before: { row: Row; balance: { available_fen: bigint; frozen_fen: bigint } },
  ch: ScriptedChannel,
) {
  expect(ch.transfers()).toEqual([]);
  expect(await withdrawal(f, w.id)).toEqual({
    ...before.row,
    status: 'APPROVED',
    hold_reason: reason,
    hold_at: NOW,
    executor_id: null,
    executed_at: null,
    row_version: before.row.row_version + 1,
    updated_at: expect.any(Date),
  });
  expect(before.row).toMatchObject({ batch_id: w.batchId, execute_seq: w.executeSeq });
  expect(await attempts(f, w.id)).toEqual([]);
  expect(await changes(f)).toContainEqual(
    expect.objectContaining({ withdrawal_id: w.id, user_id: w.userId, status: 'APPROVED' }),
  );
  expect(await balanceOf(f, w.userId)).toEqual(before.balance);
  expect((await withdrawalVouchers(f)).filter((key) => key.startsWith(`wd:${w.id}:`))).toEqual([
    `wd:${w.id}:FREEZE`,
  ]);
  expect(queryJobs(await jobs(f))).toEqual([]);
}

async function observe(f: ProcessFixture, w: Seeded) {
  return { row: await withdrawal(f, w.id), balance: await balanceOf(f, w.userId) };
}

interface HoldCase {
  label: string;
  reason: string;
  arrange(f: ProcessFixture): Promise<void>;
}

const HOLDS: HoldCase[] = [
  {
    label: 'payout.enabled=off',
    reason: 'payout_disabled',
    arrange: (f) => f.set('payout.enabled', false),
  },
  {
    label: 'payout.queue_paused=on',
    reason: 'queue_paused',
    arrange: (f) => f.set('payout.queue_paused', true),
  },
  {
    label: '本单通道 payout.channel_enabled.alipay=off',
    reason: 'channel_disabled',
    arrange: (f) => f.set('payout.channel_enabled.alipay', false),
  },
  {
    label: '本单通道 payout.channel_paused.alipay=on',
    reason: 'channel_disabled',
    arrange: (f) => f.set('payout.channel_paused.alipay', true),
  },
  {
    label: '会员风控 frozen（不设到期）',
    reason: 'member_blocked',
    arrange: async (f) => {
      f.risk.set(f.userId, { state: 'frozen', frozen_until: null });
    },
  },
  {
    label: 'net_fen 1000 > payout.single_cap_fen 999',
    reason: 'single_cap',
    arrange: (f) => f.set('payout.single_cap_fen', 999),
  },
  {
    label: '当日已发出 1 + 本单 1000 > payout.daily_cap_fen 1000',
    reason: 'daily_cap',
    arrange: async (f) => {
      await f.set('payout.daily_cap_fen', 1000);
      await f.seedSent({ net: 1n, result: 'pending', at: NOW });
    },
  },
];

it.each(HOLDS)(
  '[AC-B2-06d#3] $label → W9 hold_reason=$reason：回到 APPROVED，清执行人与执行时间、保留批次，不写尝试、不转账、不动冻结',
  async ({ reason, arrange }) => {
    const f = await setup(h);
    await arrange(f);
    const w = await f.seedWithdrawal({ net: 1000n });
    const ch = scripted({ [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] });
    const handler = f.job(ch.channel);
    const before = await observe(f, w);
    await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
    await expectHeld(f, w, reason, before, ch);
    expect(negativeJobs(await jobs(f))).toHaveLength(reason === 'member_blocked' ? 1 : 0);
    expect(f.pause).not.toHaveBeenCalled();
  },
);

it('[AC-B2-06d#3] 另一通道的开关不影响本单：bank_card 关闭时 alipay 单照常转账', async () => {
  const f = await setup(h);
  await f.set('payout.channel_enabled.bank_card', false);
  await f.set('payout.channel_paused.bank_card', true);
  const w = await f.seedWithdrawal({ net: 1000n, channel: 'alipay' });
  const ch = scripted({ [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] });
  const handler = f.job(ch.channel);
  await handler(f.jobOf(w));
  expect(ch.transfers()).toHaveLength(1);
  expect(await withdrawal(f, w.id)).toMatchObject({ status: 'PAID_API', hold_reason: null });
});

it('[AC-B2-06d#3] 复核顺序固定：六项同时不满足取最前一项，逐项解除依次得到后一项，全部解除才转账', async () => {
  const f = await setup(h);
  const ch = scripted({});
  const handler = f.job(ch.channel);
  await f.set('payout.enabled', false);
  await f.set('payout.queue_paused', true);
  await f.set('payout.channel_enabled.alipay', false);
  f.risk.set(f.userId, { state: 'banned', frozen_until: null });
  await f.set('payout.single_cap_fen', 999);
  await f.set('payout.daily_cap_fen', 999);
  const lift: (() => Promise<void>)[] = [
    () => f.set('payout.enabled', true),
    () => f.set('payout.queue_paused', false),
    () => f.set('payout.channel_enabled.alipay', true),
    async () => {
      f.risk.delete(f.userId);
    },
    () => f.set('payout.single_cap_fen', SINGLE_CAP),
    () => f.set('payout.daily_cap_fen', DAILY_CAP),
  ];
  const seen: (string | null)[] = [];
  for (let step = 0; step <= lift.length; step += 1) {
    const w = await f.seedWithdrawal({ net: 1000n });
    await handler(f.jobOf(w));
    seen.push((await withdrawal(f, w.id)).hold_reason);
    if (step < lift.length) await lift[step]!();
  }
  expect(seen).toEqual([
    'payout_disabled',
    'queue_paused',
    'channel_disabled',
    'member_blocked',
    'single_cap',
    'daily_cap',
    null,
  ]);
  expect(ch.transfers()).toHaveLength(1);
});

interface MemberCase {
  label: string;
  seed?: Partial<SeedWithdrawal>;
  arrange(f: ProcessFixture, w: Seeded): Promise<void>;
}

const BLOCKED: MemberCase[] = [
  {
    label: '风控 banned',
    arrange: async (f, w) => {
      f.risk.set(w.userId, { state: 'banned', frozen_until: null });
    },
  },
  {
    label: '风控 frozen、到期时刻在当前之后',
    arrange: async (f, w) => {
      f.risk.set(w.userId, { state: 'frozen', frozen_until: new Date(NOW.getTime() + HOUR) });
    },
  },
  {
    label: '申诉中、申诉前为 frozen',
    arrange: async (f, w) => {
      f.risk.set(w.userId, { state: 'appealing', frozen_until: null });
      f.appeals.set(w.userId, 'frozen');
    },
  },
  {
    label: '申诉中、申诉前为 banned',
    arrange: async (f, w) => {
      f.risk.set(w.userId, { state: 'appealing', frozen_until: null });
      f.appeals.set(w.userId, 'banned');
    },
  },
  {
    label: '生效中的提现冻结（不设期限）',
    arrange: (f, w) => f.seedWithdrawHold(w.userId, {}),
  },
  {
    label: '生效中的提现冻结（期限在当前之后）',
    arrange: (f, w) => f.seedWithdrawHold(w.userId, { holdUntil: new Date(NOW.getTime() + HOUR) }),
  },
  {
    label: '可用余额 < 0（冻结后可用为 0，再被扣 1 分）',
    arrange: (f, w) => f.makeNegative(w.userId),
  },
  {
    label: '单据 blocked_reason=NEGATIVE_BALANCE',
    seed: { blockedReason: 'NEGATIVE_BALANCE' },
    arrange: async () => undefined,
  },
];

it.each(BLOCKED)(
  '[AC-B2-06d#3] member_blocked（$label）：W9 hold_reason=member_blocked，同事务入队一次负余额处理任务 {app_id, user_id}',
  async ({ seed, arrange }) => {
    const f = await setup(h);
    const owner = await f.newUser(1000n);
    const w = await f.seedWithdrawal({ ...seed, userId: owner, net: 1000n });
    await arrange(f, w);
    const ch = scripted({ [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] });
    const handler = f.job(ch.channel);
    const before = await observe(f, w);
    await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
    await expectHeld(f, w, 'member_blocked', before, ch);
    expect(negativeJobs(await jobs(f))).toEqual([
      {
        queue: NEGATIVE_QUEUE,
        singleton_key: null,
        state: 'created',
        data: { name: expect.any(String), payload: { app_id: f.appId, user_id: owner } },
        delay_s: 0,
      },
    ]);
  },
);

const NOT_BLOCKED: MemberCase[] = [
  {
    label: '风控 frozen 的到期时刻恰为当前时刻（已到期）',
    arrange: async (f, w) => {
      f.risk.set(w.userId, { state: 'frozen', frozen_until: NOW });
    },
  },
  {
    label: '申诉中、没有申诉前的冻结或封禁',
    arrange: async (f, w) => {
      f.risk.set(w.userId, { state: 'appealing', frozen_until: null });
    },
  },
  {
    label: '提现冻结已解除',
    arrange: (f, w) => f.seedWithdrawHold(w.userId, { released: true }),
  },
  {
    label: '提现冻结的期限恰为当前时刻（已到期）',
    arrange: (f, w) => f.seedWithdrawHold(w.userId, { holdUntil: NOW }),
  },
  {
    label: '可用余额恰为 0',
    arrange: async () => undefined,
  },
];

it.each(NOT_BLOCKED)(
  '[AC-B2-06d#3] 不算 member_blocked（$label）：复核通过、照常转账，不入队负余额处理',
  async ({ seed, arrange }) => {
    const f = await setup(h);
    const owner = await f.newUser(1000n);
    const w = await f.seedWithdrawal({ ...seed, userId: owner, net: 1000n });
    await arrange(f, w);
    const ch = scripted({ [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] });
    const handler = f.job(ch.channel);
    await expect(handler(f.jobOf(w))).resolves.toBeUndefined();
    expect(ch.transfers()).toHaveLength(1);
    expect(await withdrawal(f, w.id)).toMatchObject({ status: 'PAID_API', hold_reason: null });
    expect(negativeJobs(await jobs(f))).toEqual([]);
  },
);

it.each([
  [500_000n, null],
  [500_001n, 'single_cap'],
] as const)(
  '[AC-B2-06d#3] single_cap 精确边界：payout.single_cap_fen=500000、net_fen=%s → hold_reason %s',
  async (net, reason) => {
    const f = await setup(h);
    await f.set('payout.single_cap_fen', 500_000);
    const w = await f.seedWithdrawal({ net });
    const ch = scripted({ [w.outBizNo]: [successStep(`CH${w.outBizNo}`)] });
    const handler = f.job(ch.channel);
    await handler(f.jobOf(w));
    expect((await withdrawal(f, w.id)).hold_reason).toBe(reason);
    expect(ch.transfers()).toHaveLength(reason === null ? 1 : 0);
  },
);
