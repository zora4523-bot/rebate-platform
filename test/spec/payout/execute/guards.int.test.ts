// B2-06c ① batch-level switches and ② per-withdrawal checks of EXECUTE (规划/08 BR-WDR-12, BR-WDR-05,
// BR-WDR-32; state machine W4). Expected values are written out from the rules, never read back
// from the implementation.
import { createTestDatabase } from '@couli/db/testing';
import type { WithdrawalState } from '@couli/domain';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  HOUR,
  NOW,
  TIMEOUT,
  batches,
  close,
  events,
  executed,
  expectJob,
  expectPaying,
  expectUntouched,
  fenced,
  items,
  jobs,
  open,
  setup,
  snapshot,
  sorted,
  withdrawal,
  type ExecuteFixture,
  type Harness,
} from './kit.ts';
import type { PayoutExecute } from '../../../../apps/api/src/modules/payout/application/payout-execute.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each([
  ['payout.enabled', false, 'payout_disabled'],
  ['payout.queue_paused', true, 'queue_paused'],
] as const)(
  '[AC-B2-06c#1] ① %s=%s 整批拒绝 %s：不迁移、不写明细、不入队、不发事件',
  async (key, value, reason) => {
    const f = await setup(h);
    const service = f.execute();
    const a = await f.seedWithdrawal({ net: 100n });
    const b = await f.seedWithdrawal({ net: 200n });
    await f.set(key, value);
    const before = await snapshot(f);
    expect(await f.run(service, [a, b])).toEqual({ kind: 'rejected', reason });
    expect(await snapshot(f)).toEqual(before);
    expect(f.send).not.toHaveBeenCalled();
    await expectUntouched(f, a, 'APPROVED');
    await expectUntouched(f, b, 'APPROVED');
  },
);

it('[AC-B2-06c#1] ① 两个开关都不满足时报 payout_disabled，且先于逐单判断与水位检查', async () => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  const a = await f.seedWithdrawal({ status: 'PENDING_REVIEW' });
  const b = await f.seedWithdrawal();
  await f.set('payout.enabled', false);
  await f.set('payout.queue_paused', true);
  const before = await snapshot(f);
  expect(await f.run(service, [a, b])).toEqual({ kind: 'rejected', reason: 'payout_disabled' });
  expect(await snapshot(f)).toEqual(before);
  expect(f.send).not.toHaveBeenCalled();
});

it('[AC-B2-06c#2] 通过的单逐单进入 PAYING：execute_seq+1、executor/batch/executed_at、明细 paying、每单一个任务与事件', async () => {
  const f = await setup(h);
  const service = f.execute();
  const a = await f.seedWithdrawal({ net: 100n });
  const b = await f.seedWithdrawal({ net: 250n, userId: await f.newUser() });
  // Another app's switch being off changes nothing here.
  await f.set('payout.enabled', false, `other_${f.appId}`);
  const before = [await withdrawal(f, a), await withdrawal(f, b)];
  const result = executed(await f.run(service, [a, b]));
  expect(sorted(result.paying)).toEqual(sorted([a, b]));
  expect(result.left).toEqual([]);
  for (const old of before) {
    await expectPaying(f, old.id, { batchId: result.batchId, seq: 1, executor: f.adminId });
    expect((await withdrawal(f, old.id)).row_version).toBe(old.row_version + 1);
  }
  expect(await batches(f)).toEqual([
    { id: result.batchId, kind: 'manual', created_by: expect.any(String) },
  ]);
  expect(await items(f)).toEqual(
    sorted([a, b]).map((id) => ({
      batch_id: result.batchId,
      withdrawal_id: id,
      result: 'paying',
      reason: null,
      moved_to_batch_id: null,
    })),
  );
  const queued = await jobs(f);
  expect(queued).toHaveLength(2);
  expectJob(f, queued, a, 1);
  expectJob(f, queued, b, 1);
  const changed = await events(f);
  expect(changed.map((e) => e.payload)).toEqual(
    expect.arrayContaining(
      before.map((row) => ({
        v: 1,
        data: { withdrawal_id: row.id, user_id: row.user_id, status: 'PAYING' },
      })),
    ),
  );
  expect(changed).toHaveLength(2);
});

/** One passing member plus `bad`, which ② keeps where it is; the batch still executes. */
async function expectLeft(
  f: ExecuteFixture,
  service: PayoutExecute,
  bad: string,
  reason: string,
  result: 'skipped' | 'blocked',
  status: WithdrawalState = 'APPROVED',
  channel: 'alipay' | 'bank_card' = 'alipay',
) {
  const good = await f.seedWithdrawal({ net: 300n, channel });
  const answer = executed(await f.run(service, [good, bad]));
  expect(answer.paying).toEqual([good]);
  expect(answer.left).toEqual([{ id: bad, reason }]);
  await expectPaying(f, good, { batchId: answer.batchId, seq: 1, executor: f.adminId });
  await expectUntouched(f, bad, status);
  expect((await items(f)).filter((item) => item.batch_id === answer.batchId)).toEqual(
    sorted([good, bad]).map((id) =>
      id === good
        ? {
            batch_id: answer.batchId,
            withdrawal_id: good,
            result: 'paying',
            reason: null,
            moved_to_batch_id: null,
          }
        : { batch_id: answer.batchId, withdrawal_id: bad, result, reason, moved_to_batch_id: null },
    ),
  );
  const queued = await jobs(f);
  expect(queued).toHaveLength(1);
  expectJob(f, queued, good, 1);
  expect(f.send).toHaveBeenCalledTimes(1);
}

it.each(['PENDING_REVIEW', 'PAYING', 'REJECTED', 'PAID_API', 'PAID_MANUAL', 'FAILED'] as const)(
  '[AC-B2-06c#2] ② 状态 %s 不是 APPROVED：skipped / not_approved，保持原状态',
  async (status) => {
    const f = await setup(h);
    const service = f.execute();
    const bad = await f.seedWithdrawal({ status, userId: await f.newUser() });
    await expectLeft(f, service, bad, 'not_approved', 'skipped', status);
  },
);

type MemberState = (f: ExecuteFixture, owner: string) => Promise<void>;
const BLOCKS: [string, MemberState][] = [
  [
    'risk_state=frozen（无期限）',
    async (f, owner) => {
      f.risk.set(owner, { state: 'frozen', frozen_until: null });
    },
  ],
  [
    'risk_state=frozen（未到期）',
    async (f, owner) => {
      f.risk.set(owner, { state: 'frozen', frozen_until: new Date(NOW.getTime() + 1) });
    },
  ],
  [
    'risk_state=banned',
    async (f, owner) => {
      f.risk.set(owner, { state: 'banned', frozen_until: null });
    },
  ],
  [
    'appealing（申诉前 frozen）',
    async (f, owner) => {
      f.risk.set(owner, { state: 'appealing', frozen_until: null });
      f.appeals.set(owner, 'frozen');
    },
  ],
  [
    'appealing（申诉前 banned）',
    async (f, owner) => {
      f.risk.set(owner, { state: 'appealing', frozen_until: null });
      f.appeals.set(owner, 'banned');
    },
  ],
  ['生效的 withdraw_holds（无期限）', (f, owner) => f.seedWithdrawHold(owner, {})],
  [
    '生效的 withdraw_holds（hold_until 晚于 now）',
    (f, owner) => f.seedWithdrawHold(owner, { holdUntil: new Date(NOW.getTime() + 1) }),
  ],
  ['available_fen < 0', (f, owner) => f.makeNegative(owner)],
];

it.each(BLOCKS)(
  '[AC-B2-06c#2] ② 会员提现阻断 %s：blocked / member_blocked，保持 APPROVED',
  async (_name, block) => {
    const f = await setup(h);
    const service = f.execute();
    const owner = await f.newUser(0n);
    const bad = await f.seedWithdrawal({ userId: owner });
    await block(f, owner);
    await expectLeft(f, service, bad, 'member_blocked', 'blocked');
  },
);

it('[AC-B2-06c#2] ② blocked_reason 已置（W4 守卫）：blocked / member_blocked', async () => {
  const f = await setup(h);
  const service = f.execute();
  const bad = await f.seedWithdrawal({ userId: await f.newUser() });
  await f.h.db
    .withSchema('app')
    .updateTable('withdrawals')
    .set({ blocked_reason: 'NEGATIVE_BALANCE' })
    .where('id', '=', bad)
    .execute();
  await expectLeft(f, service, bad, 'member_blocked', 'blocked');
});

const NOT_BLOCKING: [string, MemberState][] = [
  [
    'frozen 已到期（frozen_until = now）',
    async (f, owner) => {
      f.risk.set(owner, { state: 'frozen', frozen_until: NOW });
    },
  ],
  ['已解除的 withdraw_holds', (f, owner) => f.seedWithdrawHold(owner, { released: true })],
  [
    '已到期的 withdraw_holds（hold_until = now）',
    (f, owner) => f.seedWithdrawHold(owner, { holdUntil: NOW }),
  ],
  ['available_fen = 0', async () => undefined],
];

it(
  '[AC-B2-06c#2] ② BR-WDR-05 (a) 负余额守卫与锁余额行同一事务：另一事务已锁余额并扣回 0 → −1 未提交时，EXECUTE 等它提交后读到 −1 → blocked / member_blocked',
  async () => {
    const f = await setup(h);
    const service = f.execute();
    const owner = await f.newUser(0n);
    const id = await f.seedWithdrawal({ userId: owner });
    // B (h.db) locks users → balances and posts −1, then stays open; A (h.observer) runs EXECUTE; B
    // commits only once A waits on a lock B holds (a guard read outside that lock never waits).
    const { second } = await fenced(
      h,
      { db: h.db, body: (trx) => f.postNegative(trx, owner) },
      { db: h.observer, body: f.body(service, [id]) },
    );
    const answer = executed(second);
    expect(answer.paying).toEqual([]);
    expect(answer.left).toEqual([{ id, reason: 'member_blocked' }]);
    await expectUntouched(f, id, 'APPROVED');
    expect((await items(f)).filter((item) => item.batch_id === answer.batchId)).toEqual([
      {
        batch_id: answer.batchId,
        withdrawal_id: id,
        result: 'blocked',
        reason: 'member_blocked',
        moved_to_batch_id: null,
      },
    ]);
    expect(await jobs(f)).toEqual([]);
    expect(f.send).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it('[AC-B2-06c#2] BR-WDR-11 不设人员互斥：reviewer_id 就是执行管理员的单照常进入 PAYING', async () => {
  const f = await setup(h);
  const service = f.execute();
  const id = await f.seedWithdrawal({ reviewerId: f.adminId });
  const answer = executed(await f.run(service, [id]));
  expect(answer).toMatchObject({ paying: [id], left: [] });
  await expectPaying(f, id, { batchId: answer.batchId, seq: 1, executor: f.adminId });
  expect((await withdrawal(f, id)).reviewer_id).toBe(f.adminId);
  const queued = await jobs(f);
  expect(queued).toHaveLength(1);
  expectJob(f, queued, id, 1);
});

it('[AC-B2-06c#2] BR-WDR-11 不设第二人批准：单笔 ≥ 50000 分、合计 ≥ 2000000 分的批次由一名管理员照常执行', async () => {
  const f = await setup(h);
  const service = f.execute();
  // 50000 + 3 × 500000 + 450000 = 2000000 (the former second-approval thresholds ¥500 / ¥20,000).
  const nets = [50000n, 500000n, 500000n, 500000n, 450000n];
  const ids: string[] = [];
  for (const net of nets) {
    ids.push(await f.seedWithdrawal({ net, reviewerId: f.adminId, userId: await f.newUser() }));
  }
  const answer = executed(await f.run(service, ids));
  expect(sorted(answer.paying)).toEqual(sorted(ids));
  expect(answer.left).toEqual([]);
  for (const id of ids) {
    await expectPaying(f, id, { batchId: answer.batchId, seq: 1, executor: f.adminId });
  }
  expect(await jobs(f)).toHaveLength(nets.length);
});

it.each(NOT_BLOCKING)('[AC-B2-06c#2] ② %s 不算阻断，照常进入 PAYING', async (_name, state) => {
  const f = await setup(h);
  const service = f.execute();
  const owner = await f.newUser(0n);
  const id = await f.seedWithdrawal({ userId: owner });
  await state(f, owner);
  const answer = executed(await f.run(service, [id]));
  expect(answer).toMatchObject({ paying: [id], left: [] });
  await expectPaying(f, id, { batchId: answer.batchId, seq: 1, executor: f.adminId });
});

it.each(['pending', 'fail', 'unknown', 'success'] as const)(
  '[AC-B2-06c#2] ② 已有 kind=transfer 尝试（result=%s）：blocked / has_transfer_attempt',
  async (result) => {
    const f = await setup(h);
    const service = f.execute();
    const bad = await f.seedWithdrawal({ userId: await f.newUser() });
    await f.seedAttempt(bad, 'transfer', result);
    await expectLeft(f, service, bad, 'has_transfer_attempt', 'blocked');
  },
);

it('[AC-B2-06c#2] ② 只有 kind=query 的记录不算转账尝试', async () => {
  const f = await setup(h);
  const service = f.execute();
  const id = await f.seedWithdrawal();
  await f.seedAttempt(id, 'query', 'success');
  const answer = executed(await f.run(service, [id]));
  expect(answer).toMatchObject({ paying: [id], left: [] });
});

it.each([
  ['payout.channel_enabled.bank_card', false, 'bank_card', 'alipay'],
  ['payout.channel_enabled.alipay', false, 'alipay', 'bank_card'],
  ['payout.channel_paused.alipay', true, 'alipay', 'bank_card'],
  ['payout.channel_paused.bank_card', true, 'bank_card', 'alipay'],
] as const)(
  '[AC-B2-06c#2] ② %s=%s：%s 通道的单 blocked / channel_disabled，另一通道照常',
  async (key, value, channel, other) => {
    const f = await setup(h);
    const service = f.execute();
    const bad = await f.seedWithdrawal({ channel, userId: await f.newUser() });
    await f.set(key, value);
    await expectLeft(f, service, bad, 'channel_disabled', 'blocked', 'APPROVED', other);
  },
);

it('[AC-B2-06c#2] ② 例：10 单中 1 单会员冻结、1 单银行卡通道未开通 → 8 单 PAYING，2 单留在 APPROVED 并列原因', async () => {
  const f = await setup(h);
  const service = f.execute();
  const frozen = await f.newUser();
  f.risk.set(frozen, { state: 'frozen', frozen_until: new Date(NOW.getTime() + 24 * HOUR) });
  await f.set('payout.channel_enabled.bank_card', false);
  const passing: string[] = [];
  for (let i = 0; i < 8; i += 1) passing.push(await f.seedWithdrawal({ net: BigInt(100 + i) }));
  const blocked = await f.seedWithdrawal({ userId: frozen });
  const bank = await f.seedWithdrawal({ channel: 'bank_card', userId: await f.newUser() });
  const answer = executed(
    await f.run(service, [...passing.slice(0, 4), blocked, ...passing.slice(4), bank]),
  );
  expect(sorted(answer.paying)).toEqual(sorted(passing));
  expect(answer.left).toEqual(
    expect.arrayContaining([
      { id: blocked, reason: 'member_blocked' },
      { id: bank, reason: 'channel_disabled' },
    ]),
  );
  expect(answer.left).toHaveLength(2);
  expect(await jobs(f)).toHaveLength(8);
  await expectUntouched(f, blocked, 'APPROVED');
  await expectUntouched(f, bank, 'APPROVED');
});
