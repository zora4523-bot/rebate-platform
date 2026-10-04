// Contract addendum (code review round 1 of B1-01n) to section 3 of
// apps/api/src/modules/platform/maintenance/worker.ts — the wait for the maintenance run in
// progress is bounded. That header is not edited; this file is the addendum. Found by the code
// review: a maintenance query hanging on an unresponsive connection keeps maintenance.stop()
// pending (it awaits the run in progress; lock_timeout bounds only lock waits), so on SIGTERM
// queue.stop() and the pools' close() were never called and the pools' close timeout never
// started. Basis: ADR-0001 §4.2 第 4 项 (worker 里的定时任务), 第 11 项 (连接池); the close bound of
// the db contract (apps/api/src/modules/platform/db/index.ts section 4: closeTimeoutMs, default
// 5 000 ms, integer 1..60 000).
//
// 1. New optional key of `parts`: `maintenanceStopTimeoutMs` — an integer from 1 to 60 000;
//    default 5 000 (the default of the db handles' closeTimeoutMs; 待编排会话确认). Anything else
//    (0, negative, above 60 000, a fraction, NaN, ±Infinity, a string, null, a bigint) →
//    startWorkerServices rejects with MaintenanceError('invalid_option') (./index.ts section G)
//    before calling anything and without logging. The entry (section 4) uses the default.
// 2. Every await of maintenance.stop() — in services.stop() and in the cleanup after a failed
//    start — waits at most `maintenanceStopTimeoutMs`, counted from the call:
//    - maintenance.stop() settles in time: unchanged (its rejection is the first error as before;
//      no extra line; the timer is cleared, nothing keeps the process alive).
//    - not settled in time: logs exactly one line through `parts.logger` itself, level warn,
//      message `partition_maintenance_stop_timeout`, fields exactly { waitedMs: <the bound> };
//      then goes on with queue.stop() and each function of `close` in order, exactly as before
//      (closing the maintenance handle ends the hanging connection, db contract section 6). The
//      timeout is not an error: services.stop() resolves with undefined when the remaining steps
//      resolve (otherwise rejects with the first of their errors), and the cleanup after a failed
//      start still rejects with the start error. A later settlement of that maintenance.stop()
//      promise (resolve or reject) changes nothing and is never an unhandled rejection.
// Unit tests: no database, no port; stand-ins with controllable pending promises.
// Top-level it() only (规划/11 §4.3).
import { afterEach, expect, it, vi } from 'vitest';

import {
  startWorkerServices,
  type WorkerServices,
  type WorkerServicesParts,
} from '../../../../apps/api/src/modules/platform/maintenance/worker.ts';
import { describeError, line, memoryLogger, reduceLine, rejectionProblems } from './kit.ts';

afterEach(() => {
  vi.useRealTimers();
});

type Step = 'resolve' | 'reject' | 'hang';

interface Stand {
  readonly calls: string[];
  readonly errorOf: (name: string) => Error;
  /** Settles a hanging step: resolve, or reject with its error. */
  readonly settle: (name: string, how: 'resolve' | 'reject') => void;
  readonly parts: (extra?: Record<string, unknown>) => WorkerServicesParts;
  readonly lines: string[];
}

/** Stand-ins for queue, maintenance and two resources; steps not listed resolve. */
function stand(steps: Readonly<Record<string, Step>>): Stand {
  const calls: string[] = [];
  const errors = new Map<string, Error>();
  const hanging = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  const errorOf = (name: string): Error => {
    let error = errors.get(name);
    if (error === undefined) {
      error = new Error(`stand-in failure of ${name}`);
      errors.set(name, error);
    }
    return error;
  };
  const step = (name: string) => (): Promise<void> => {
    calls.push(name);
    const how = steps[name] ?? 'resolve';
    if (how === 'reject') return Promise.reject(errorOf(name));
    if (how === 'hang') {
      return new Promise<void>((resolve, reject) => {
        hanging.set(name, { resolve, reject });
      });
    }
    return Promise.resolve();
  };
  const { logger, lines } = memoryLogger();
  return {
    calls,
    errorOf,
    lines,
    settle: (name, how) => {
      const h = hanging.get(name);
      if (how === 'resolve') h?.resolve();
      else h?.reject(errorOf(name));
    },
    parts: (extra = {}) =>
      ({
        queue: { start: step('queue.start'), stop: step('queue.stop') },
        maintenance: { start: step('maintenance.start'), stop: step('maintenance.stop') },
        close: [step('close#1'), step('close#2')],
        logger,
        ...extra,
      }) as unknown as WorkerServicesParts,
  };
}

function begin(parts: WorkerServicesParts): Promise<WorkerServices> {
  try {
    return startWorkerServices(parts);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Lets promise callbacks run without moving any timer. */
async function microtasks(count = 20): Promise<void> {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
}

const STOP_TIMEOUT = (waitedMs: number): Record<string, unknown> =>
  line('warn', 'partition_maintenance_stop_timeout', { waitedMs });
const STARTED = ['queue.start', 'maintenance.start'];
const AFTER = ['queue.stop', 'close#1', 'close#2'];

it('[ADR-0001 §4.2 #4、#11; 代码评审第 1 轮补充 2] 默认上限 5000 毫秒：维护的一轮挂住时 stop() 等到 4999 毫秒仍只调用了 maintenance.stop、不写日志；到 5000 毫秒记确切一行 warn partition_maintenance_stop_timeout（waitedMs 5000），随后按顺序 queue.stop、close#1、close#2，stop() 以 undefined 结束；之后那一轮再拒绝也不改变结果、不成为未处理的拒绝', async () => {
  vi.useFakeTimers();
  const s = stand({ 'maintenance.stop': 'hang' });
  let seen: unknown;
  try {
    const services = await begin(s.parts());
    const stopping = services.stop();
    let outcome = 'pending';
    stopping.then(
      (value) => {
        outcome = `resolved ${String(value)}`;
      },
      (error: unknown) => {
        outcome = describeError(error);
      },
    );
    await vi.advanceTimersByTimeAsync(4999);
    const before = { calls: [...s.calls], lines: s.lines.length, outcome };
    await vi.advanceTimersByTimeAsync(1);
    await microtasks();
    const after = { calls: [...s.calls], lines: s.lines.map(reduceLine), outcome };
    s.settle('maintenance.stop', 'reject');
    await microtasks();
    seen = { before, after, finalOutcome: outcome, timers: vi.getTimerCount() };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toEqual({
    before: { calls: [...STARTED, 'maintenance.stop'], lines: 0, outcome: 'pending' },
    after: {
      calls: [...STARTED, 'maintenance.stop', ...AFTER],
      lines: [STOP_TIMEOUT(5000)],
      outcome: 'resolved undefined',
    },
    finalOutcome: 'resolved undefined',
    timers: 0,
  });
});

it('[ADR-0001 §4.2 #11; 代码评审第 1 轮补充 1、2] maintenanceStopTimeoutMs 给 200：挂住时第 200 毫秒记 waitedMs 200 的那一行并继续收尾；后面步骤的失败照旧以第一个错误拒绝（超时本身不算错误）', async () => {
  vi.useFakeTimers();
  const s = stand({ 'maintenance.stop': 'hang', 'close#1': 'reject' });
  let seen: unknown;
  try {
    const services = await begin(s.parts({ maintenanceStopTimeoutMs: 200 }));
    const stopping = services.stop();
    let rejection: unknown = 'pending';
    stopping.then(
      () => {
        rejection = 'resolved';
      },
      (error: unknown) => {
        rejection = error;
      },
    );
    await vi.advanceTimersByTimeAsync(199);
    const before = [...s.calls];
    await vi.advanceTimersByTimeAsync(1);
    await microtasks();
    seen = {
      before,
      calls: s.calls,
      lines: s.lines.map(reduceLine),
      sameError: rejection === s.errorOf('close#1'),
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toEqual({
    before: [...STARTED, 'maintenance.stop'],
    calls: [...STARTED, 'maintenance.stop', ...AFTER],
    lines: [STOP_TIMEOUT(200)],
    sameError: true,
  });
});

it('[ADR-0001 §4.2 #4; 代码评审第 1 轮补充 2] 启动失败后的收尾同样有上限：maintenance.start 拒绝、maintenance.stop 挂住时，200 毫秒后记那一行，按顺序 queue.stop、close#1、close#2，再以 maintenance.start 的错误（同一对象）拒绝', async () => {
  vi.useFakeTimers();
  const s = stand({ 'maintenance.start': 'reject', 'maintenance.stop': 'hang' });
  let seen: unknown;
  try {
    let rejection: unknown = 'pending';
    begin(s.parts({ maintenanceStopTimeoutMs: 200 })).then(
      () => {
        rejection = 'resolved';
      },
      (error: unknown) => {
        rejection = error;
      },
    );
    await vi.advanceTimersByTimeAsync(199);
    const before = { calls: [...s.calls], settled: rejection !== 'pending' };
    await vi.advanceTimersByTimeAsync(1);
    await microtasks();
    seen = {
      before,
      calls: s.calls,
      lines: s.lines.map(reduceLine),
      sameError: rejection === s.errorOf('maintenance.start'),
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toEqual({
    before: { calls: [...STARTED, 'maintenance.stop'], settled: false },
    calls: [...STARTED, 'maintenance.stop', ...AFTER],
    lines: [STOP_TIMEOUT(200)],
    sameError: true,
  });
});

it('[ADR-0001 §4.2 #11; 教训 RESUME §8; 代码评审第 1 轮补充 1] maintenanceStopTimeoutMs 只收 1 到 60000 的整数：0、-1、60001、1.5、NaN、±Infinity、字符串、null、bigint 都让 startWorkerServices 以 MaintenanceError invalid_option 拒绝，什么都不调用、不写日志；1 与 60000 照常启动', async () => {
  const invalid: unknown[] = [0, -1, 60001, 1.5, NaN, Infinity, -Infinity, '100', null, 100n];
  const refused: unknown[] = [];
  for (const value of invalid) {
    const s = stand({});
    refused.push({
      problems: await rejectionProblems(
        begin(s.parts({ maintenanceStopTimeoutMs: value })),
        'invalid_option',
      ),
      calls: s.calls,
      lines: s.lines.length,
    });
  }
  const accepted: unknown[] = [];
  for (const value of [1, 60000]) {
    const s = stand({});
    try {
      const services = await begin(s.parts({ maintenanceStopTimeoutMs: value }));
      await services.stop();
      accepted.push(s.calls);
    } catch (error) {
      accepted.push(describeError(error));
    }
  }
  expect({ refused, accepted }).toEqual({
    refused: invalid.map(() => ({ problems: [], calls: [], lines: 0 })),
    accepted: [
      [...STARTED, 'maintenance.stop', ...AFTER],
      [...STARTED, 'maintenance.stop', ...AFTER],
    ],
  });
});

it('[代码评审第 1 轮补充 2（反例，现状即满足）] 维护在上限内停下：没有 partition_maintenance_stop_timeout 行、顺序不变、计时器已清掉；在上限内拒绝时照旧以它的错误（第一个错误）拒绝', async () => {
  vi.useFakeTimers();
  let seen: unknown;
  try {
    const inTime = stand({ 'maintenance.stop': 'hang' });
    const services = await begin(inTime.parts({ maintenanceStopTimeoutMs: 200 }));
    const stopping = services.stop();
    await vi.advanceTimersByTimeAsync(150);
    const waiting = [...inTime.calls];
    inTime.settle('maintenance.stop', 'resolve');
    await vi.advanceTimersByTimeAsync(0);
    await microtasks();
    const value = await stopping;
    const timers = vi.getTimerCount();

    const fails = stand({ 'maintenance.stop': 'reject' });
    const failing = await begin(fails.parts());
    let sameError = false;
    try {
      await failing.stop();
    } catch (error) {
      sameError = error === fails.errorOf('maintenance.stop');
    }
    seen = {
      waiting,
      calls: inTime.calls,
      value,
      timers,
      lines: [...inTime.lines, ...fails.lines].length,
      failsCalls: fails.calls,
      sameError,
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toEqual({
    waiting: [...STARTED, 'maintenance.stop'],
    calls: [...STARTED, 'maintenance.stop', ...AFTER],
    value: undefined,
    timers: 0,
    lines: 0,
    failsCalls: [...STARTED, 'maintenance.stop', ...AFTER],
    sameError: true,
  });
});
