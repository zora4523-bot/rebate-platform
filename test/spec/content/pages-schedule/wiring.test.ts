import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { ContentWorkerModule } from '../../../../apps/api/src/modules/content/content-worker.module.ts';
import {
  CLOCK,
  DB,
  JOB_QUEUE,
  ROOT_LOGGER,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createPageScheduleJob } from '../../../../apps/api/src/modules/content/jobs/page-schedule.ts';

vi.mock('../../../../apps/api/src/modules/content/jobs/page-schedule.ts', () => ({
  createPageScheduleJob: vi.fn(() => ({ handle: vi.fn().mockResolvedValue(undefined) })),
}));

it('[AC-F1-09p#29] ContentWorkerModule 为 page-schedule 注册一次处理器并转交完整 job', async () => {
  const module = ContentWorkerModule.forWorker();
  expect(module.module).toBe(ContentWorkerModule);
  const providers = module.providers ?? [];
  const factories = providers.filter(
    (
      p,
    ): p is {
      provide: symbol;
      inject: (symbol | { token: symbol; optional: boolean })[];
      useFactory: (...args: unknown[]) => unknown;
    } => typeof p === 'object' && p !== null && 'useFactory' in p && 'inject' in p,
  );
  const factory = factories.find((p) =>
    p.inject.some((i) => (typeof i === 'object' ? i.token : i) === JOB_QUEUE),
  );
  expect(factory, '必须经 JOB_QUEUE 注册 worker 消费者').toBeDefined();
  const clock = new FixedClock('2026-10-22T00:00:00Z');
  const db = {};
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const register = vi.fn();
  const queue = { send: vi.fn(), register };
  const dependencies = new Map<symbol, unknown>([
    [CLOCK, clock],
    [DB, db],
    [ROOT_LOGGER, logger],
    [JOB_QUEUE, queue],
  ]);
  factory!.useFactory(
    ...factory!.inject.map((i) => dependencies.get(typeof i === 'object' ? i.token : i)),
  );
  expect(createPageScheduleJob).toHaveBeenCalledExactlyOnceWith({ db, clock, queue, logger });
  expect(register).toHaveBeenCalledExactlyOnceWith('page-schedule', expect.any(Function));
  const handle = register.mock.calls[0]![1] as (job: object) => Promise<void>;
  const job = {
    id: 'job-id',
    queue: 'page-schedule',
    name: 'content.page_schedule_due',
    payload: { app_id: 'wiring', page_key: 'home' },
    attempt: 2,
  };
  await handle(job);
  expect(
    vi.mocked(createPageScheduleJob).mock.results[0]!.value.handle,
  ).toHaveBeenCalledExactlyOnceWith(job);
});

it('[AC-F1-09p#33] app.module 仅在 worker 入口装配 ContentWorkerModule', () => {
  const source = readFileSync(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url),
    'utf8',
  );
  const file = ts.createSourceFile('app.module.ts', source, ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(file) === 'ContentWorkerModule' &&
      node.expression.name.text === 'forWorker'
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(calls, '必须且只能装配一次 ContentWorkerModule.forWorker()').toHaveLength(1);
  for (const call of calls) {
    // 与 RiskScanModule 同样的 worker 条件展开；不导入或运行 AppModule。
    const branch = call.parent;
    expect(ts.isArrayLiteralExpression(branch)).toBe(true);
    const conditional = branch.parent;
    expect(ts.isConditionalExpression(conditional)).toBe(true);
    if (!ts.isConditionalExpression(conditional)) continue;
    expect(conditional.whenTrue).toBe(branch);
    expect(conditional.condition.getText(file)).toMatch(/^options\.entry\s*===\s*['"]worker['"]$/);
    expect(conditional.whenFalse.getText(file)).toMatch(/^\[\s*\]$/);
    let spread = conditional.parent;
    while (ts.isParenthesizedExpression(spread)) spread = spread.parent;
    expect(ts.isSpreadElement(spread)).toBe(true);
    const imports = spread.parent;
    expect(ts.isArrayLiteralExpression(imports)).toBe(true);
    expect(ts.isPropertyAssignment(imports.parent)).toBe(true);
    if (ts.isPropertyAssignment(imports.parent)) {
      expect(imports.parent.name.getText(file)).toBe('imports');
    }
  }
});
