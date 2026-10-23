// B2-06c ⑤ moving a withdrawal to a new manual batch and ⑧ the automatic batch (规划/08 BR-WDR-11,
// BR-WDR-12 细则 E-28, BR-WDR-30): a ticked APPROVED withdrawal already on another batch moves by a
// CAS on (status = APPROVED, batch_id = the old batch) in the same transaction, the old batch keeping
// an item 'moved_out'; two admins grouping it at once: only one gets it. The automatic batch is one
// withdrawal, kind=auto, executor 'system:auto_payout' (executor_id null), through the same command.
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

it('[AC-B2-06c#5] 两个人同时把同一张已挂别批的单组进各自批次：只有一个成功，转账任务只有一条', async () => {
  const f = await setup(h);
  const service = f.execute();
  const auto = await f.seedBatch('auto');
  const id = await f.seedWithdrawal({ net: 500n, batchId: auto });
  const results = await Promise.allSettled([
    f.run(service, [id], {}, h.db),
    f.run(service, [id], { executorId: randomUUID() }, h.observer),
  ]);
  const answers = results.map((r) => {
    expect(r.status).toBe('fulfilled');
    if (r.status !== 'fulfilled') throw r.reason;
    return executed(r.value);
  });
  const winners = answers.filter((a) => a.paying.includes(id));
  const losers = answers.filter((a) => !a.paying.includes(id));
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect(losers[0]!.left).toEqual([{ id, reason: 'not_approved' }]);
  const winner = winners[0]!;
  expect(await withdrawal(f, id)).toMatchObject({
    status: 'PAYING',
    execute_seq: 1,
    batch_id: winner.batchId,
  });
  const all = await items(f);
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
