// Rule tests of the runtime life cycle against a real PostgreSQL (ADR-0001 §4.2 第 14 项「进程一律
// migrate:false；库版本与 schema 版本不一致时拒绝启动」, 第 11 项 每进程连接池; 规划/02 §3.1 payout
// concurrency=1, §11 各自设置并发; contract sections 2, 5, 6, 7 and 8 of
// apps/api/src/modules/platform/queue/index.ts). Shutdown order: stop fetching → wait for the running
// handlers → (then the entry closes the pools). Top-level it() only (规划/11 §4.3).
import { inspect } from 'node:util';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import {
  createDbHandles,
  loadConnectionConfig,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  createQueueRuntime,
  type ReceivedJob,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { leaksIn, pgUrlOf, phraseOf } from '../db/kit.ts';
import {
  TEST_CATALOG,
  TEST_PLAN,
  describeError,
  gate,
  line,
  memoryLogger,
  observe,
  queueErrorProblems,
  reduceLine,
  rejectionProblems,
  settled,
  sleep,
  waitFor,
} from './kit.ts';
import {
  closeObserver,
  expectedQueueRow,
  observerOn,
  queueRows,
  recorder,
  setupOn,
  stateOf,
  teardown,
  type Setup,
} from './int-kit.ts';

async function withDatabase<T>(run: (database: TestDatabase) => Promise<T>): Promise<T> {
  const database = await createTestDatabase();
  try {
    return await run(database);
  } finally {
    await database.drop();
  }
}

const NAMES = TEST_CATALOG.map((spec) => spec.name);

it('[ADR-0001 §4.2 #14 库版本与 schema 版本不一致时拒绝启动] pgboss.version 是 41、43、空表或多出一行时 start 拒绝 schema_mismatch（固定文案、无 cause），不建队列、不起 worker、不写日志；之后 start 拒绝 already_started；版本恢复 42 后新运行时能启动', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    const setups: Setup[] = [];
    let handled = 0;
    try {
      return await observe(async () => {
        const variants: Record<string, string> = {
          '41': 'UPDATE pgboss.version SET version = 41',
          '43': 'UPDATE pgboss.version SET version = 43',
          empty: 'DELETE FROM pgboss.version',
          'two rows': 'INSERT INTO pgboss.version (version) VALUES (43)',
        };
        const outcome: Record<string, unknown> = {};
        for (const [label, statement] of Object.entries(variants)) {
          await sql`DELETE FROM pgboss.version`.execute(observer);
          await sql`INSERT INTO pgboss.version (version) VALUES (42)`.execute(observer);
          await sql.raw(statement).execute(observer);
          const setup = setupOn(database, 'worker', {
            handlers: {
              't-std': async () => {
                handled += 1;
              },
            },
          });
          setups.push(setup);
          const start = await rejectionProblems(setup.runtime.start(), 'schema_mismatch');
          outcome[label] = {
            start,
            queues: await queueRows(observer, NAMES),
            again: await rejectionProblems(setup.runtime.start(), 'already_started'),
            stop: await settled(setup.runtime.stop()),
            lines: setup.lines,
          };
        }
        await sql`DELETE FROM pgboss.version`.execute(observer);
        await sql`INSERT INTO pgboss.version (version) VALUES (42)`.execute(observer);
        // A job put into the queue table directly must not be picked up by any failed runtime.
        const fixed = setupOn(database, 'api');
        setups.push(fixed);
        outcome.fixed = await settled(fixed.runtime.start());
        await fixed.runtime.send('t-std', 'a', {}, { trx: null });
        await sleep(1500);
        outcome.handled = handled;
        return outcome;
      });
    } finally {
      await teardown(setups);
      await closeObserver(observer);
    }
  });
  const failed = { start: [], queues: [], again: [], stop: 'resolved', lines: [] };
  expect(seen).toEqual({
    '41': failed,
    '43': failed,
    empty: failed,
    'two rows': failed,
    fixed: 'resolved',
    handled: 0,
  });
}, 60_000);

it('[contract §5 队列] start 按目录建队列：每个目录队列一行、设置逐项等于目录（非分区）；已有队列的重试、过期、保留、删除设置被改回目录值；目录外的队列不动', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    const setups: Setup[] = [];
    try {
      return await observe(async () => {
        await sql`SELECT pgboss.create_queue('outside', '{"policy":"standard","retryLimit":7}'::jsonb)`.execute(
          observer,
        );
        const first = setupOn(database, 'api');
        setups.push(first);
        await first.runtime.start();
        const created = await queueRows(observer, NAMES);
        await first.runtime.stop();
        await sql`
          UPDATE pgboss.queue SET retry_limit = 9, retry_delay = 7, retry_backoff = true,
            retry_delay_max = 99, expire_seconds = 5, retention_seconds = 61, deletion_seconds = 62
          WHERE name = 't-std'
        `.execute(observer);
        const second = setupOn(database, 'worker');
        setups.push(second);
        await second.runtime.start();
        const outside = await sql<{ retry_limit: number }>`
          SELECT retry_limit FROM pgboss.queue WHERE name = 'outside'
        `.execute(observer);
        return {
          created,
          restored: await queueRows(observer, NAMES),
          outside: outside.rows,
        };
      });
    } finally {
      await teardown(setups);
      await closeObserver(observer);
    }
  });
  const expected = [...TEST_CATALOG]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map(expectedQueueRow);
  expect(seen).toEqual({ created: expected, restored: expected, outside: [{ retry_limit: 7 }] });
}, 60_000);

it('[contract §5 queue_mismatch] 库里已有队列的策略或死信队列与目录不同：start 拒绝 queue_mismatch，不起 worker（已排队的任务不被取走），设置不被改动', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    const setups: Setup[] = [];
    let handled = 0;
    try {
      return await observe(async () => {
        const first = setupOn(database, 'api');
        setups.push(first);
        await first.runtime.start();
        const id = await first.runtime.send('t-std', 'a', {}, { trx: null });
        await first.runtime.stop();
        const outcome: Record<string, unknown> = {};
        const variants: Array<[string, string, string]> = [
          [
            'policy',
            "UPDATE pgboss.queue SET policy = 'standard' WHERE name = 't-excl'",
            "UPDATE pgboss.queue SET policy = 'exclusive' WHERE name = 't-excl'",
          ],
          [
            'dead letter',
            "UPDATE pgboss.queue SET dead_letter = NULL WHERE name = 't-wide'",
            "UPDATE pgboss.queue SET dead_letter = 'test-dead' WHERE name = 't-wide'",
          ],
        ];
        for (const [label, change, undo] of variants) {
          await sql.raw(change).execute(observer);
          await sql`UPDATE pgboss.queue SET retry_limit = 9 WHERE name = 't-once'`.execute(
            observer,
          );
          const setup = setupOn(database, 'worker', {
            handlers: {
              't-std': async () => {
                handled += 1;
              },
            },
          });
          setups.push(setup);
          outcome[label] = await rejectionProblems(setup.runtime.start(), 'queue_mismatch');
          await sleep(1500);
          const once = await sql<{ retry_limit: number }>`
            SELECT retry_limit FROM pgboss.queue WHERE name = 't-once'
          `.execute(observer);
          outcome[`${label} t-once`] = once.rows;
          outcome[`${label} lines`] = setup.lines;
          await sql.raw(undo).execute(observer);
        }
        outcome.handled = handled;
        outcome.state = await stateOf(observer, 't-std', id ?? '');
        return outcome;
      });
    } finally {
      await teardown(setups);
      await closeObserver(observer);
    }
  });
  expect(seen).toEqual({
    policy: [],
    'policy t-once': [{ retry_limit: 9 }],
    'policy lines': [],
    'dead letter': [],
    'dead letter t-once': [{ retry_limit: 9 }],
    'dead letter lines': [],
    handled: 0,
    state: 'created',
  });
}, 60_000);

it('[contract §6 优雅关闭] stop：先停止取任务（之后入队的任务不被取走，本运行时的 send 拒绝 not_running），再等在跑的处理器结束（期间 db 句柄可用、任务照常 completed）才解决；第二次与并发的 stop 一起解决、不抛；不写日志', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    let sender: Setup | undefined;
    const release = gate();
    const rec = recorder();
    let dbAfterRelease = 'not run';
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', {
          handlers: {
            't-std': (job: ReceivedJob) =>
              rec.track(job.id, job.queue, job.name, job.attempt, async () => {
                await release.wait();
                const w = worker as Setup;
                dbAfterRelease = await sql<{ one: number }>`SELECT 1 AS one`
                  .execute(w.handles.db)
                  .then((result) => String(result.rows[0]?.one), describeError);
              }),
          },
        });
        sender = setupOn(database, 'api');
        const w = worker;
        await w.runtime.start();
        await sender.runtime.start();
        const first = (await sender.runtime.send('t-std', 'a', { n: 1 }, { trx: null })) ?? '';
        const running = await waitFor(() => rec.active() === 1, 10_000);
        let stopped = false;
        const stopping = w.runtime.stop().then((value) => {
          stopped = true;
          return value;
        });
        const concurrent = w.runtime.stop();
        await sleep(800);
        const stoppedEarly = stopped;
        const second = (await sender.runtime.send('t-std', 'a', { n: 2 }, { trx: null })) ?? '';
        const ownSend = await rejectionProblems(
          w.runtime.send('t-std', 'a', { n: 3 }, { trx: null }),
          'not_running',
        );
        await sleep(1500);
        const stillOne = rec.calls.length;
        release.open();
        const values = await Promise.all([stopping, concurrent]);
        const firstState = await stateOf(observer, 't-std', first);
        const again = await settled(w.runtime.stop());
        await sleep(1500);
        return {
          running,
          stoppedEarly,
          ownSend,
          stillOne,
          values,
          dbAfterRelease,
          firstState,
          secondState: await stateOf(observer, 't-std', second),
          calls: rec.calls.length,
          again,
          lines: w.lines,
        };
      });
    } finally {
      release.open();
      await teardown([worker, sender]);
      await closeObserver(observer);
    }
  });
  expect(seen).toEqual({
    running: true,
    stoppedEarly: false,
    ownSend: [],
    stillOne: 1,
    values: [undefined, undefined],
    dbAfterRelease: '1',
    firstState: 'completed',
    secondState: 'created',
    calls: 1,
    again: 'resolved',
    lines: [],
  });
}, 60_000);

it('[contract §6 关闭超时] 处理器超过 stopTimeoutMs 仍在跑：stop 不再等它、在超时后不久解决，正好一条 warn queue_stop_timeout {running: 1}，该任务被判失败进入 retry', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    const release = gate();
    const rec = recorder();
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', {
          stopTimeoutMs: 500,
          handlers: {
            't-std': (job: ReceivedJob) =>
              rec.track(job.id, job.queue, job.name, job.attempt, () => release.wait()),
          },
        });
        const w = worker;
        await w.runtime.start();
        const id = (await w.runtime.send('t-std', 'a', {}, { trx: null })) ?? '';
        const running = await waitFor(() => rec.active() === 1, 10_000);
        const began = performance.now();
        await w.runtime.stop();
        const tookMs = performance.now() - began;
        const state = await stateOf(observer, 't-std', id);
        return {
          running,
          timely: tookMs >= 450 && tookMs < 3000,
          state,
          lines: w.lines.map(reduceLine),
          expectedLines: [line('worker', 'warn', { running: 1 }, 'queue_stop_timeout')],
        };
      });
    } finally {
      release.open();
      await teardown([worker]);
      await closeObserver(observer);
    }
  });
  expect(seen).toMatchObject({ running: true, timely: true, state: 'retry' });
  const record = seen as { lines?: unknown; expectedLines?: unknown };
  expect(record.lines).toStrictEqual(record.expectedLines);
}, 60_000);

it('[规划/02 §3.1 转账队列 concurrency=1; §11 各自设置并发] 生产计划的并发确切：worker 的 notify 同时最多 5 个且确实到 5；payout 入口（couli_payout 身份）的 payout 同时最多 1 个；全部完成', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    const setups: Setup[] = [];
    const release = gate();
    const notify = recorder();
    const payout = recorder();
    try {
      return await observe(async () => {
        // The production catalog and plan: the defaults of createQueueRuntime.
        const make = (entry: 'api' | 'worker' | 'payout', handlers = {}) => {
          const { logger, lines } = memoryLogger(entry);
          const role = entry === 'payout' ? 'couli_payout' : 'couli_app';
          const env: Record<string, string> = { DATABASE_URL: database.urlFor(role) };
          if (entry !== 'payout') env.REDIS_URL = 'redis://127.0.0.1:1/0';
          const handles = createDbHandles(loadConnectionConfig(entry, env), {
            logger: memoryLogger(entry).logger,
          });
          const runtime = createQueueRuntime({ entry, db: handles.db, logger });
          const setup: Setup = { entry, handles, runtime, lines, logger };
          setups.push(setup);
          for (const [queue, handler] of Object.entries(handlers)) {
            runtime.register(queue, handler as never);
          }
          return setup;
        };
        const api = make('api');
        await api.runtime.start();
        const worker = make('worker', {
          notify: (job: ReceivedJob) =>
            notify.track(job.id, job.queue, job.name, job.attempt, () => release.wait()),
        });
        const pay = make('payout', {
          payout: (job: ReceivedJob) =>
            payout.track(job.id, job.queue, job.name, job.attempt, () => release.wait()),
        });
        await worker.runtime.start();
        await pay.runtime.start();
        for (let n = 0; n < 8; n += 1) {
          await api.runtime.send('notify', 'notify.push', { n }, { trx: null });
        }
        for (let n = 0; n < 3; n += 1) {
          await api.runtime.send(
            'payout',
            'payout.execute',
            { n },
            { trx: null, singletonKey: `w${String(n)}:1` },
          );
        }
        const reached = await waitFor(() => notify.active() === 5 && payout.active() === 1, 15_000);
        await sleep(3000);
        const peaks = { notify: notify.peak(), payout: payout.peak() };
        release.open();
        const all = await waitFor(
          () =>
            notify.calls.length === 8 &&
            payout.calls.length === 3 &&
            notify.active() === 0 &&
            payout.active() === 0,
          20_000,
        );
        const states = await sql<{ name: string; state: string; n: bigint }>`
          SELECT name, state::text AS state, count(*) AS n FROM pgboss.job
          WHERE name IN ('notify', 'payout') GROUP BY name, state ORDER BY name, state
        `.execute(observer);
        await sleep(500);
        return {
          reached,
          peaks,
          finalPeaks: { notify: notify.peak(), payout: payout.peak() },
          all,
          states: states.rows.map((row) => [row.name, row.state, Number(row.n)]),
        };
      });
    } finally {
      release.open();
      await teardown(setups);
      await closeObserver(observer);
    }
  });
  expect(seen).toEqual({
    reached: true,
    peaks: { notify: 5, payout: 1 },
    finalPeaks: { notify: 5, payout: 1 },
    all: true,
    states: [
      ['notify', 'completed', 8],
      ['payout', 'completed', 3],
    ],
  });
}, 90_000);

it('[contract §2 并发] 测试计划的并发确切：t-wide 并发 3 时同时最多 3 个处理器调用且确实到 3，等满 3 个轮询间隔仍不超过', async () => {
  const seen = await withDatabase(async (database) => {
    let worker: Setup | undefined;
    let sender: Setup | undefined;
    const release = gate();
    const rec = recorder();
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', {
          handlers: {
            't-wide': (job: ReceivedJob) =>
              rec.track(job.id, job.queue, job.name, job.attempt, () => release.wait()),
          },
        });
        sender = setupOn(database, 'api');
        await sender.runtime.start();
        for (let n = 0; n < 7; n += 1) {
          await sender.runtime.send('t-wide', 'a', { n }, { trx: null });
        }
        await worker.runtime.start();
        const reached = await waitFor(() => rec.active() === 3, 10_000);
        await sleep(1600);
        const peak = rec.peak();
        release.open();
        const all = await waitFor(() => rec.calls.length === 7 && rec.active() === 0, 15_000);
        return { reached, peak, finalPeak: rec.peak(), all };
      });
    } finally {
      release.open();
      await teardown([worker, sender]);
    }
  });
  expect(seen).toEqual({ reached: true, peak: 3, finalPeak: 3, all: true });
}, 60_000);

it('[ADR-0001 §4.2 #11 每进程连接池] 运行时不另开连接池：worker 启动、处理任务、关闭期间，本库里 couli_app 的会话（观察者除外）的 application_name 只有 couli-worker', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    const apps = new Set<string>();
    const rec = recorder();
    try {
      return await observe(async () => {
        const sample = async () => {
          const result = await sql<{ app: string }>`
            SELECT application_name AS app FROM pg_stat_activity
            WHERE datname = current_database() AND usename = 'couli_app' AND pid <> pg_backend_pid()
          `.execute(observer);
          for (const row of result.rows) apps.add(row.app);
        };
        worker = setupOn(database, 'worker', {
          handlers: {
            't-std': (job: ReceivedJob) =>
              rec.track(job.id, job.queue, job.name, job.attempt, async () => {
                await sample();
              }),
          },
        });
        await worker.runtime.start();
        await sample();
        for (let n = 0; n < 3; n += 1) {
          await worker.runtime.send('t-std', 'a', { n }, { trx: null });
        }
        await waitFor(() => rec.calls.length === 3, 10_000);
        await sample();
        await sleep(1000);
        await sample();
        return { calls: rec.calls.length, apps: [...apps].sort() };
      });
    } finally {
      await teardown([worker]);
      await closeObserver(observer);
    }
  });
  expect(seen).toEqual({ calls: 3, apps: ['couli-worker'] });
}, 60_000);

it('[contract §5、§8; 规划/02 §12.6 口令不外泄] 连不上数据库时 start 以驱动错误拒绝：错误的 message、stack、inspect 与 JSON 都不含连接串口令；运行时不写日志；之后 stop 解决、start 拒绝 already_started', async () => {
  const phrase = phraseOf('queue.unreachable');
  const { logger, lines } = memoryLogger('worker');
  const handles = createDbHandles(
    loadConnectionConfig('worker', {
      DATABASE_URL: pgUrlOf('couli_app', phrase),
      REDIS_URL: 'redis://127.0.0.1:1/0',
    }),
    { logger: memoryLogger('worker').logger },
  );
  const seen = await observe(async () => {
    const runtime = createQueueRuntime({
      entry: 'worker',
      db: handles.db,
      logger,
      catalog: TEST_CATALOG,
      plan: TEST_PLAN,
    });
    let failure: unknown = 'resolved';
    await runtime.start().catch((error: unknown) => {
      failure = error;
    });
    const text = [
      failure instanceof Error ? failure.message : String(failure),
      failure instanceof Error ? (failure.stack ?? '') : '',
      inspect(failure, { depth: 6, showHidden: true }),
      JSON.stringify(failure) ?? '',
    ].join('\n');
    return {
      rejected: failure !== 'resolved',
      notQueueError:
        queueErrorProblems(failure, 'schema_mismatch')[0]?.startsWith('not a QueueError') ?? false,
      leaks: leaksIn(text, [phrase]),
      lines,
      stop: await settled(runtime.stop()),
      again: await rejectionProblems(runtime.start(), 'already_started'),
    };
  });
  await handles.close();
  expect(seen).toEqual({
    rejected: true,
    notQueueError: true,
    leaks: [],
    lines: [],
    stop: 'resolved',
    again: [],
  });
}, 30_000);
