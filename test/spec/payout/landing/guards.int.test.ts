// B2-06fz ① ② (D10-326 C; 规划/08 BR-WDR-14; at-least-once delivery, AGENTS.md rule 5): a
// payout-landing job that cannot land ends with nothing written —
//   ① the withdrawal of the payload is missing, of another app, no longer PAYING, or of another
//      execute_seq → info and resolve; needs_manual = true (T + 24 h passed, only W10 ends it,
//      BR-WDR-14) → resolve;
//   ② the attempt it names is missing, another withdrawal's, or its result is not success / fail
//      (unknown, pending), or its response.kind is not success / fail (a payer-side result is
//      stored as result = fail with response.kind = payer_side; W9 is the payout process's) →
//      warn and resolve.
// "Nothing written": withdrawals, attempts, jobs, events, vouchers, balances and config of the app
// are exactly as before (snapshot), and the job resolves (no queue retry).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  TIMEOUT,
  close,
  expectNoPayeeInLogs,
  landJobOf,
  markNeedsManual,
  open,
  seedResult,
  seedSuccess,
  setup,
  snapshot,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each(['APPROVED', 'PAID_API', 'FAILED', 'REJECTED'] as const)(
  '[AC-B2-06fz#4] 单据已是 %s（不是 PAYING）：成功尝试的落库任务在 ① 结束（info），零副作用',
  async (status) => {
    const f = await setup(h);
    const handler = f.landingJob();
    const w = await f.seedWithdrawal({ status });
    const attemptId = await seedSuccess(f, w);
    const before = await snapshot(f);
    await expect(handler(landJobOf(w, attemptId))).resolves.toBeUndefined();
    expect(await snapshot(f)).toEqual(before);
    expect(f.logger.info).toHaveBeenCalled();
    expect(f.logger.warn).not.toHaveBeenCalled();
  },
);

it.each([
  ['任务的 execute_seq 比单据旧（1 vs 2）', 2, 1],
  ['任务的 execute_seq 比单据新（3 vs 2）', 2, 3],
] as const)('[AC-B2-06fz#4] %s：在 ① 结束（info），零副作用', async (_label, seq, jobSeq) => {
  const f = await setup(h);
  const handler = f.landingJob();
  const w = await f.seedWithdrawal({ executeSeq: seq });
  const attemptId = await seedSuccess(f, w);
  const before = await snapshot(f);
  await expect(handler(landJobOf(w, attemptId, { seq: jobSeq }))).resolves.toBeUndefined();
  expect(await snapshot(f)).toEqual(before);
  expect(f.logger.info).toHaveBeenCalled();
  expect(f.logger.warn).not.toHaveBeenCalled();
});

it('[AC-B2-06fz#4] 任务的 app_id 不是单据所属应用：按「没有这张单」结束（info），零副作用', async () => {
  const f = await setup(h);
  const handler = f.landingJob();
  const w = await f.seedWithdrawal();
  const attemptId = await seedSuccess(f, w);
  const before = await snapshot(f);
  await expect(
    handler(landJobOf(w, attemptId, { appId: `landing_other_${w.id}` })),
  ).resolves.toBeUndefined();
  expect(await snapshot(f)).toEqual(before);
  expect(f.logger.info).toHaveBeenCalled();
  expect(f.logger.warn).not.toHaveBeenCalled();
});

it('[AC-B2-06fz#4] 提现单不存在：在 ① 结束（info），零副作用', async () => {
  const f = await setup(h);
  const handler = f.landingJob();
  const w = await f.seedWithdrawal();
  const attemptId = await seedSuccess(f, w);
  const before = await snapshot(f);
  await expect(
    handler(landJobOf(w, attemptId, { withdrawalId: randomUUID() })),
  ).resolves.toBeUndefined();
  expect(await snapshot(f)).toEqual(before);
  expect(f.logger.info).toHaveBeenCalled();
  expect(f.logger.warn).not.toHaveBeenCalled();
});

it('[AC-B2-06fz#4] PAYING 但已置 needs_manual（T+24 小时已到，只能经 W10 结束）：迟到的成功尝试不迁移、不记账、无事件', async () => {
  const f = await setup(h);
  const handler = f.landingJob();
  const w = await f.seedWithdrawal();
  const attemptId = await seedSuccess(f, w, { kind: 'query' });
  await markNeedsManual(f, w);
  const before = await snapshot(f);
  await expect(handler(landJobOf(w, attemptId))).resolves.toBeUndefined();
  expect(await snapshot(f)).toEqual(before);
});

it.each(['unknown', 'pending'] as const)(
  '[AC-B2-06fz#5] 任务指向的尝试结果为 %s（不是 success / fail）：warn 后结束，零副作用',
  async (result) => {
    const f = await setup(h);
    const handler = f.landingJob();
    const w = await f.seedWithdrawal();
    const attemptId = await seedResult(f, w, {
      result,
      respCode: result === 'pending' ? null : '20000',
      respSubCode: result === 'pending' ? null : 'SYSTEM_ERROR',
      response: result === 'pending' ? null : { raw: { code: '20000' }, kind: 'unknown' },
    });
    const before = await snapshot(f);
    await expect(handler(landJobOf(w, attemptId))).resolves.toBeUndefined();
    expect(await snapshot(f)).toEqual(before);
    expect(f.logger.warn).toHaveBeenCalled();
  },
);

it('[AC-B2-06fz#5] 任务指向付款方侧结果（result 列为 fail、response.kind=payer_side，W9 归 payout 进程）：worker 只认 response.kind ∈ {success, fail}，warn 后结束，零副作用', async () => {
  const f = await setup(h);
  const handler = f.landingJob();
  const w = await f.seedWithdrawal();
  const attemptId = await seedResult(f, w, {
    result: 'fail',
    respCode: '40004',
    respSubCode: 'TEST_PAYER_SIDE',
    response: {
      raw: { code: '40004', subCode: 'TEST_PAYER_SIDE', msg: 'synthetic' },
      kind: 'payer_side',
    },
  });
  const before = await snapshot(f);
  await expect(handler(landJobOf(w, attemptId))).resolves.toBeUndefined();
  expect(await snapshot(f)).toEqual(before);
  expect(f.logger.warn).toHaveBeenCalled();
  expectNoPayeeInLogs(f);
});

it('[AC-B2-06fz#5] 任务指向的成功尝试属于另一张提现单（同一应用）：warn 后结束，两张单都零副作用', async () => {
  const f = await setup(h);
  const handler = f.landingJob();
  const w = await f.seedWithdrawal();
  const other = await f.seedWithdrawal();
  const attemptId = await seedSuccess(f, other);
  const before = await snapshot(f);
  await expect(handler(landJobOf(w, attemptId))).resolves.toBeUndefined();
  expect(await snapshot(f)).toEqual(before);
  expect(f.logger.warn).toHaveBeenCalled();
  expectNoPayeeInLogs(f);
});

it('[AC-B2-06fz#5] 任务指向的尝试不存在：warn 后结束，零副作用', async () => {
  const f = await setup(h);
  const handler = f.landingJob();
  const w = await f.seedWithdrawal();
  await seedSuccess(f, w);
  const before = await snapshot(f);
  await expect(handler(landJobOf(w, randomUUID()))).resolves.toBeUndefined();
  expect(await snapshot(f)).toEqual(before);
  expect(f.logger.warn).toHaveBeenCalled();
});
