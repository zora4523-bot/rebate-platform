// B2-06c ④ enqueueing and ⑥ re-execution (规划/08 BR-WDR-12; 规划/02 §5.3 / §11; ADR-0001 §4.2 #19):
// one payout job per withdrawal on the caller's transaction (visible only after commit, gone on
// rollback), singletonKey `{withdrawal_id}:{execute_seq}`; a repeated click is deduplicated by the
// state CAS; after W9 (PAYING → APPROVED, seeded here) a new EXECUTE gives execute_seq 2 and a new job.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  TIMEOUT,
  batches,
  close,
  events,
  executed,
  expectJob,
  expectPaying,
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

it('[AC-B2-06c#4] 任务与迁移同一事务：提交前别的连接看不到任务，提交后每单恰好一条，去重键 id:execute_seq', async () => {
  const f = await setup(h);
  const service = f.execute();
  const a = await f.seedWithdrawal({ net: 100n });
  const b = await f.seedWithdrawal({ net: 200n, userId: await f.newUser() });
  const result = await h.db.transaction().execute(async (trx) => {
    const answer = await service.executeBatch(trx, {
      appId: f.appId,
      members: [a, b],
      executorId: f.adminId,
      now: f.clock.now(),
    });
    const inside = await jobs(f, trx);
    expect(sorted(inside.map((job) => job.singleton_key ?? ''))).toEqual(
      sorted([`${a}:1`, `${b}:1`]),
    );
    expect(await jobs(f, h.observer)).toEqual([]);
    expect((await withdrawal(f, a, h.observer)).status).toBe('APPROVED');
    for (const call of f.send.mock.calls) {
      expect(call[0]).toBe('payout');
      expect(call[3].trx).toBe(trx);
    }
    return answer;
  });
  expect(sorted(executed(result).paying)).toEqual(sorted([a, b]));
  const queued = await jobs(f, h.observer);
  expect(queued).toHaveLength(2);
  expectJob(f, queued, a, 1);
  expectJob(f, queued, b, 1);
  expect(queued.map((job) => job.state)).toEqual(['created', 'created']);
  expect(f.send).toHaveBeenCalledTimes(2);
});

it('[AC-B2-06c#4] 调用方事务回滚：没有任务、没有 PAYING、没有批次与明细、没有事件', async () => {
  const f = await setup(h);
  const service = f.execute();
  const a = await f.seedWithdrawal();
  const before = await snapshot(f);
  const batchesBefore = await batches(f);
  const rollback = new Error('synthetic rollback');
  await expect(
    h.db.transaction().execute(async (trx) => {
      const answer = await service.executeBatch(trx, {
        appId: f.appId,
        members: [a],
        executorId: f.adminId,
        now: f.clock.now(),
      });
      expect(executed(answer).paying).toEqual([a]);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await snapshot(f)).toEqual(before);
  expect(await batches(f)).toEqual(batchesBefore);
  expect(await jobs(f)).toEqual([]);
});

it('[AC-B2-06c#4] 重复点击执行靠状态 CAS 去重：已是 PAYING 的单记 not_approved，不再投递', async () => {
  const f = await setup(h);
  const service = f.execute();
  const a = await f.seedWithdrawal();
  const first = executed(await f.run(service, [a]));
  const second = executed(await f.run(service, [a]));
  expect(first.paying).toEqual([a]);
  expect(second).toMatchObject({ paying: [], left: [{ id: a, reason: 'not_approved' }] });
  expect(second.batchId).not.toBe(first.batchId);
  await expectPaying(f, a, { batchId: first.batchId, seq: 1, executor: f.adminId });
  const queued = await jobs(f);
  expect(queued).toHaveLength(1);
  expectJob(f, queued, a, 1);
  expect((await items(f)).filter((item) => item.batch_id === second.batchId)).toEqual([
    {
      batch_id: second.batchId,
      withdrawal_id: a,
      result: 'skipped',
      reason: 'not_approved',
      moved_to_batch_id: null,
    },
  ]);
  expect(await events(f)).toHaveLength(1);
});

it('[AC-B2-06c#6] 经 W9 回到 APPROVED 后再执行：execute_seq=2、新任务 id:2，原批次记已移出', async () => {
  const f = await setup(h);
  const service = f.execute();
  const a = await f.seedWithdrawal({ net: 280n });
  const first = executed(await f.run(service, [a]));
  await expectPaying(f, a, { batchId: first.batchId, seq: 1, executor: f.adminId });
  await f.seedHold(a);
  expect(await withdrawal(f, a)).toMatchObject({ status: 'APPROVED', execute_seq: 1 });
  const second = executed(await f.run(service, [a]));
  expect(second.paying).toEqual([a]);
  await expectPaying(f, a, { batchId: second.batchId, seq: 2, executor: f.adminId });
  const queued = await jobs(f);
  expect(queued).toHaveLength(2);
  expectJob(f, queued, a, 1);
  expectJob(f, queued, a, 2);
  expect(await items(f)).toEqual(
    expect.arrayContaining([
      {
        batch_id: first.batchId,
        withdrawal_id: a,
        result: 'moved_out',
        reason: null,
        moved_to_batch_id: second.batchId,
      },
      {
        batch_id: second.batchId,
        withdrawal_id: a,
        result: 'paying',
        reason: null,
        moved_to_batch_id: null,
      },
    ]),
  );
});
