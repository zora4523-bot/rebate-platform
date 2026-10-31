// B2-04ze: the keys, the bill's nominal run time, the sends and the settle handler's dispatch
// (D10-443; 02 §11 queue settle, jobs bill / batch_execute; 08 BR-FUND-04 ③ ⑦). Unit tests: no
// database, the bill job and the executor are recording stand-ins. Top-level it() only.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import type {
  BatchExecuteInput,
  BatchExecuteOutcome,
} from '../../../../apps/api/src/modules/settlement/batch/executor/executor.ts';
import type {
  BillJobInput,
  BillJobResult,
} from '../../../../apps/api/src/modules/settlement/bill/job.ts';
import {
  createSettleJobHandler,
  scheduleBatchExecute,
  scheduleSettleBill,
  settleBatchExecuteJobKey,
  settleBillJobKey,
  settleBillRunAt,
} from '../../../../apps/api/src/modules/settlement/worker/index.ts';
import {
  APP,
  BILL,
  BILL_DAY,
  BILL_DAY_START,
  BILL_MONTH,
  EXECUTE,
  JD,
  OTHER,
  PLAIN_DAY,
  TAOBAO,
  billKey,
  billSend,
  executeKey,
  executeSend,
  fakeQueue,
  memoryLogger,
  receivedJob,
  refusal,
  sendView,
} from './kit.ts';

const BATCH = '0190f000-0000-7000-8000-000000000001';
const OTHER_BATCH = '0190f000-0000-7000-8000-000000000002';
/** A stand-in handle: the handler passes it to the bill job and runs nothing on it itself. */
const DB_HANDLE = { isTransaction: false, synthetic: 'db' } as unknown as Kysely<DB>;

interface Recorder {
  readonly billRuns: { db: Kysely<DB>; input: BillJobInput }[];
  readonly executions: BatchExecuteInput[];
  billOutcome: BillJobResult['outcome'] | Error;
  executeOutcome: BatchExecuteOutcome | Error;
}

function handlerWith() {
  const recorder: Recorder = {
    billRuns: [],
    executions: [],
    billOutcome: 'generated',
    executeOutcome: 'done',
  };
  const { logger } = memoryLogger();
  const handler = createSettleJobHandler({
    db: DB_HANDLE,
    logger,
    bill: {
      async run(db, input) {
        recorder.billRuns.push({ db, input });
        if (recorder.billOutcome instanceof Error) throw recorder.billOutcome;
        return { outcome: recorder.billOutcome, billId: BILL_MONTH, status: null };
      },
    },
    executor: {
      async run(input) {
        recorder.executions.push(input);
        if (recorder.executeOutcome instanceof Error) throw recorder.executeOutcome;
        return { outcome: recorder.executeOutcome };
      },
    },
  });
  return { handler, recorder };
}

it('[AC-B2-04ze#1] bill 的 singletonKey = bill:<app_id>:<platform>:<D>，按 app、平台、D 各不相同，只用队列允许的字符', () => {
  const keys = [
    settleBillJobKey(APP, TAOBAO, BILL_DAY),
    settleBillJobKey(APP, JD, BILL_DAY),
    settleBillJobKey(OTHER, TAOBAO, BILL_DAY),
    settleBillJobKey(APP, TAOBAO, PLAIN_DAY),
  ];
  expect(keys).toStrictEqual([
    'bill:sw-app-a:taobao:2032-07-24',
    'bill:sw-app-a:jd:2032-07-24',
    'bill:sw-app-b:taobao:2032-07-24',
    'bill:sw-app-a:taobao:2032-07-10',
  ]);
  expect(new Set(keys).size).toBe(4);
  for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9:._+-]{1,200}$/u);
});

it('[AC-B2-04ze#2] batch_execute 的 singletonKey = batch_execute:<app_id>:<batch_id>，每批一个', () => {
  expect([
    settleBatchExecuteJobKey(APP, BATCH),
    settleBatchExecuteJobKey(APP, OTHER_BATCH),
    settleBatchExecuteJobKey(OTHER, BATCH),
  ]).toStrictEqual([
    `batch_execute:sw-app-a:${BATCH}`,
    `batch_execute:sw-app-a:${OTHER_BATCH}`,
    `batch_execute:sw-app-b:${BATCH}`,
  ]);
  expect(settleBatchExecuteJobKey(APP, BATCH)).toMatch(/^[A-Za-z0-9:._+-]{1,200}$/u);
});

it('[AC-B2-04ze#3] bill 的名义 run_at = D 当日 00:00 +08:00（月末、年初、闰日照样），同一 D 每次都相同；不存在或格式不对的 D 被拒绝', async () => {
  const cases: Record<string, string> = {
    [BILL_DAY]: BILL_DAY_START,
    '2032-02-29': '2032-02-28T16:00:00.000Z',
    '2033-01-01': '2032-12-31T16:00:00.000Z',
    '2032-12-24': '2032-12-23T16:00:00.000Z',
    '2031-02-28': '2031-02-27T16:00:00.000Z',
  };
  expect(
    Object.fromEntries(Object.keys(cases).map((day) => [day, settleBillRunAt(day).toISOString()])),
  ).toStrictEqual(cases);
  expect(settleBillRunAt(BILL_DAY).getTime()).toBe(settleBillRunAt(BILL_DAY).getTime());
  for (const day of ['2031-02-29', '2032-02-30', '2032-7-24', '2032/07/24', '']) {
    await refusal(async () => settleBillRunAt(day));
  }
});

it('[AC-B2-04ze#4] scheduleSettleBill：送 settle / bill，负载 { app_id, platform, accounting_date }，singletonKey bill:<app>:<platform>:<D>，立即（无延迟）；事务原样交给队列，返回队列的结果', async () => {
  const queue = fakeQueue();
  const trx = { isTransaction: true } as never;
  const ids = [
    await scheduleSettleBill(queue, null, {
      appId: APP,
      platform: TAOBAO,
      accountingDate: BILL_DAY,
    }),
    await scheduleSettleBill(queue, trx, { appId: OTHER, platform: JD, accountingDate: PLAIN_DAY }),
  ];
  expect(queue.sent.map(sendView)).toStrictEqual([
    billSend(APP, TAOBAO, BILL_DAY),
    billSend(OTHER, JD, PLAIN_DAY),
  ]);
  expect(queue.sent.map((job) => job.inTransaction)).toStrictEqual([false, true]);
  expect(queue.sent[0]?.options.trx).toBeNull();
  expect(ids.every((id) => typeof id === 'string' && id !== '')).toBe(true);
  expect(queue.sent.map((job) => job.options.singletonKey)).toStrictEqual([
    billKey(APP, TAOBAO, BILL_DAY),
    billKey(OTHER, JD, PLAIN_DAY),
  ]);
});

it('[AC-B2-04ze#5] scheduleBatchExecute：送 settle / batch_execute，负载 { app_id, batch_id }，singletonKey batch_execute:<app>:<batch>，立即；事务原样交给队列', async () => {
  const queue = fakeQueue();
  const trx = { isTransaction: true } as never;
  await scheduleBatchExecute(queue, null, { appId: APP, batchId: BATCH });
  await scheduleBatchExecute(queue, trx, { appId: OTHER, batchId: OTHER_BATCH });
  expect(queue.sent.map(sendView)).toStrictEqual([
    executeSend(APP, BATCH),
    executeSend(OTHER, OTHER_BATCH),
  ]);
  expect(queue.sent.map((job) => job.inTransaction)).toStrictEqual([false, true]);
  expect(queue.sent.map((job) => job.options.singletonKey)).toStrictEqual([
    executeKey(APP, BATCH),
    executeKey(OTHER, OTHER_BATCH),
  ]);
});

it('[AC-B2-04ze#6] 处理器 bill：以负载的 (app, platform) 与 run_at = D 00:00 +08:00 调用账单任务一次（db 为装配的库句柄）；generated / duplicate / not_due 都正常完成', async () => {
  const { handler, recorder } = handlerWith();
  for (const outcome of ['generated', 'duplicate', 'not_due'] as const) {
    recorder.billOutcome = outcome;
    await handler(receivedJob(BILL, { app_id: APP, platform: TAOBAO, accounting_date: BILL_DAY }));
  }
  expect(recorder.billRuns).toHaveLength(3);
  for (const run of recorder.billRuns) {
    expect(run.db).toBe(DB_HANDLE);
    expect({
      appId: run.input.appId,
      platform: run.input.platform,
      runAt: run.input.runAt.toISOString(),
    }).toStrictEqual({ appId: APP, platform: TAOBAO, runAt: BILL_DAY_START });
  }
  expect(recorder.executions).toStrictEqual([]);
});

it('[AC-B2-04ze#7] 处理器 bill（D10-476 ② test-change）：账单任务 deferred（当日资产快照未完成）时本次投递正常完成（不耗队列重试）、不调用执行器；同 singletonKey 的延后重排再次投递同一负载，快照完成后答 generated 同样正常完成，两次 run_at 都是 D 00:00 +08:00；账单任务抛错时原样失败', async () => {
  const { handler, recorder } = handlerWith();
  const payload = { app_id: APP, platform: JD, accounting_date: BILL_DAY };
  recorder.billOutcome = 'deferred';
  await expect(handler(receivedJob(BILL, payload))).resolves.toBeUndefined();
  expect(recorder.billRuns).toHaveLength(1);
  expect(recorder.executions).toStrictEqual([]);

  // The delayed re-send under the same key is a new job (first attempt) with the same payload; the
  // snapshot is complete by then.
  recorder.billOutcome = 'generated';
  await expect(handler(receivedJob(BILL, payload, 1))).resolves.toBeUndefined();
  expect(
    recorder.billRuns.map((run) => ({
      appId: run.input.appId,
      platform: run.input.platform,
      runAt: run.input.runAt.toISOString(),
    })),
  ).toStrictEqual([
    { appId: APP, platform: JD, runAt: BILL_DAY_START },
    { appId: APP, platform: JD, runAt: BILL_DAY_START },
  ]);
  expect(recorder.executions).toStrictEqual([]);

  recorder.billOutcome = new Error('synthetic bill failure');
  const text = await refusal(() => handler(receivedJob(BILL, payload)));
  expect(text).toContain('synthetic bill failure');
  expect(recorder.billRuns).toHaveLength(3);
});

it('[AC-B2-04ze#8] 处理器 batch_execute：以负载的 (app, batch) 调用执行器一次；done / partial / day_rollover / not_due / snapshot_pending / switched_off / idle / busy 都正常完成（进度在批次表，扫描会再投）；执行器抛错时原样失败', async () => {
  const { handler, recorder } = handlerWith();
  const outcomes: BatchExecuteOutcome[] = [
    'done',
    'partial',
    'day_rollover',
    'not_due',
    'snapshot_pending',
    'switched_off',
    'idle',
    'busy',
  ];
  for (const outcome of outcomes) {
    recorder.executeOutcome = outcome;
    await handler(receivedJob(EXECUTE, { app_id: APP, batch_id: BATCH }));
  }
  expect(recorder.executions).toStrictEqual(outcomes.map(() => ({ appId: APP, batchId: BATCH })));
  expect(recorder.billRuns).toStrictEqual([]);

  recorder.executeOutcome = new Error('synthetic executor failure');
  const text = await refusal(() =>
    handler(receivedJob(EXECUTE, { app_id: APP, batch_id: OTHER_BATCH })),
  );
  expect(text).toContain('synthetic executor failure');
});

it('[AC-B2-04ze#9] 处理器拒绝未知任务名与不合格负载，且不调用账单任务或执行器', async () => {
  const { handler, recorder } = handlerWith();
  const bad: [string, Record<string, string | number | null>][] = [
    ['credit', { app_id: APP, platform: TAOBAO, accounting_date: BILL_DAY }],
    ['settle_adjust', { app_id: APP, platform: TAOBAO, accounting_date: BILL_DAY }],
    [BILL, { platform: TAOBAO, accounting_date: BILL_DAY }],
    [BILL, { app_id: '', platform: TAOBAO, accounting_date: BILL_DAY }],
    [BILL, { app_id: APP, platform: '', accounting_date: BILL_DAY }],
    [BILL, { app_id: APP, platform: TAOBAO }],
    [BILL, { app_id: APP, platform: TAOBAO, accounting_date: '2032-02-30' }],
    [BILL, { app_id: APP, platform: TAOBAO, accounting_date: 20320724 }],
    [EXECUTE, { app_id: APP }],
    [EXECUTE, { app_id: APP, batch_id: null }],
    [EXECUTE, { batch_id: BATCH }],
    [EXECUTE, { app_id: '', batch_id: BATCH }],
  ];
  for (const [name, payload] of bad) {
    await refusal(() => handler(receivedJob(name, payload)));
  }
  expect(recorder.billRuns).toStrictEqual([]);
  expect(recorder.executions).toStrictEqual([]);
});
