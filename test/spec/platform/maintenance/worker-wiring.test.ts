// Unit rule tests of the worker's maintenance wiring (task B1-01n; contract sections 1–3 and 5 of
// apps/api/src/modules/platform/maintenance/worker.ts — section 5 is an addendum to section B of
// ./index.ts written there, the B1-01j header and rule tests are unchanged). Basis: ADR-0001 §4.2
// 第 4 项 (worker 里的定时任务建和删分区; DEFAULT 分区有数据即告警), 第 8 项 (couli_maint); 规划/02
// §15.1 PG 一行. Start order: queue, then maintenance; stop order: maintenance (waiting for the run
// in progress), queue, then the resources. No database, no port: the queue and the maintenance are
// stand-ins that record every call. Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';

import {
  createPartitionMaintenance,
  type PartitionMaintenanceOptions,
} from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import {
  WORKER_QUIET_DEFAULT_TABLES,
  createWorkerMaintenance,
  startWorkerServices,
  type StartStop,
  type WorkerServices,
} from '../../../../apps/api/src/modules/platform/maintenance/worker.ts';
import {
  countingClock,
  describeError,
  gate,
  line,
  memoryLogger,
  reduceLine,
  thrownProblems,
  track,
} from './kit.ts';

type Step = 'resolve' | 'reject' | 'gate';

interface Stand {
  /** Every call in order: `queue.start`, `maintenance.stop`, `close#1`, … */
  readonly calls: string[];
  /** Opens the gate of a gated step. */
  readonly open: (name: string) => void;
  /** The error a rejecting step rejects with (one object per step name). */
  readonly errorOf: (name: string) => Error;
  readonly queue: StartStop;
  readonly maintenance: StartStop | null;
  readonly close: (() => Promise<void>)[];
}

/**
 * Stand-ins whose steps resolve, reject (with an Error named after the step) or wait for `open`.
 * Steps not listed in `steps` resolve. `closeCount` close functions are made.
 */
function stand(
  steps: Readonly<Record<string, Step>>,
  withMaintenance = true,
  closeCount = 2,
): Stand {
  const calls: string[] = [];
  const gates = new Map<string, ReturnType<typeof gate>>();
  const errors = new Map<string, Error>();
  const errorOf = (name: string): Error => {
    let error = errors.get(name);
    if (error === undefined) {
      error = new Error(`stand-in failure of ${name}`);
      errors.set(name, error);
    }
    return error;
  };
  const step = (name: string) => async (): Promise<void> => {
    calls.push(name);
    const how = steps[name] ?? 'resolve';
    if (how === 'reject') throw errorOf(name);
    if (how === 'gate') {
      let g = gates.get(name);
      if (g === undefined) {
        g = gate();
        gates.set(name, g);
      }
      await g.wait();
    }
  };
  for (const name of Object.keys(steps)) {
    if (steps[name] === 'gate' && !gates.has(name)) gates.set(name, gate());
  }
  return {
    calls,
    open: (name) => gates.get(name)?.open(),
    errorOf,
    queue: { start: step('queue.start'), stop: step('queue.stop') },
    maintenance: withMaintenance
      ? { start: step('maintenance.start'), stop: step('maintenance.stop') }
      : null,
    close: Array.from({ length: closeCount }, (_, i) => step(`close#${String(i + 1)}`)),
  };
}

/** Lets pending promise callbacks and 0 ms timers run. */
async function turns(count = 10): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** startWorkerServices with these stand-ins, or a promise rejected with what it threw. */
function begin(s: Stand, logger = memoryLogger().logger): Promise<WorkerServices> {
  try {
    return startWorkerServices({
      queue: s.queue,
      maintenance: s.maintenance,
      close: s.close,
      logger,
    });
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

const DISABLED = line('info', 'partition_maintenance_disabled', {
  variable: 'DATABASE_MAINT_URL',
});

it('[ADR-0001 §4.2 #4; worker 契约 3] 启动顺序确切：先 queue.start，等它完成才 maintenance.start；维护的首轮完成前不算启动完；启动完得到只有 stop 的冻结对象；启动期间不调用任何 stop、close，不写日志', async () => {
  const s = stand({ 'queue.start': 'gate', 'maintenance.start': 'gate' });
  const { logger, lines } = memoryLogger();
  const started = begin(s, logger);
  const state = track(started);
  await turns();
  const whileQueueStarts = { calls: [...s.calls], state: state() };
  s.open('queue.start');
  await turns();
  const whileMaintenanceStarts = { calls: [...s.calls], state: state() };
  s.open('maintenance.start');
  await turns();
  let shape: unknown;
  try {
    const services = await started;
    shape = {
      plain: Object.getPrototypeOf(services) === Object.prototype,
      frozen: Object.isFrozen(services),
      keys: Reflect.ownKeys(services).map(String),
      stop: typeof services.stop,
    };
  } catch (error) {
    shape = describeError(error);
  }
  expect({
    whileQueueStarts,
    whileMaintenanceStarts,
    after: { calls: [...s.calls], state: state() },
    shape,
    lines: lines.length,
  }).toEqual({
    whileQueueStarts: { calls: ['queue.start'], state: 'pending' },
    whileMaintenanceStarts: { calls: ['queue.start', 'maintenance.start'], state: 'pending' },
    after: { calls: ['queue.start', 'maintenance.start'], state: 'resolved' },
    shape: { plain: true, frozen: true, keys: ['stop'], stop: 'function' },
    lines: 0,
  });
});

it('[ADR-0001 §4.2 #4; worker 契约 3; SIGTERM 时先停维护] 停止顺序确切：maintenance.stop（等进行中的一轮）完成前不停队列；queue.stop 完成前不关资源；资源按给定顺序一个一个关；全部完成后 stop() 以 undefined 结束，不写日志', async () => {
  const s = stand({ 'maintenance.stop': 'gate', 'queue.stop': 'gate', 'close#1': 'gate' }, true, 3);
  const { logger, lines } = memoryLogger();
  let seen: unknown;
  try {
    const services = await begin(s, logger);
    const before = s.calls.length;
    const stopping = services.stop();
    const state = track(stopping);
    const at = (): unknown => ({ calls: s.calls.slice(before), state: state() });
    await turns();
    const waitingForMaintenance = at();
    s.open('maintenance.stop');
    await turns();
    const waitingForQueue = at();
    s.open('queue.stop');
    await turns();
    const waitingForFirstClose = at();
    s.open('close#1');
    await turns();
    seen = {
      waitingForMaintenance,
      waitingForQueue,
      waitingForFirstClose,
      done: at(),
      value: await stopping,
      lines: lines.length,
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toEqual({
    waitingForMaintenance: { calls: ['maintenance.stop'], state: 'pending' },
    waitingForQueue: { calls: ['maintenance.stop', 'queue.stop'], state: 'pending' },
    waitingForFirstClose: {
      calls: ['maintenance.stop', 'queue.stop', 'close#1'],
      state: 'pending',
    },
    done: {
      calls: ['maintenance.stop', 'queue.stop', 'close#1', 'close#2', 'close#3'],
      state: 'resolved',
    },
    value: undefined,
    lines: 0,
  });
});

it('[worker 契约 3] stop() 幂等：并发的第二次与事后的第三次返回同一个 promise，每一步只调用一次', async () => {
  const s = stand({ 'maintenance.stop': 'gate' });
  let seen: unknown;
  try {
    const services = await begin(s);
    const first = services.stop();
    const second = services.stop();
    await turns();
    s.open('maintenance.stop');
    await first;
    const third = services.stop();
    await third;
    seen = {
      same: first === second && second === third,
      calls: s.calls,
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toEqual({
    same: true,
    calls: [
      'queue.start',
      'maintenance.start',
      'maintenance.stop',
      'queue.stop',
      'close#1',
      'close#2',
    ],
  });
});

it('[worker 契约 3] 停止时某一步失败不拦后面的步骤：maintenance.stop 与 close#1 都拒绝时，queue.stop、close#2 照样调用，stop() 在最后一步之后以第一个失败的那个错误（同一对象）拒绝', async () => {
  const s = stand({ 'maintenance.stop': 'reject', 'close#1': 'reject' });
  let seen: unknown;
  try {
    const services = await begin(s);
    const before = s.calls.length;
    let rejection: unknown = 'resolved';
    try {
      await services.stop();
    } catch (error) {
      rejection = error;
    }
    seen = {
      calls: s.calls.slice(before),
      sameError: rejection === s.errorOf('maintenance.stop'),
      rejection: describeError(rejection),
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toEqual({
    calls: ['maintenance.stop', 'queue.stop', 'close#1', 'close#2'],
    sameError: true,
    rejection: 'Error: stand-in failure of maintenance.stop',
  });
});

it('[ADR-0001 §4.2 #14 起不来的队列; worker 契约 3] queue.start 失败：不启动维护、不写 partition_maintenance_disabled；按顺序 queue.stop、close#1、close#2 收拾（其中一步失败也继续），再以 queue.start 的那个错误（同一对象）拒绝', async () => {
  const outcomes: unknown[] = [];
  for (const [withMaintenance, cleanupFails] of [
    [true, false],
    [true, true],
    [false, false],
  ] as const) {
    const s = stand(
      cleanupFails
        ? { 'queue.start': 'reject', 'queue.stop': 'reject', 'close#1': 'reject' }
        : { 'queue.start': 'reject' },
      withMaintenance,
    );
    const { logger, lines } = memoryLogger();
    let rejection: unknown = 'resolved';
    try {
      await begin(s, logger);
    } catch (error) {
      rejection = error;
    }
    outcomes.push({
      calls: s.calls,
      sameError: rejection === s.errorOf('queue.start'),
      lines: lines.length,
    });
  }
  const expected = {
    calls: ['queue.start', 'queue.stop', 'close#1', 'close#2'],
    sameError: true,
    lines: 0,
  };
  expect(outcomes).toEqual([expected, expected, expected]);
});

it('[ADR-0001 §4.2 #4、#8 以 couli_maint 执行（wrong_role 起不来）; worker 契约 3] maintenance.start 失败：按顺序 maintenance.stop、queue.stop、close#1、close#2 收拾（其中一步失败也继续），再以 maintenance.start 的那个错误（同一对象）拒绝；不写日志', async () => {
  const outcomes: unknown[] = [];
  for (const cleanupFails of [false, true]) {
    const s = stand(
      cleanupFails
        ? { 'maintenance.start': 'reject', 'maintenance.stop': 'reject', 'queue.stop': 'reject' }
        : { 'maintenance.start': 'reject' },
    );
    const { logger, lines } = memoryLogger();
    let rejection: unknown = 'resolved';
    try {
      await begin(s, logger);
    } catch (error) {
      rejection = error;
    }
    outcomes.push({
      calls: s.calls,
      sameError: rejection === s.errorOf('maintenance.start'),
      lines: lines.length,
    });
  }
  const expected = {
    calls: [
      'queue.start',
      'maintenance.start',
      'maintenance.stop',
      'queue.stop',
      'close#1',
      'close#2',
    ],
    sameError: true,
    lines: 0,
  };
  expect(outcomes).toEqual([expected, expected]);
});

it('[ADR-0001 §4.2 #4; 待编排会话确认 APP_ENV=test 可不设维护连接] 没有维护（null）：queue.start 之后正好一行 info partition_maintenance_disabled（字段只有 variable: DATABASE_MAINT_URL，经根 logger 本身）；stop() 按 queue.stop、close#1 的顺序；没有资源时（空数组）也能启停', async () => {
  const s = stand({ 'queue.start': 'gate' }, false, 1);
  const { logger, lines } = memoryLogger();
  let seen: unknown;
  try {
    const started = begin(s, logger);
    // Observed below; a rejection must fail the assertion, not surface as unhandled.
    started.catch(() => undefined);
    await turns();
    const linesBeforeQueue = lines.length;
    s.open('queue.start');
    const services = await started;
    const afterStart = lines.map(reduceLine);
    await services.stop();
    const empty = stand({}, false, 0);
    const { logger: emptyLogger, lines: emptyLines } = memoryLogger();
    const emptyServices = await begin(empty, emptyLogger);
    await emptyServices.stop();
    seen = {
      linesBeforeQueue,
      afterStart,
      calls: s.calls,
      linesAfterStop: lines.length,
      empty: { calls: empty.calls, lines: emptyLines.map(reduceLine) },
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toEqual({
    linesBeforeQueue: 0,
    afterStart: [DISABLED],
    calls: ['queue.start', 'queue.stop', 'close#1'],
    linesAfterStop: 1,
    empty: { calls: ['queue.start', 'queue.stop'], lines: [DISABLED] },
  });
});

function baseOptions(): Record<string, unknown> {
  return {
    // Never used: creating an instance opens no connection (contract B of ./index.ts).
    db: {},
    logger: memoryLogger().logger,
    clock: countingClock('2026-11-20T03:04:05Z'),
  };
}

it('[ADR-0001 §4.2 #4 DEFAULT 分区有数据即告警; worker 契约 1、2; maintenance 契约 B] WORKER_QUIET_DEFAULT_TABLES 正好是 [link_logs] 且冻结（link_logs 的按日分区维护另立任务）；createWorkerMaintenance：合法选项（含 intervalMs）得到 runOnce / start / stop，创建时不读时钟、不写日志；多出的键（含 quietDefaultTables）、缺键、坏 intervalMs 同步抛 invalid_option', () => {
  const created: string[] = [];
  for (const extra of [{}, { intervalMs: 100 }]) {
    const clock = countingClock('2026-11-20T03:04:05Z');
    const { logger, lines } = memoryLogger();
    try {
      const m = createWorkerMaintenance({
        ...baseOptions(),
        logger,
        clock,
        ...extra,
      } as unknown as PartitionMaintenanceOptions);
      created.push(
        `${typeof m.runOnce} ${typeof m.start} ${typeof m.stop} clock ${String(clock.calls())} lines ${String(lines.length)}`,
      );
    } catch (error) {
      created.push(describeError(error));
    }
  }
  const base = baseOptions();
  const bad: Record<string, Record<string, unknown>> = {
    quiet: { ...base, quietDefaultTables: ['link_logs'] },
    quietEmpty: { ...base, quietDefaultTables: [] },
    unknownKey: { ...base, tables: ['link_logs'] },
    noDb: { logger: base['logger'], clock: base['clock'] },
    intervalTooSmall: { ...base, intervalMs: 99 },
  };
  const refused: Record<string, string[]> = {};
  for (const [label, options] of Object.entries(bad)) {
    refused[label] = thrownProblems(
      () => createWorkerMaintenance(options as unknown as PartitionMaintenanceOptions),
      'invalid_option',
    );
  }
  expect({
    quiet: {
      tables: [...WORKER_QUIET_DEFAULT_TABLES],
      frozen: Object.isFrozen(WORKER_QUIET_DEFAULT_TABLES),
    },
    created,
    refused,
  }).toEqual({
    quiet: { tables: ['link_logs'], frozen: true },
    created: Array(2).fill('function function function clock 0 lines 0'),
    refused: Object.fromEntries(Object.keys(bad).map((label) => [label, []])),
  });
});

it('[ADR-0001 §4.2 #4; maintenance 契约补充（worker 契约 5）] createPartitionMaintenance 的新选项 quietDefaultTables：[]、[link_logs]、三张表、32 个合法名、冻结数组都收；不是数组、元素不是字符串、空串、大写、空格、点号、带 schema、开头是数字或下划线、超过 63 个字符、重复、33 个、类数组对象都同步抛 invalid_option；创建时不碰 db、不读时钟、不写日志', () => {
  const many = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `t${String(i).padStart(2, '0')}`);
  const longest = `a${'b'.repeat(62)}`;
  const valid: Record<string, unknown> = {
    empty: [],
    linkLogs: ['link_logs'],
    three: ['link_logs', 'event_log', 'orders'],
    thirtyTwo: many(32),
    frozen: Object.freeze(['link_logs']),
    longest: [longest],
    digits: ['t1_2'],
  };
  const invalid: Record<string, unknown> = {
    string: 'link_logs',
    nullValue: null,
    setValue: new Set(['link_logs']),
    arrayLike: { 0: 'link_logs', length: 1 },
    number: [1],
    nested: [['link_logs']],
    emptyName: [''],
    upper: ['Link_logs'],
    space: ['link logs'],
    padded: [' link_logs'],
    dot: ['app.link_logs'],
    dash: ['link-logs'],
    digitFirst: ['1link'],
    underscoreFirst: ['_link'],
    tooLong: [`${longest}c`],
    duplicate: ['link_logs', 'link_logs'],
    thirtyThree: many(33),
    holey: Object.assign(new Array<string>(3), { 0: 'link_logs', 2: 'orders' }),
  };
  const outcome = (tables: unknown): string => {
    const clock = countingClock('2026-11-20T03:04:05Z');
    const { logger, lines } = memoryLogger();
    const touched: string[] = [];
    const db = new Proxy(
      {},
      {
        get(_target, key) {
          touched.push(String(key));
          return undefined;
        },
      },
    );
    try {
      const m = createPartitionMaintenance({
        db,
        logger,
        clock,
        quietDefaultTables: tables,
      } as unknown as PartitionMaintenanceOptions);
      return `created ${typeof m.runOnce} clock ${String(clock.calls())} lines ${String(lines.length)} db ${touched.join(',')}`;
    } catch (error) {
      const problems = thrownProblems(() => {
        throw error;
      }, 'invalid_option');
      return problems.length === 0 ? 'invalid_option' : problems.join('; ');
    }
  };
  expect({
    valid: Object.fromEntries(Object.entries(valid).map(([k, v]) => [k, outcome(v)])),
    invalid: Object.fromEntries(Object.entries(invalid).map(([k, v]) => [k, outcome(v)])),
  }).toEqual({
    valid: Object.fromEntries(
      Object.keys(valid).map((k) => [k, 'created function clock 0 lines 0 db ']),
    ),
    invalid: Object.fromEntries(Object.keys(invalid).map((k) => [k, 'invalid_option'])),
  });
});
