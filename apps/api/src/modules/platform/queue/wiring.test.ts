import { afterEach, expect, it, vi } from 'vitest';
import { createHttpApp, createWorkerContext } from '../../../bootstrap.ts';
import { loadConfig } from '../config/index.ts';
import { createDbHandles, loadConnectionConfig } from '../db/index.ts';
import type { EntryName } from '../entries.ts';
import { createRootLogger } from '../logging/index.ts';
import { JOB_QUEUE } from '../platform.module.ts';
import type { QueueRuntime } from './index.ts';

afterEach(() => vi.restoreAllMocks());

function fixture(entry: EntryName) {
  const logger = createRootLogger({ entry, appEnv: 'test', level: 'silent' });
  const handles = createDbHandles(
    loadConnectionConfig(entry, {
      DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/couli',
      DATABASE_READ_URL: 'postgres://couli_readonly@127.0.0.1:1/couli',
      REDIS_URL: 'redis://127.0.0.1:1/0',
    }),
    { logger },
  );
  return {
    config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
    logger,
    dbHandles: { ...handles, close: vi.fn(() => handles.close()) },
  };
}

it('[AC-B1-01g#1] HTTP 停机先关服务，等待队列停止后才关闭数据库', async () => {
  const given = fixture('api');
  const app = await createHttpApp('api', given);
  await app.init();
  const queue = app.get<QueueRuntime>(JOB_QUEUE);
  const events: string[] = [];
  const draining = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const stop = queue.stop.bind(queue);
  vi.spyOn(queue, 'stop').mockImplementation(async () => {
    events.push('queue');
    entered.resolve();
    await draining.promise;
    await stop();
  });
  const adapter = app.getHttpAdapter();
  const close = adapter.close.bind(adapter);
  vi.spyOn(adapter, 'close').mockImplementation(async () => {
    await close();
    events.push('http');
  });
  const closing = app.close();
  try {
    await entered.promise;
    expect(events).toEqual(['http', 'queue']);
    expect(given.dbHandles.close).not.toHaveBeenCalled();
  } finally {
    draining.resolve();
    await closing;
  }
  expect(given.dbHandles.close).toHaveBeenCalledTimes(1);
  await expect(queue.send('notify', 'notify.push', {}, { trx: null })).rejects.toMatchObject({
    code: 'not_running',
  });
});

it.each(['worker', 'payout'] as const)(
  '[AC-B1-01g#2] %s context 注入自身队列，初始化不连库；关闭队列先于关闭连接池',
  async (entry) => {
    const given = fixture(entry);
    const context = await createWorkerContext(entry, given);
    const queue = context.get<QueueRuntime>(JOB_QUEUE);
    const events: string[] = [];
    const stop = queue.stop.bind(queue);
    vi.spyOn(queue, 'stop').mockImplementation(async () => {
      expect(given.dbHandles.close).not.toHaveBeenCalled();
      events.push('queue');
      await stop();
    });
    const own = entry === 'worker' ? 'notify' : 'payout';
    const other = entry === 'worker' ? 'payout' : 'notify';
    try {
      expect(() => queue.register(own, async () => undefined)).not.toThrow();
      expect(() => queue.register(other, async () => undefined)).toThrow(
        expect.objectContaining({ code: 'not_in_entry' }),
      );
    } finally {
      await context.close();
    }
    expect(events).toEqual(['queue']);
    expect(given.dbHandles.close).toHaveBeenCalledTimes(1);
  },
);
