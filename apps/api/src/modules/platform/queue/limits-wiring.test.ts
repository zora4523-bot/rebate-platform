// B1-01zzk: PlatformModule hands AppConfig.queueLimits to the worker's queue runtime only.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { FixedClock } from '../clock/index.ts';
import { loadConfig } from '../config/index.ts';
import type { DbHandles } from '../db/index.ts';
import { createRootLogger } from '../logging/index.ts';
import { PlatformModule } from '../platform.module.ts';
import type { EntryName } from '../entries.ts';

const created = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock('./index.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./index.ts')>();
  return {
    ...original,
    createQueueRuntime: (options: Parameters<typeof original.createQueueRuntime>[0]) => {
      created.options.push(options);
      return original.createQueueRuntime(options);
    },
  };
});

afterEach(() => {
  created.options.length = 0;
});

async function limitsGiven(entry: EntryName, env: Record<string, string>): Promise<unknown> {
  const executeQuery = vi.fn(() => {
    throw new Error('unexpected database access');
  });
  const handles = {
    db: { executeQuery },
    dbRead: null,
    close: vi.fn(async () => undefined),
  } as unknown as DbHandles;
  const module = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot({
        entry,
        config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent', ...env }),
        clock: new FixedClock('2031-02-03T04:05:06.789Z'),
        logger: createRootLogger({ entry, appEnv: 'test', level: 'silent' }),
        dbHandles: handles,
      }),
    ],
  }).compile();
  await module.close();
  expect(executeQuery).not.toHaveBeenCalled();
  expect(created.options).toHaveLength(1);
  const options = created.options[0] as Record<string, unknown>;
  created.options.length = 0;
  return Object.hasOwn(options, 'limits') ? options.limits : 'absent';
}

it('[B1-01zzk] worker 入口把 config.queueLimits 作为 limits 传给队列运行时；未配置时不传', async () => {
  const env = { QUEUE_CONCURRENCY_NOTIFY: '2', QUEUE_DB_BUDGET: '5' };
  expect(await limitsGiven('worker', env)).toStrictEqual({
    concurrency: { notify: 2 },
    dbBudget: 5,
  });
  expect(await limitsGiven('worker', {})).toBe('absent');
});

it('[B1-01zzk] api / stream / admin / payout 即使配置了 queueLimits 也不传 limits', async () => {
  const env = { QUEUE_CONCURRENCY_PAY: '1', QUEUE_DB_BUDGET: '3' };
  const seen: Record<string, unknown> = {};
  for (const entry of ['api', 'stream', 'admin', 'payout'] as const) {
    seen[entry] = await limitsGiven(entry, env);
  }
  expect(seen).toStrictEqual({
    api: 'absent',
    stream: 'absent',
    admin: 'absent',
    payout: 'absent',
  });
});
