// Unit rule tests of platform/maintenance (B1-01j; contract sections B, D, G, H in
// apps/api/src/modules/platform/maintenance/index.ts). No database, no port, no network: every
// object handed in here is a stand-in that would fail loudly if it were used.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MONTH_PARTITIONED_TABLES, MONTHS_AHEAD } from '@couli/db';
import { expect, it } from 'vitest';

import {
  DROPPABLE_TABLES,
  MAINTENANCE_ERROR_MESSAGES,
  MAINTENANCE_INTERVAL_MS,
  MaintenanceError,
  createPartitionMaintenance,
  type MaintenanceErrorCode,
  type PartitionMaintenanceOptions,
} from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import {
  MESSAGES,
  countingClock,
  errorProblems,
  memoryLogger,
  rejectionProblems,
  thrownProblems,
} from './kit.ts';

const MODULE_DIR = fileURLToPath(
  new URL('../../../../apps/api/src/modules/platform/maintenance/', import.meta.url),
);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out.sort();
}

it('[ADR-0001 §4.2 #16; BR-ID-30 ⑫、⑰; contract B、C.4、H] 常量：默认间隔 3 600 000 毫秒，可删表正好是 [event_log]（冻结），错误文案固定；模块源码不读墙钟与环境变量、不用 pg-boss、Nest 或 console', () => {
  expect(MAINTENANCE_INTERVAL_MS).toBe(3_600_000);
  expect([...DROPPABLE_TABLES]).toEqual(['event_log']);
  expect(Object.isFrozen(DROPPABLE_TABLES)).toBe(true);
  expect({ ...MAINTENANCE_ERROR_MESSAGES }).toEqual(MESSAGES);
  const files = sourceFiles(MODULE_DIR);
  expect(files.map((f) => path.basename(f))).toContain('index.ts');
  const offending: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    for (const [label, pattern] of [
      ['Date.now', /\bDate\.now\s*\(/],
      ['new Date()', /\bnew Date\s*\(\s*\)/],
      ['performance.now', /\bperformance\.now\s*\(/],
      ['process.env', /\bprocess\.env\b/],
      ['pg-boss', /['"]pg-boss['"]/],
      ['@nestjs', /['"]@nestjs\//],
      ['console', /\bconsole\./],
      [
        'SQL clock',
        /(?<![.\w])(?:now|clock_timestamp|statement_timestamp|transaction_timestamp)\s*\(\s*\)|\bcurrent_(?:date|timestamp)\b|\blocaltimestamp\b/i,
      ],
    ] as const) {
      if (pattern.test(text)) offending.push(`${path.basename(file)}: ${label}`);
    }
  }
  expect(offending).toEqual([]);
});

it('[ADR-0001 §4.2 #4 按月的表预建未来 3 个月、#5、#16; BR-ID-30 ⑰; contract C.3、C.4] 名单：月分区表含 event_log 与 orders（预建计数由此推导），预建 3 个未来月；可删表每一项都是月分区表、不含 orders', () => {
  expect({
    monthTables: ['event_log', 'orders'].map((table) =>
      (MONTH_PARTITIONED_TABLES as readonly string[]).includes(table),
    ),
    unique: new Set(MONTH_PARTITIONED_TABLES).size === MONTH_PARTITIONED_TABLES.length,
    monthsAhead: MONTHS_AHEAD,
    droppableAreMonthTables: DROPPABLE_TABLES.every((table) =>
      (MONTH_PARTITIONED_TABLES as readonly string[]).includes(table),
    ),
    droppableHasOrders: DROPPABLE_TABLES.includes('orders'),
  }).toEqual({
    monthTables: [true, true],
    unique: true,
    monthsAhead: 3,
    droppableAreMonthTables: true,
    droppableHasOrders: false,
  });
});

it('[contract G] MaintenanceError：每个代码都是固定文案、name 为 MaintenanceError、自有属性正好 code / message / name / stack、没有 cause', () => {
  const codes: MaintenanceErrorCode[] = ['invalid_option', 'wrong_role', 'already_started'];
  const got: Record<string, string[]> = {};
  for (const code of codes) {
    try {
      got[code] = errorProblems(new MaintenanceError(code), code);
    } catch (error) {
      got[code] = [`constructor threw: ${String(error)}`];
    }
  }
  expect(got).toEqual({ invalid_option: [], wrong_role: [], already_started: [] });
});

function validOptions(): PartitionMaintenanceOptions & Record<string, unknown> {
  return {
    // Never used: creating the instance opens no connection (contract B).
    db: {} as PartitionMaintenanceOptions['db'],
    logger: memoryLogger().logger,
    clock: countingClock('2026-11-20T03:04:05Z'),
  };
}

it('[contract B] 选项校验：缺必填键、多出的键、类型不对、intervalMs 越界或不是整数，一律同步抛 invalid_option', () => {
  class Options {
    db = {};
    logger = memoryLogger().logger;
    clock = countingClock('2026-11-20T03:04:05Z');
  }
  const base = validOptions();
  const bad: Record<string, unknown> = {
    null: null,
    undefined: undefined,
    array: [],
    classInstance: new Options(),
    withPrototype: Object.assign(Object.create({ inherited: true }) as object, base),
    noDb: { logger: base.logger, clock: base.clock },
    noLogger: { db: base.db, clock: base.clock },
    noClock: { db: base.db, logger: base.logger },
    dbNull: { ...base, db: null },
    dbString: { ...base, db: 'postgres://couli_maint@127.0.0.1/couli' },
    loggerWithoutWarn: { ...base, logger: { info() {}, error() {} } },
    loggerNull: { ...base, logger: null },
    clockWithoutNow: { ...base, clock: {} },
    clockNowNotFunction: { ...base, clock: { now: new Date('2026-11-20T00:00:00Z') } },
    unknownKey: { ...base, interval: 1000 },
    intervalTooSmall: { ...base, intervalMs: 99 },
    intervalTooLarge: { ...base, intervalMs: 86_400_001 },
    intervalFraction: { ...base, intervalMs: 1000.5 },
    intervalNaN: { ...base, intervalMs: Number.NaN },
    intervalInfinity: { ...base, intervalMs: Number.POSITIVE_INFINITY },
    intervalString: { ...base, intervalMs: '1000' },
    intervalNull: { ...base, intervalMs: null },
    intervalBigInt: { ...base, intervalMs: 1000n },
  };
  const got: Record<string, string[]> = {};
  for (const [label, options] of Object.entries(bad)) {
    got[label] = thrownProblems(
      () => createPartitionMaintenance(options as PartitionMaintenanceOptions),
      'invalid_option',
    );
  }
  expect(got).toEqual(Object.fromEntries(Object.keys(bad).map((label) => [label, []])));
});

it('[contract B] 合法选项（含 intervalMs 100 与 86 400 000 两端）得到 runOnce / start / stop；创建时不读时钟、不写日志、不碰 db', () => {
  const got: string[] = [];
  for (const extra of [{}, { intervalMs: 100 }, { intervalMs: 86_400_000 }]) {
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
    ) as PartitionMaintenanceOptions['db'];
    try {
      const instance = createPartitionMaintenance({ db, logger, clock, ...extra });
      got.push(
        [
          typeof instance.runOnce,
          typeof instance.start,
          typeof instance.stop,
          `clock ${String(clock.calls())}`,
          `lines ${String(lines.length)}`,
          `db ${touched.join(',')}`,
        ].join(' '),
      );
    } catch (error) {
      got.push(`threw ${String(error)}`);
    }
  }
  expect(got).toEqual(Array(3).fill('function function function clock 0 lines 0 db '));
});

it('[contract D] stop() 在 start() 之前调用：立即以 undefined 结束、可重复调用；之后 start() 拒绝 already_started，且不碰 db、不读时钟、不写日志', async () => {
  const clock = countingClock('2026-11-20T03:04:05Z');
  const { logger, lines } = memoryLogger();
  let result: unknown;
  let second: unknown;
  let startProblems: string[] = ['not reached'];
  try {
    const instance = createPartitionMaintenance({
      db: {} as PartitionMaintenanceOptions['db'],
      logger,
      clock,
    });
    result = await instance.stop();
    second = await instance.stop();
    startProblems = await rejectionProblems(instance.start(), 'already_started');
  } catch (error) {
    result = `threw ${String(error)}`;
  }
  expect({ result, second, startProblems, clock: clock.calls(), lines: lines.length }).toEqual({
    result: undefined,
    second: undefined,
    startProblems: [],
    clock: 0,
    lines: 0,
  });
});
