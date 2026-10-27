// BR-WDR-30 自动路径 / EXECUTE 未通过: after the system W2 the consumer calls B2-06c's executeBatch
// for this one withdrawal with executor 'system:auto_payout'; a refused batch (BR-WDR-12 ① ③) or
// the withdrawal left out (②) keeps it APPROVED and appends execute_blocked with the reason to
// auto_decision; nothing retries EXECUTE. The last three tests run the real executeBatch.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  NOW,
  TIMEOUT,
  close,
  decision,
  expectOneExecute,
  open,
  setup,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each(['payout_disabled', 'queue_paused', 'watermark_below_forecast'] as const)(
  '[AC-B2-11c#60] EXECUTE 整批拒绝（%s）：单据留 APPROVED、review_mode=auto，auto_decision 追加 execute_blocked 为该原因',
  async (reason) => {
    const f = await setup(h);
    f.respond(() =>
      reason === 'watermark_below_forecast'
        ? { kind: 'rejected', reason, channel: 'alipay' }
        : { kind: 'rejected', reason },
    );
    const id = await f.start(100n);
    await f.consumer().consume(await f.event(id));
    expect(await f.row(id)).toMatchObject({
      status: 'APPROVED',
      review_mode: 'auto',
      reviewer_id: null,
      reviewed_at: NOW,
    });
    expect((await f.row(id)).auto_decision).toEqual(
      decision('auto', [], { execute_blocked: reason }),
    );
    expectOneExecute(f, id);
  },
);

it.each(['member_blocked', 'channel_disabled', 'has_transfer_attempt'] as const)(
  '[AC-B2-11c#61] EXECUTE 执行但本单未进入 PAYING（left: %s）：同样留 APPROVED 并记 execute_blocked',
  async (reason) => {
    const f = await setup(h);
    f.respond((batch) => ({
      kind: 'executed',
      batchId: randomUUID(),
      paying: [],
      left: batch.members.map((id) => ({ id, reason })),
    }));
    const id = await f.start(100n);
    await f.consumer().consume(await f.event(id));
    expect((await f.row(id)).auto_decision).toEqual(
      decision('auto', [], { execute_blocked: reason }),
    );
    expect((await f.row(id)).status).toBe('APPROVED');
    expectOneExecute(f, id);
  },
);

it('[AC-B2-11c#62] EXECUTE 未通过后系统不自动重试：再次投递（新 event_id）不再调用 executeBatch，execute_blocked 不变', async () => {
  const f = await setup(h);
  f.respond(() => ({ kind: 'rejected', reason: 'queue_paused' }));
  const id = await f.start(100n);
  const consumer = f.consumer();
  await consumer.consume(await f.event(id));
  const once = await f.row(id);
  f.respond(() => {
    throw new Error('EXECUTE must not be retried');
  });
  await consumer.consume(await f.event(id, randomUUID()));
  expect(await f.row(id)).toEqual(once);
  expectOneExecute(f, id);
});

it('[AC-B2-11c#63] 真 executeBatch：系统 W2 后建 kind=auto 单单批次（created_by 空），单据进入 PAYING、executor_id 空，入队一个转账任务', async () => {
  const f = await setup(h);
  await f.watermark(1_000_000_000n);
  const real = f.realExecute();
  const id = await f.start(28_000n);
  await f.consumer({ execute: real.service }).consume(await f.event(id));
  const row = await f.row(id);
  expect(row).toMatchObject({
    status: 'PAYING',
    review_mode: 'auto',
    reviewer_id: null,
    reviewed_at: NOW,
    executor_id: null,
    executed_at: NOW,
    execute_seq: 1,
  });
  expect(row.auto_decision).toEqual(decision('auto', []));
  const batches = await f.batches();
  expect(batches).toEqual([{ id: row.batch_id, kind: 'auto', created_by: null }]);
  expect(await f.batchItems()).toEqual([
    { batch_id: row.batch_id, withdrawal_id: id, result: 'paying', reason: null },
  ]);
  expect(real.send).toHaveBeenCalledTimes(1);
  expect(real.send).toHaveBeenCalledWith(
    'payout',
    'transfer',
    { withdrawal_id: id, execute_seq: 1, app_id: f.appId },
    expect.objectContaining({ singletonKey: `${id}:1` }),
  );
});

it('[AC-B2-11c#64] 08 例：判 auto 后水位不足 → 单据留 APPROVED、auto_decision 追加 execute_blocked（真 executeBatch：无水位录入即 watermark_stale），不建批次、不入队', async () => {
  const f = await setup(h);
  const real = f.realExecute();
  const id = await f.start(100n);
  await f.consumer({ execute: real.service }).consume(await f.event(id));
  expect(await f.row(id)).toMatchObject({
    status: 'APPROVED',
    review_mode: 'auto',
    batch_id: null,
    execute_seq: 0,
  });
  expect((await f.row(id)).auto_decision).toEqual(
    decision('auto', [], { execute_blocked: 'watermark_stale' }),
  );
  expect(await f.batches()).toEqual([]);
  expect(real.send).not.toHaveBeenCalled();
});

it('[AC-B2-11c#65] 真 executeBatch：payout.enabled=false → execute_blocked=payout_disabled，留 APPROVED', async () => {
  const f = await setup(h);
  await f.watermark(1_000_000_000n);
  await f.set('payout.enabled', false);
  const real = f.realExecute();
  const id = await f.start(100n);
  await f.consumer({ execute: real.service }).consume(await f.event(id));
  expect(await f.row(id)).toMatchObject({ status: 'APPROVED', review_mode: 'auto' });
  expect((await f.row(id)).auto_decision).toEqual(
    decision('auto', [], { execute_blocked: 'payout_disabled' }),
  );
  expect(await f.batches()).toEqual([]);
});
