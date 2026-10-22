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
    name: 'page-schedule.due',
    payload: { app_id: 'wiring', page_key: 'home' },
    attempt: 2,
  };
  await handle(job);
  expect(
    vi.mocked(createPageScheduleJob).mock.results[0]!.value.handle,
  ).toHaveBeenCalledExactlyOnceWith(job);
});
