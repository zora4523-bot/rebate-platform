// B2-06c ⑤ moving a withdrawal to a new manual batch and ⑧ the automatic batch (规划/08 BR-WDR-11,
// BR-WDR-12 细则 E-28, BR-WDR-30): a ticked APPROVED withdrawal already on another batch moves by a
// CAS on (status = APPROVED, batch_id = the old batch) in the same transaction, the old batch keeping
// an item 'moved_out'; two admins grouping it at once: only one gets it (a lock fence fixes the order,
// both orders run). A whole-batch refusal (① / ③) moves nothing: batch_id stays, no item, no batch.
// review_mode never changes: it records how the withdrawal was reviewed, the batch kind how it runs.
// The automatic batch is one withdrawal, kind=auto, executor 'system:auto_payout' (executor_id
// null), through the same command.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  SYSTEM,
  TIMEOUT,
  batches,
  close,
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
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-06c#5] 人工组批改挂：原自动批次记 moved_out（moved_to=新批次），单挂到新批次并进入 PAYING', async () => {
  const f = await setup(h);
  const service = f.execute();
  const auto = await f.seedBatch('auto');
  const moved = await f.seedWithdrawal({ net: 28000n, batchId: auto });
  const fresh = await f.seedWithdrawal({ net: 100n, userId: await f.newUser() });
  const answer = executed(await f.run(service, [moved, fresh]));
  expect(sorted(answer.paying)).toEqual(sorted([moved, fresh]));
  await expectPaying(f, moved, { batchId: answer.batchId, seq: 1, executor: f.adminId });
  const all = await items(f);
  expect(all).toEqual(
    expect.arrayContaining([
      {
        batch_id: auto,
        withdrawal_id: moved,
        result: 'moved_out',
        reason: null,
        moved_to_batch_id: answer.batchId,
      },
      {
        batch_id: answer.batchId,
        withdrawal_id: moved,
        result: 'paying',
        reason: null,
        moved_to_batch_id: null,
      },
      {
        batch_id: answer.batchId,
        withdrawal_id: fresh,
        result: 'paying',
        reason: null,
        moved_to_batch_id: null,
      },
    ]),
  );
  expect(all).toHaveLength(3);
  const queued = await jobs(f);
  expect(queued).toHaveLength(2);
  expectJob(f, queued, moved, 1);
});

it('[AC-B2-06c#5] 改挂后 ② 受阻的单：挂到新批次、原批次记 moved_out，新批次记 blocked 并保持 APPROVED', async () => {
  const f = await setup(h);
  const service = f.execute();
  await f.set('payout.channel_enabled.bank_card', false);
  const auto = await f.seedBatch('auto');
  const moved = await f.seedWithdrawal({ channel: 'bank_card', batchId: auto });
  const answer = executed(await f.run(service, [moved]));
  expect(answer).toMatchObject({ paying: [], left: [{ id: moved, reason: 'channel_disabled' }] });
  await expectUntouched(f, moved, 'APPROVED');
  expect((await withdrawal(f, moved)).batch_id).toBe(answer.batchId);
  expect(await items(f)).toEqual(
    expect.arrayContaining([
      {
        batch_id: auto,
        withdrawal_id: moved,
        result: 'moved_out',
        reason: null,
        moved_to_batch_id: answer.batchId,
      },
      {
        batch_id: answer.batchId,
        withdrawal_id: moved,
        result: 'blocked',
        reason: 'channel_disabled',
        moved_to_batch_id: null,
      },
    ]),
  );
  expect(await items(f)).toHaveLength(2);
  expect(await jobs(f)).toEqual([]);
});

it.each([
  ['甲先、乙后', 'first'],
  ['乙先、甲后', 'second'],
] as const)(
  '[AC-B2-06c#5] 两个管理员同时把同一张已挂别批的单组进各自批次（%s，锁栅栏定先后）：先者成功，后者等锁后记 not_approved，转账任务只有一条',
  async (_name, order) => {
    const f = await setup(h);
    const service = f.execute();
    const auto = await f.seedBatch('auto');
    const id = await f.seedWithdrawal({ net: 500n, batchId: auto });
    const other = randomUUID();
    const a = { db: h.db, body: f.body(service, [id]) };
    const b = { db: h.observer, body: f.body(service, [id], { executorId: other }) };
    const run = await fenced(h, order === 'first' ? a : b, order === 'first' ? b : a);
    const winner = executed(run.first);
    const loser = executed(run.second);
    expect(winner).toMatchObject({ paying: [id], left: [] });
    expect(loser).toMatchObject({ paying: [], left: [{ id, reason: 'not_approved' }] });
    expect(loser.batchId).not.toBe(winner.batchId);
    await expectPaying(f, id, {
      batchId: winner.batchId,
      seq: 1,
      executor: order === 'first' ? f.adminId : other,
    });
    const all = await items(f);
    expect(all.filter((item) => item.batch_id === loser.batchId)).toEqual([
      {
        batch_id: loser.batchId,
        withdrawal_id: id,
        result: 'skipped',
        reason: 'not_approved',
        moved_to_batch_id: null,
      },
    ]);
    expect(all.filter((item) => item.result === 'moved_out')).toEqual([
      {
        batch_id: auto,
        withdrawal_id: id,
        result: 'moved_out',
        reason: null,
        moved_to_batch_id: winner.batchId,
      },
    ]);
    expect(all.filter((item) => item.result === 'paying')).toEqual([
      {
        batch_id: winner.batchId,
        withdrawal_id: id,
        result: 'paying',
        reason: null,
        moved_to_batch_id: null,
      },
    ]);
    const queued = await jobs(f);
    expect(queued).toHaveLength(1);
    expectJob(f, queued, id, 1);
  },
  TIMEOUT,
);

it('[AC-B2-06c#5] review_mode 不变：review_mode=auto 的单改挂进人工批次执行后仍是 auto', async () => {
  const f = await setup(h);
  const service = f.execute();
  const auto = await f.seedBatch('auto');
  const id = await f.seedWithdrawal({ reviewMode: 'auto', batchId: auto });
  const answer = executed(await f.run(service, [id]));
  expect(answer).toMatchObject({ paying: [id], left: [] });
  expect((await batches(f)).find((batch) => batch.id === answer.batchId)).toMatchObject({
    kind: 'manual',
  });
  expect(await withdrawal(f, id)).toMatchObject({
    status: 'PAYING',
    review_mode: 'auto',
    reviewer_id: null,
    batch_id: answer.batchId,
    executor_id: f.adminId,
  });
});

it('[AC-B2-06c#8] review_mode 不变：review_mode=manual 的单经 system:auto_payout 的 kind=auto 批次执行后仍是 manual', async () => {
  const f = await setup(h);
  const service = f.execute();
  const reviewer = randomUUID();
  const id = await f.seedWithdrawal({ reviewMode: 'manual', reviewerId: reviewer });
  const answer = executed(await f.run(service, [id], { executorId: SYSTEM }));
  expect(answer).toMatchObject({ paying: [id], left: [] });
  expect(await batches(f)).toEqual([{ id: answer.batchId, kind: 'auto', created_by: null }]);
  expect(await withdrawal(f, id)).toMatchObject({
    status: 'PAYING',
    review_mode: 'manual',
    reviewer_id: reviewer,
    batch_id: answer.batchId,
    executor_id: null,
  });
});

it.each([
  ['payout.enabled', false, 'payout_disabled'],
  ['payout.queue_paused', true, 'queue_paused'],
] as const)(
  '[AC-B2-06c#5] ① %s=%s 整批拒绝 %s：已挂自动批次的单不改挂（batch_id 不变、无 moved_out、无新批次）',
  async (key, value, reason) => {
    const f = await setup(h);
    const service = f.execute();
    const auto = await f.seedBatch('auto');
    const id = await f.seedWithdrawal({ batchId: auto });
    const fresh = await f.seedWithdrawal({ userId: await f.newUser() });
    await f.set(key, value);
    const before = await snapshot(f);
    expect(await f.run(service, [id, fresh])).toEqual({ kind: 'rejected', reason });
    expect(await snapshot(f)).toEqual(before);
    expect((await withdrawal(f, id)).batch_id).toBe(auto);
    expect((await withdrawal(f, fresh)).batch_id).toBeNull();
    expect(await items(f)).toEqual([]);
    expect(await batches(f)).toEqual([{ id: auto, kind: 'auto', created_by: null }]);
  },
);

it('[AC-B2-06c#5] ③ 水位整批拒绝：已挂自动批次的单不改挂（batch_id 不变、无 moved_out、无新批次）', async () => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  const auto = await f.seedBatch('auto');
  const id = await f.seedWithdrawal({ batchId: auto });
  const before = await snapshot(f);
  expect(await f.run(service, [id])).toEqual({
    kind: 'rejected',
    reason: 'watermark_stale',
    channel: 'alipay',
  });
  expect(await snapshot(f)).toEqual(before);
  expect((await withdrawal(f, id)).batch_id).toBe(auto);
  expect(await items(f)).toEqual([]);
  expect(await batches(f)).toEqual([{ id: auto, kind: 'auto', created_by: null }]);
  expect(f.send).not.toHaveBeenCalled();
});

it('[AC-B2-06c#8] 自动批次：system:auto_payout 单单成批，kind=auto、created_by 空、executor_id 空，走同一命令', async () => {
  const f = await setup(h);
  const service = f.execute();
  const id = await f.seedWithdrawal({ net: 2800n });
  const answer = executed(await f.run(service, [id], { executorId: SYSTEM }));
  expect(answer).toMatchObject({ paying: [id], left: [] });
  await expectPaying(f, id, { batchId: answer.batchId, seq: 1, executor: null });
  expect(await batches(f)).toEqual([{ id: answer.batchId, kind: 'auto', created_by: null }]);
  expect(await items(f)).toEqual([
    {
      batch_id: answer.batchId,
      withdrawal_id: id,
      result: 'paying',
      reason: null,
      moved_to_batch_id: null,
    },
  ]);
  const queued = await jobs(f);
  expect(queued).toHaveLength(1);
  expectJob(f, queued, id, 1);
});

it('[AC-B2-06c#8] 自动批次 ② 不满足：该单留在 APPROVED 并列原因，不投递', async () => {
  const f = await setup(h);
  const service = f.execute();
  await f.set('payout.channel_paused.alipay', true);
  const id = await f.seedWithdrawal();
  const answer = executed(await f.run(service, [id], { executorId: SYSTEM }));
  expect(answer).toMatchObject({ paying: [], left: [{ id, reason: 'channel_disabled' }] });
  await expectUntouched(f, id, 'APPROVED');
  expect(await jobs(f)).toEqual([]);
});

it.each([
  ['payout.enabled', false, 'payout_disabled'],
  ['payout.queue_paused', true, 'queue_paused'],
] as const)(
  '[AC-B2-06c#8] 自动批次 ① %s=%s：整批拒绝 %s，该单留在 APPROVED',
  async (key, value, reason) => {
    const f = await setup(h);
    const service = f.execute();
    const id = await f.seedWithdrawal();
    await f.set(key, value);
    const before = await snapshot(f);
    expect(await f.run(service, [id], { executorId: SYSTEM })).toEqual({
      kind: 'rejected',
      reason,
    });
    expect(await snapshot(f)).toEqual(before);
    await expectUntouched(f, id, 'APPROVED');
  },
);

it('[AC-B2-06c#8] 自动批次 ③ 水位不满足：整批拒绝，该单留在 APPROVED，转账 0 次', async () => {
  const f = await setup(h, { watermarks: false });
  const service = f.execute();
  await f.watermark(100n, new Date(f.clock.now().getTime() - 60_000), 'alipay');
  const id = await f.seedWithdrawal({ net: 28000n });
  const before = await snapshot(f);
  expect(await f.run(service, [id], { executorId: SYSTEM })).toEqual({
    kind: 'rejected',
    reason: 'watermark_usable_exceeded',
    channel: 'alipay',
  });
  expect(await snapshot(f)).toEqual(before);
  expect(f.send).not.toHaveBeenCalled();
});
