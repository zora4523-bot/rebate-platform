import { NestFactory } from '@nestjs/core';
import { sql } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { createHttpApp, createWorkerContext } from '../../../bootstrap.ts';
import { DB, DB_READ } from '../platform.module.ts';
import { loadConfig } from '../config/index.ts';
import { createRootLogger } from '../logging/index.ts';
import { createDbHandles, loadConnectionConfig } from './index.ts';
import type { EntryName } from '../entries.ts';

function options(entry: EntryName) {
  const logger = createRootLogger({ entry, appEnv: 'test', level: 'silent' });
  return {
    config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
    logger,
    dbHandles: createDbHandles(
      loadConnectionConfig(entry, {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/couli',
        DATABASE_READ_URL: 'postgres://couli_readonly@127.0.0.1:1/couli',
        REDIS_URL: 'redis://127.0.0.1:1/0',
      }),
      { logger },
    ),
  };
}

afterEach(() => vi.restoreAllMocks());

it('[AC-B1-01f#1] admin 注入两个句柄，HTTP adapter 先关闭，再关闭数据库', async () => {
  const given = options('admin');
  const events: string[] = [];
  const original = given.dbHandles;
  given.dbHandles = {
    ...original,
    close: async () => {
      events.push('database');
      await original.close();
    },
  };
  const app = await createHttpApp('admin', given);
  try {
    await app.init();
    expect(app.get(DB)).toBe(original.db);
    expect(app.get(DB_READ)).toBe(original.dbRead);
    const adapter = app.getHttpAdapter();
    const close = adapter.close.bind(adapter);
    vi.spyOn(adapter, 'close').mockImplementation(async () => {
      await close();
      events.push('http');
    });
  } finally {
    await app.close();
  }
  expect(events).toEqual(['http', 'database']);
  await expect(sql`SELECT 1`.execute(original.db)).rejects.toMatchObject({ code: 'closed' });
});

it.each(['worker', 'payout'] as const)(
  '[AC-B1-01f#2] %s context 只提供主库，关闭后不能再取连接',
  async (entry) => {
    const given = options(entry);
    const app = await createWorkerContext(entry, given);
    try {
      expect(app.get(DB)).toBe(given.dbHandles.db);
      expect(() => app.get(DB_READ)).toThrow();
    } finally {
      await app.close();
    }
    await expect(sql`SELECT 1`.execute(given.dbHandles.db)).rejects.toMatchObject({
      code: 'closed',
    });
  },
);

it('[AC-B1-01f#3] HTTP 创建失败后释放已创建的数据库句柄', async () => {
  const given = options('api');
  const failure = new Error('startup failed');
  vi.spyOn(NestFactory, 'create').mockRejectedValue(failure);
  await expect(createHttpApp('api', given)).rejects.toBe(failure);
  await expect(sql`SELECT 1`.execute(given.dbHandles.db)).rejects.toMatchObject({ code: 'closed' });
});

it('[AC-B1-01f#4] worker 创建失败后释放已创建的数据库句柄', async () => {
  const given = options('worker');
  const failure = new Error('startup failed');
  vi.spyOn(NestFactory, 'createApplicationContext').mockRejectedValue(failure);
  await expect(createWorkerContext('worker', given)).rejects.toBe(failure);
  await expect(sql`SELECT 1`.execute(given.dbHandles.db)).rejects.toMatchObject({ code: 'closed' });
});
