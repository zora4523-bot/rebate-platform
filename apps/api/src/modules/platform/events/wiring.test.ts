import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { FixedClock } from '../clock/index.ts';
import { loadConfig } from '../config/index.ts';
import type { DbHandles } from '../db/index.ts';
import * as platform from '../index.ts';
import { createRootLogger } from '../logging/index.ts';
import { EVENT_BUS, JOB_QUEUE, PlatformModule } from '../platform.module.ts';
import type { QueueRuntime } from '../queue/index.ts';
import * as events from './events.ts';
import { EVENT_NAMES, EventError, type EventBus } from './index.ts';

afterEach(() => vi.restoreAllMocks());

it.each(['api', 'stream', 'admin', 'worker', 'payout'] as const)(
  '[AC-B1-01h#1] %s 注入事件总线使用本入口的队列和时钟，初始化无数据库访问',
  async (entry) => {
    const executeQuery = vi.fn(() => {
      throw new Error('unexpected database access');
    });
    const close = vi.fn(async () => undefined);
    const handles = { db: { executeQuery }, dbRead: null, close } as unknown as DbHandles;
    const clock = new FixedClock('2031-02-03T04:05:06.789Z');
    const bus: EventBus = { publish: vi.fn() };
    const factory = vi.spyOn(events, 'createEventBus').mockReturnValue(bus);
    const module = await Test.createTestingModule({
      imports: [
        PlatformModule.forRoot({
          entry,
          config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
          clock,
          logger: createRootLogger({ entry, appEnv: 'test', level: 'silent' }),
          dbHandles: handles,
        }),
      ],
    }).compile();
    try {
      expect(module.get<EventBus>(EVENT_BUS)).toBe(bus);
      expect(factory).toHaveBeenCalledExactlyOnceWith({
        queue: module.get<QueueRuntime>(JOB_QUEUE),
        clock,
      });
      expect(executeQuery).not.toHaveBeenCalled();
    } finally {
      await module.close();
    }
    expect(close).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-01h#2] 无数据库句柄时不提供事件总线；公共出口提供事件契约及注入令牌', async () => {
  const factory = vi.spyOn(events, 'createEventBus');
  const module = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot({
        entry: 'api',
        config: loadConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' }),
        clock: new FixedClock('2031-02-03T04:05:06.789Z'),
        logger: createRootLogger({ entry: 'api', appEnv: 'test', level: 'silent' }),
      }),
    ],
  }).compile();
  try {
    expect(() => module.get(EVENT_BUS)).toThrow();
    expect(() => module.get(JOB_QUEUE)).toThrow();
    expect(factory).not.toHaveBeenCalled();
    expect(platform.EVENT_BUS).toBe(EVENT_BUS);
    expect(platform.EVENT_NAMES).toBe(EVENT_NAMES);
    expect(platform.EventError).toBe(EventError);
    expect(platform.registerEventConsumer).toBe(events.registerEventConsumer);
  } finally {
    await module.close();
  }
});
