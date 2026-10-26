// B2-15m self-heal rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-07（每日 T+1 用渠道的交易账单
// 逐笔核对：每个账单日都要核对，不能漏日）；B2-15m rule-test review r1 S1 (a seed that runs once at bootstrap
// and only for Apps that already have collection records leaves an App whose first PAID order
// comes later, or every App when that one seed fails, without any bill.recon until a restart, and
// the restart then starts at yesterday: the days between are lost). As B1-22b's chain
// (union/auth-expiry/union-auth.module.ts: seed after bootstrap, a failed seed is retried, then a
// heal every HEAL_INTERVAL_MS), the worker entry itself must keep healing the daily chain without
// a restart or an enqueue by hand, and a healed App starts at its first bill day not yet
// reconciled (none reconciled: the first day with collection), never at the clock's yesterday.
// The real worker entry (./kit.ts startWorker: createWorkerContext on the fixture's database and
// clock, only JOB_QUEUE recorded, never started) runs on fake setTimeout / setInterval that also
// move with wall time (shouldAdvanceTime: whatever bootstrap awaits still runs) and are pushed
// ahead in STEP_MS steps, each followed by a short real wait for the database work a timer
// started (node:timers/promises is not faked; neither is Date, the entry reads the FixedClock).
// The heal period is the implementation's; these tests allow at most HEAL_WITHIN_MS of timer time
// (B1-22b heals every 5 minutes). The healed chain then runs the way the worker runs it: bill.recon
// through createPayJobHandler, each next run taken from what the previous one enqueued.
// Top-level it() only (规划/11 §4.3).
import { setTimeout as realDelay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import {
  createRootLogger,
  type DbHandles,
  type FixedClock,
  type JobPayload,
  type RootLogger,
  type SendOptions,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { enable, suite, type Fixture } from '../orders/kit.ts';
import {
  AMOUNT,
  diffs,
  expectDiff,
  feeVoucherOf,
  lineOf,
  paidOrder,
  recon,
  settled,
  shape,
  vouchersLike,
} from '../recon/kit.ts';
import {
  AT_ONCE_SECONDS,
  BILL_RECON_JOB,
  PAY_QUEUE,
  billDateOf,
  dailySends,
  dayEndMs,
  dueMs,
  inDay,
  reconHandler,
  startWorker,
  workerReconSends,
  type RecordedSend,
  type Worker,
} from './kit.ts';

const s = suite();

/** 2026-10-20 10:00 +08:00: the worker starts. */
const START = '2026-10-20T02:00:00.000Z';
/** The bill day before 2026-10-20 at +08:00: what the bootstrap seed enqueues. */
const SEEDED_DAY = '2026-10-19';
/** 2026-10-25 10:00 +08:00: the same worker, still running, five days later. */
const LATER = '2026-10-25T02:00:00.000Z';
/** The late App's first day with collection. */
const FIRST_DAY = '2026-10-21';
/** The days the heal must fill in from there, up to the day before 10-25. */
const MISSED_DAYS = [FIRST_DAY, '2026-10-22', '2026-10-23', '2026-10-24'];

/** How long after bootstrap the first seed may take (timer time; #7 allows a minute). */
const SEED_WITHIN_MS = 60_000;
/** How long (timer time) a heal of the chain may take to come: at most an hour. */
const HEAL_WITHIN_MS = 60 * 60_000;
/** One push of the fake timers. */
const STEP_MS = 60_000;
/** Real time after each push, for the database work the fired timers started. */
const POLL_MS = 100;
/** Real time, after the last push, for a heal still running. */
const SETTLE_MS = 15_000;

function fakeTimers(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    shouldAdvanceTime: true,
  });
}

/** Polls `ready` with real time (node:timers/promises) for at most `limitMs` of real time. */
async function realWaitFor(ready: () => boolean, limitMs: number): Promise<boolean> {
  const stop = performance.now() + limitMs;
  for (;;) {
    if (ready()) return true;
    if (performance.now() > stop) return false;
    await realDelay(50);
  }
}

/** Pushes the fake timers STEP_MS at a time, up to `limitMs`, until `ready`; whether it got true. */
async function drive(ready: () => boolean, limitMs: number): Promise<boolean> {
  for (let pushed = 0; pushed < limitMs; pushed += STEP_MS) {
    if (ready()) return true;
    await vi.advanceTimersByTimeAsync(STEP_MS);
    await realDelay(POLL_MS);
  }
  return realWaitFor(ready, SETTLE_MS);
}

/** The worker's daily bill.recon sends (no pay_channel) naming the app, from index `from` on. */
function workerDaily(worker: Worker, appId: string, from = 0): RecordedSend[] {
  return workerReconSends(worker, appId)
    .slice(from)
    .filter((job) => job.payload['pay_channel'] === undefined);
}

// ---------------------------------------------------------------------------------------------
// The worker entry whose JOB_QUEUE refuses bill.recon until opened (./kit.ts startWorker
// otherwise): the queue is not ready when the startup seed runs.

interface Gate {
  open: boolean;
  /** Every bill.recon send refused while closed. */
  readonly refused: RecordedSend[];
}

interface WorkerBootstrap {
  createWorkerContext(
    entry: 'worker',
    overrides: {
      readonly config: unknown;
      readonly clock: FixedClock;
      readonly logger: RootLogger;
      readonly dbHandles: DbHandles;
    },
  ): Promise<{ close(): Promise<void> }>;
}

interface PlatformRuntime {
  readonly PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
  readonly JOB_QUEUE: symbol;
  loadConfig(env: Record<string, string>): unknown;
}

const ROOT = new URL('../../../../', import.meta.url);

async function startGatedWorker(f: Fixture, gate: Gate): Promise<Worker> {
  // Loaded by URL as ./kit.ts does: bootstrap and app.module pull in the Nest controllers.
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as WorkerBootstrap;
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as PlatformRuntime;
  const sent: RecordedSend[] = [];
  const logs: string[] = [];
  const queue = {
    async send(queueName: string, name: string, payload: JobPayload, options: SendOptions) {
      const job: RecordedSend = { queue: queueName, name, payload, options };
      // Only bill.recon is refused: the other modules' sends go on as in ./kit.ts.
      if (!gate.open && name === BILL_RECON_JOB) {
        gate.refused.push(job);
        throw new Error('spec: the job queue is not ready');
      }
      sent.push(job);
      return `spec-${sent.length}`;
    },
    register: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const original = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  const spy = vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === platform.JOB_QUEUE
          ? { provide: platform.JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  try {
    const context = await boot.createWorkerContext('worker', {
      config: platform.loadConfig({ APP_ENV: 'test' }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'worker', appEnv: 'test', level: 'info' },
        {
          write: (line) => {
            logs.push(line);
          },
        },
      ),
      dbHandles: { db: f.db, dbRead: null, close: async () => undefined },
    });
    return {
      sent,
      logs,
      async close() {
        try {
          await context.close();
        } finally {
          spy.mockRestore();
        }
      },
    };
  } catch (error) {
    spy.mockRestore();
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------

it('[AC-B2-15m#8] 首笔收款晚于启动种子、worker 不重启也不人工入队：2026-10-20 启动时 App X 尚无收款记录（种子只种了已有收款的 App），X 在 10-21 收款（其中一笔不在微信账单里），到 10-25 同一 worker 一小时内（定时器时间）自己为 X 入队 bill.recon，账单日从 X 第一个未对账的账单日 10-21 起（立即到期、不带渠道、singletonKey 含 X 与 10-21），不是按当前时刻的 10-24；据此补跑的链依次对账 10-21～10-24 各一次，10-21 的差错单与 PAY_FEE 照记，追上后 10-25 的日跑不早于 10-25 结束', async () => {
  const r = await recon(s, START);
  await enable(r.f);
  await paidOrder(r, 'wechat_pay', { paidAt: inDay(SEEDED_DAY) });
  const x = await recon(s, START);
  await enable(x.f);
  const seededApp = r.f.subject.app_id;
  const appId = x.f.subject.app_id;

  let healed: RecordedSend[] = [];
  let missingId = '';
  fakeTimers();
  try {
    const worker = await startWorker(r.f);
    try {
      // The bootstrap seed has run (the App with collection got its run) before X has any.
      const seeded = await drive(
        () => workerReconSends(worker, seededApp).length > 0,
        SEED_WITHIN_MS,
      );
      expect(seeded, `the bootstrap seed enqueued a bill.recon of ${seededApp}`).toBe(true);

      // Five days on, same process: X's first collection is on 10-21, none of it reconciled.
      r.f.clock.set(LATER);
      x.f.clock.set(LATER);
      const before = workerReconSends(worker, appId).length;
      const listed = await paidOrder(x, 'wechat_pay', { paidAt: inDay(FIRST_DAY) });
      // Paid inside 10-21, missing from the WeChat bill: one pay_mismatch of 10-21.
      missingId = (await paidOrder(x, 'wechat_pay', { paidAt: inDay(FIRST_DAY) })).id;
      const other = await paidOrder(x, 'alipay', { paidAt: inDay(FIRST_DAY) });
      x.channels.wechat_pay.setBill(FIRST_DAY, [lineOf(listed, { feeFen: 51n })]);
      x.channels.alipay.setBill(FIRST_DAY, [lineOf(other, { feeFen: 151n })]);
      for (const day of MISSED_DAYS.slice(1)) {
        x.channels.wechat_pay.setBill(day, []);
        x.channels.alipay.setBill(day, []);
      }

      const healedInTime = await drive(
        () => workerDaily(worker, appId, before).length > 0,
        HEAL_WITHIN_MS,
      );
      expect(healedInTime, `${appId} healed by the running worker, no restart`).toBe(true);
      healed = workerDaily(worker, appId, before);
    } finally {
      await worker.close();
    }
  } finally {
    vi.useRealTimers();
  }

  for (const job of healed) {
    expect(job.queue).toBe(PAY_QUEUE);
    expect(job.name).toBe(BILL_RECON_JOB);
    expect(job.payload, 'from the first bill day not reconciled').toMatchObject({
      app_id: appId,
      bill_date: FIRST_DAY,
    });
    expect(job.options.singletonKey ?? '', 'singletonKey').toContain(appId);
    expect(job.options.singletonKey ?? '', 'singletonKey').toContain(FIRST_DAY);
    expect(job.options.delaySeconds ?? 0, 'not before now').toBeGreaterThanOrEqual(0);
    expect(job.options.delaySeconds ?? 0, 'overdue: due at once').toBeLessThanOrEqual(
      AT_ONCE_SECONDS,
    );
  }

  // The healed run, then whatever each run enqueued for the next day while it is due at once.
  const run = await reconHandler(x.kit);
  const ran: string[] = [];
  let payload: JobPayload | null = healed[0]!.payload;
  for (let step = 0; step < 8 && payload !== null; step += 1) {
    expect(await settled(run(payload)), `the run of ${String(payload['bill_date'])}`).toBe(
      'resolved',
    );
    ran.push(String(payload['bill_date']));
    const next = dailySends(x.kit, appId).at(-1);
    payload =
      next !== undefined &&
      !ran.includes(billDateOf(next)) &&
      (next.options.delaySeconds ?? 0) <= AT_ONCE_SECONDS
        ? next.payload
        : null;
  }
  expect(ran, 'every missed bill day reconciled once, none skipped').toEqual(MISSED_DAYS);
  expect(x.channels.wechat_pay.billDates).toEqual(MISSED_DAYS);
  expect(x.channels.alipay.billDates).toEqual(MISSED_DAYS);
  const chain = dailySends(x.kit, appId);
  expect(chain.map(billDateOf)).toEqual([...MISSED_DAYS.slice(1), '2026-10-25']);
  expect(dueMs(x.f.clock, chain.at(-1)!), 'not before 10-25 is over').toBeGreaterThanOrEqual(
    dayEndMs('2026-10-25'),
  );

  const found = await diffs(x);
  expect(found).toHaveLength(1);
  expectDiff(x, found[0], {
    type: 'pay_mismatch',
    refType: 'pay_order',
    refId: missingId,
    expectedFen: AMOUNT,
    actualFen: 0n,
  });
  const fees = (await vouchersLike(x, 'PAY_FEE:')).map(shape);
  expect(fees).toHaveLength(2);
  expect(fees).toEqual(
    expect.arrayContaining([
      feeVoucherOf('wechat_pay', FIRST_DAY, 51n),
      feeVoucherOf('alipay', FIRST_DAY, 151n),
    ]),
  );
}, 240_000);

it('[AC-B2-15m#9] 启动种子失败后不等重启：worker 2026-10-20 启动时队列尚不可用（bill.recon 入队被拒），种子失败不拖垮入口；队列恢复后同一 worker 一小时内（定时器时间）自己重试，为有收款记录的 App 入队账单日 2026-10-19 的 bill.recon（队列 pay、不带渠道、singletonKey 含 App 与账单日）', async () => {
  const r = await recon(s, START);
  await enable(r.f);
  await paidOrder(r, 'alipay', { paidAt: inDay(SEEDED_DAY) });
  const appId = r.f.subject.app_id;
  const gate: Gate = { open: false, refused: [] };

  fakeTimers();
  try {
    const worker = await startGatedWorker(r.f, gate);
    try {
      const tried = await drive(
        () => gate.refused.some((job) => job.payload['app_id'] === appId),
        SEED_WITHIN_MS,
      );
      expect(tried, `the startup seed tried to enqueue a bill.recon of ${appId}`).toBe(true);
      expect(workerReconSends(worker, appId), 'nothing enqueued while refused').toEqual([]);

      gate.open = true;
      const retried = await drive(() => workerDaily(worker, appId).length > 0, HEAL_WITHIN_MS);
      expect(retried, `the failed seed of ${appId} retried by the running worker`).toBe(true);
      const sent = workerDaily(worker, appId);
      for (const job of sent) {
        expect(job.queue).toBe(PAY_QUEUE);
        expect(job.name).toBe(BILL_RECON_JOB);
        expect(job.payload).toMatchObject({ app_id: appId, bill_date: SEEDED_DAY });
        expect(job.options.singletonKey ?? '', 'singletonKey').toContain(appId);
        expect(job.options.singletonKey ?? '', 'singletonKey').toContain(SEEDED_DAY);
      }
    } finally {
      await worker.close();
    }
  } finally {
    vi.useRealTimers();
  }
}, 180_000);
