import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runEntry } from '../../../entry.ts';
import { createWorkerContext } from '../../../bootstrap.ts';
import { createWorkerMaintenance } from '../index.ts';

const f = vi.hoisted(() => {
  const calls: string[] = [];
  const step = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
    });
  const db = { db: {}, dbRead: null, close: step('db.close') };
  const maint = { db: {}, close: step('maint.close') };
  const queue = { start: step('queue.start'), stop: step('queue.stop') };
  const maintenance = { start: step('maintenance.start'), stop: step('maintenance.stop') };
  const context = { get: () => queue, close: step('context.close') };
  const logger = { info: vi.fn(), fatal: vi.fn(), error: vi.fn() };
  return { calls, db, maint, queue, maintenance, context, logger };
});

vi.mock('../../../bootstrap.ts', () => ({
  createHttpApp: vi.fn(),
  createWorkerContext: vi.fn(async () => f.context),
}));
vi.mock('../index.ts', async (original) => ({
  ...(await original<typeof import('../index.ts')>()),
  createRootLogger: () => f.logger,
  createDbHandles: vi.fn(() => {
    f.calls.push('db.create');
    return f.db;
  }),
  createMaintDbHandle: vi.fn(() => {
    f.calls.push('maint.create');
    return f.maint;
  }),
  createWorkerMaintenance: vi.fn(() => f.maintenance),
}));

beforeEach(() => {
  vi.clearAllMocks();
  f.calls.length = 0;
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgres://couli_app@127.0.0.1:1/couli');
  vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:1/0');
  vi.stubEnv('DATABASE_MAINT_URL', 'postgres://couli_maint@127.0.0.1:1/couli');
  vi.stubEnv('COULI_EXIT_AFTER_INIT', '0');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
});

it('[AC-B1-01n#1] worker 共用注入时钟，SIGTERM 等维护停止后才关队列和资源', async () => {
  const signal = vi.spyOn(process, 'on').mockReturnValue(process);
  const timer = vi.spyOn(globalThis, 'setInterval');
  try {
    await runEntry('worker');
    const overrides = vi.mocked(createWorkerContext).mock.calls[0]?.[1];
    expect(vi.mocked(createWorkerMaintenance).mock.calls[0]?.[0]).toEqual({
      db: f.maint.db,
      logger: f.logger,
      clock: overrides?.clock,
    });
    expect(overrides?.clock).toBeDefined();
    expect(f.calls).toEqual(['db.create', 'maint.create', 'queue.start', 'maintenance.start']);
    const gate = Promise.withResolvers<void>();
    f.maintenance.stop.mockImplementationOnce(async () => {
      f.calls.push('maintenance.stop');
      await gate.promise;
    });
    const onSignal = signal.mock.calls.find(([name]) => name === 'SIGTERM')?.[1];
    expect(onSignal).toBeTypeOf('function');
    onSignal?.('SIGTERM');
    expect(f.queue.stop).not.toHaveBeenCalled();
    gate.resolve();
    await vi.waitFor(() => expect(f.logger.info).toHaveBeenCalledWith('stopped'));
    expect(f.calls.slice(4)).toEqual([
      'maintenance.stop',
      'queue.stop',
      'context.close',
      'maint.close',
    ]);
  } finally {
    for (const result of timer.mock.results) {
      if (result.type === 'return') clearInterval(result.value as ReturnType<typeof setInterval>);
    }
  }
});

it('[AC-B1-01n#2] 初始化即退出时关闭两种资源，不启动队列和维护', async () => {
  vi.stubEnv('COULI_EXIT_AFTER_INIT', '1');
  await runEntry('worker');
  expect(f.calls).toEqual(['db.create', 'maint.create', 'context.close', 'maint.close']);
  expect(createWorkerMaintenance).not.toHaveBeenCalled();
  expect(f.logger.info).toHaveBeenCalledWith({ listening: false }, 'started');
});

it('[AC-B1-01n#3] Nest context 创建失败时关闭两个数据库句柄', async () => {
  const failure = new Error('context failure');
  vi.mocked(createWorkerContext).mockRejectedValueOnce(failure);
  await runEntry('worker');
  expect(f.calls).toEqual(['db.create', 'maint.create', 'db.close', 'maint.close']);
  expect(f.logger.fatal).toHaveBeenCalledWith({ err: failure }, 'startup_failed');
  expect(process.exitCode).toBe(1);
});

it('[AC-B1-01n#4] 配置错误合并输出，校验不通过不创建资源', async () => {
  vi.stubEnv('APP_ENV', '');
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('DATABASE_MAINT_URL', '');
  await runEntry('worker');
  expect(f.calls).toEqual([]);
  expect(f.logger.fatal).toHaveBeenCalledTimes(1);
  expect(f.logger.fatal.mock.calls[0]?.[0]).toMatchObject({
    problems: expect.arrayContaining([
      'DATABASE_URL: must be set for the worker entry',
      'DATABASE_MAINT_URL: must be set for the worker entry',
    ]),
  });
  expect(process.exitCode).toBe(1);
});
