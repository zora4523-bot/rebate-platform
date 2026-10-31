// B2-04zg: the settle handler's `bill` delivery when the bill job answers deferred (D10-476: the
// asset snapshot of the run day is not complete; 08 BR-FUND-04 ③, BR-FUND-18). Deferred is not a
// failure: the delivery completes (no queue retry is used; the catch-up sends the bill again
// later). A bill job that throws still fails the delivery (settle_jobs failed → the existing
// CouliSettleBillJobFailed alert). Unit test: the bill job and the executor are recording
// stand-ins, no database. Top-level it() only.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import type {
  BillJobInput,
  BillJobResult,
} from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import { createSettleJobHandler } from '../../../../apps/api/src/modules/settlement/worker/index.ts';
import {
  APP,
  BILL,
  BILL_DAY,
  BILL_DAY_START,
  BILL_MONTH,
  JD,
  TAOBAO,
  memoryLogger,
  receivedJob,
} from '../worker/kit.ts';
import { DAY_AFTER, outcomeOf } from './kit.ts';

/** A stand-in handle: the handler passes it to the bill job and runs nothing on it itself. */
const DB_HANDLE = { isTransaction: false, synthetic: 'db' } as unknown as Kysely<DB>;

function billJob(platform: string, day: string) {
  return receivedJob(BILL, { app_id: APP, platform, accounting_date: day });
}

function handlerWith(outcome: () => BillJobResult['outcome'] | Error) {
  const runs: BillJobInput[] = [];
  const executions: unknown[] = [];
  const { logger } = memoryLogger();
  const handler = createSettleJobHandler({
    db: DB_HANDLE,
    logger,
    bill: {
      async run(_db, input) {
        runs.push(input);
        const answer = outcome();
        if (answer instanceof Error) throw answer;
        return { outcome: answer, billId: BILL_MONTH, status: null };
      },
    },
    executor: {
      async run(input) {
        executions.push(input);
        return { outcome: 'idle' };
      },
    },
  });
  return { handler, runs, executions };
}

it('[AC-B2-04zg#2] 处理器 bill：账单任务 deferred（快照未完成）不当失败——本次投递正常完成（不耗队列重试），账单任务只调用一次、run_at 仍为 D 00:00 +08:00；账单任务抛错时投递照旧失败；非账单日 not_due 照旧完成', async () => {
  const deferred = handlerWith(() => 'deferred');
  const outcomes = [
    await outcomeOf(() => deferred.handler(billJob(TAOBAO, BILL_DAY))),
    // Another platform's bill of the same day (as a catch-up sends it): completes as well.
    await outcomeOf(() => deferred.handler(billJob(JD, BILL_DAY))),
  ];
  expect(outcomes).toStrictEqual([{ resolved: true }, { resolved: true }]);
  expect(
    deferred.runs.map((input) => ({
      appId: input.appId,
      platform: input.platform,
      runAt: input.runAt.toISOString(),
    })),
  ).toStrictEqual([
    { appId: APP, platform: TAOBAO, runAt: BILL_DAY_START },
    { appId: APP, platform: JD, runAt: BILL_DAY_START },
  ]);
  expect(deferred.executions).toStrictEqual([]);

  const failing = handlerWith(() => new Error('synthetic bill failure'));
  const failed = await outcomeOf(() => failing.handler(billJob(TAOBAO, BILL_DAY)));
  expect('rejected' in failed && failed.rejected.includes('synthetic bill failure')).toBe(true);
  expect(failing.runs).toHaveLength(1);

  const plain = handlerWith(() => 'not_due');
  expect(await outcomeOf(() => plain.handler(billJob(TAOBAO, DAY_AFTER)))).toStrictEqual({
    resolved: true,
  });
  expect(plain.runs).toHaveLength(1);
});
