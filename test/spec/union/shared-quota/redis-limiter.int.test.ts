// B1-22v (编排裁定 D10-446 ①): the union quota bucket shared through a real Redis. Every
// "process" is its own Redis handle (its own connection) with its own FixedClock; they share a
// bucket only through Redis. Only the orchestrator runs this file (one-shot TEST_REDIS_URL or
// Testcontainers); keys stay under a unique namespace per test and are deleted afterwards.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { acquireTestRedis, type TestRedis } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  FixedClock,
  createMemoryQuotaLimiter,
  createRedisQuotaLimiter,
  quotaShares,
  type QuotaConfig,
  type QuotaPurpose,
  type RedisQuotaLimiter,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createRedisHandle,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { connection, memoryLogger } from '../../platform/redis/kit.ts';
import { T0, config, drain, unavailableWarnings } from './kit.ts';

interface RawRedis {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  disconnect(): void;
}

// The API's installed driver, as the platform Redis integration tests use it.
const requireApi = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const { Redis } = requireApi('ioredis') as {
  Redis: new (url: string, options: object) => RawRedis;
};

let server: TestRedis | undefined;
beforeAll(async () => {
  server = await acquireTestRedis();
}, 180_000);
afterAll(async () => {
  await server?.stop();
}, 30_000);

interface Session {
  /** One more process: a new handle (own connection) and a limiter over the shared namespace. */
  instance(clock: FixedClock, overrides?: Partial<QuotaConfig>): Promise<RedisQuotaLimiter>;
  /** A new handle of its own, for tests that close it. */
  handle(): Promise<RedisHandle>;
  /** Every key under the test's namespace (full SCAN). */
  keys(): Promise<string[]>;
  readonly name: string;
  readonly raw: RawRedis;
}

async function scanNamespace(raw: RawRedis, name: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const page = (await raw.call('SCAN', cursor, 'MATCH', `${name}:*`, 'COUNT', 100)) as [
      string,
      string[],
    ];
    cursor = page[0];
    keys.push(...page[1]);
  } while (cursor !== '0');
  return keys;
}

async function withRedis(run: (session: Session) => Promise<void>): Promise<void> {
  expect(server).toBeDefined();
  const url = server!.url;
  const name = `b122v_${randomUUID().replaceAll('-', '')}`;
  const raw = new Redis(url, { maxRetriesPerRequest: 0, retryStrategy: () => null });
  const { logger } = memoryLogger();
  const handles: RedisHandle[] = [];
  const handle = async (): Promise<RedisHandle> => {
    const opened = await createRedisHandle(connection('api', url), { logger });
    expect(opened).not.toBeNull();
    handles.push(opened!);
    return opened!;
  };
  try {
    await run({
      instance: async (clock, overrides = {}) =>
        createRedisQuotaLimiter(config(overrides), {
          redis: (await handle()).namespace(name),
          clock,
          logger,
        }),
      handle,
      keys: () => scanNamespace(raw, name),
      name,
      raw,
    });
  } finally {
    try {
      for (const opened of handles) await opened.close();
    } finally {
      try {
        // Delete only this test's namespace; never flush a shared Redis service.
        const keys = await scanNamespace(raw, name);
        if (keys.length > 0) await raw.call('DEL', ...keys);
      } finally {
        raw.disconnect();
      }
    }
  }
}

function advance(ms: number, ...clocks: FixedClock[]): void {
  for (const clock of clocks) clock.advanceMs(ms);
}

it('[D10-446] 两个独立实例（各自连接，模拟两个进程）共用一桶：订单同步合计 30、在线合计 70（含借商品池刷新 10），提醒 0', async () => {
  await withRedis(async ({ instance }) => {
    const clockA = new FixedClock(T0);
    const clockB = new FixedClock(T0);
    const a = await instance(clockA);
    const b = await instance(clockB);
    const aSync = await drain(a, 'order_sync', 20);
    const bSync = await drain(b, 'order_sync');
    const aSyncAfter = await a.tryAcquire('order_sync');
    const aOnline = await drain(a, 'online', 40);
    const bOnline = await drain(b, 'online');
    const aPool = await a.tryAcquire('pool_refresh');
    const watch = [await a.tryAcquire('watch'), await b.tryAcquire('watch')];
    expect({ aSync, bSync, aSyncAfter, aOnline, bOnline, aPool, watch }).toEqual({
      aSync: 20,
      bSync: 10,
      aSyncAfter: false,
      aOnline: 40,
      bOnline: 30,
      aPool: false,
      watch: [false, false],
    });
  });
});

it('[D10-446][规划/02 §6.2] 份额按用途隔离且向下取整：P1 容量 100 为 60/30/5/5，MVP 容量 15 为 9/4/1/0；只有在线借商品池刷新', async () => {
  await withRedis(async ({ instance }) => {
    const clock = new FixedClock(T0);
    const p1 = { bucketKey: 'union:pdd:synthetic-p1', shares: quotaShares('p1') };
    const a = await instance(clock, p1);
    const b = await instance(clock, p1);
    const p1Drained = {
      watch: await drain(a, 'watch'),
      pool_refresh: await drain(b, 'pool_refresh'),
      order_sync: await drain(a, 'order_sync'),
      online: await drain(b, 'online'),
    };
    const p1After = {
      order_sync: await b.tryAcquire('order_sync'),
      watch: await b.tryAcquire('watch'),
      online: await a.tryAcquire('online'),
    };
    const small = { bucketKey: 'union:jd:synthetic-small', capacity: 15 };
    const c = await instance(clock, small);
    const d = await instance(clock, small);
    const smallDrained = {
      order_sync: await drain(c, 'order_sync'),
      pool_refresh: await drain(d, 'pool_refresh'),
      watch: await drain(c, 'watch'),
      online: await drain(d, 'online'),
    };
    expect({ p1Drained, p1After, smallDrained }).toEqual({
      p1Drained: { watch: 5, pool_refresh: 5, order_sync: 30, online: 60 },
      p1After: { order_sync: false, watch: false, online: false },
      smallDrained: { order_sync: 4, pool_refresh: 1, watch: 0, online: 9 },
    });
  });
});

it('[D10-446][规划/02 §6.2] 按速率连续回填且不超过容量：订单同步每秒 3 个，333 ms 不足 1 个、再 1 ms 补齐，停一小时也只有 30 个', async () => {
  await withRedis(async ({ instance }) => {
    const clockA = new FixedClock(T0);
    const clockB = new FixedClock(T0);
    const a = await instance(clockA);
    const b = await instance(clockB);
    const initial = await drain(a, 'order_sync');
    advance(1000, clockA, clockB);
    const afterOneSecond = await drain(b, 'order_sync');
    advance(333, clockA, clockB);
    const afterAThirdOfASecond = await drain(a, 'order_sync');
    advance(1, clockA, clockB);
    const oneMillisecondLater = await drain(b, 'order_sync');
    advance(3_600_000, clockA, clockB);
    const afterAnHour = await drain(a, 'order_sync');
    expect({
      initial,
      afterOneSecond,
      afterAThirdOfASecond,
      oneMillisecondLater,
      afterAnHour,
    }).toEqual({
      initial: 30,
      afterOneSecond: 3,
      afterAThirdOfASecond: 0,
      oneMillisecondLater: 1,
      afterAnHour: 30,
    });
  });
});

it('[D10-446] 小数速率按整数令牌精确累计：0.3 个/秒、每 100 ms 轮询 10 秒，恰在 3.4 s、6.7 s、10.0 s 各得 1 个', async () => {
  await withRedis(async ({ instance }) => {
    const clockA = new FixedClock(T0);
    const clockB = new FixedClock(T0);
    const fractional = {
      bucketKey: 'union:taobao:synthetic-fractional',
      capacity: 10,
      refillPerSecond: 0.3,
      shares: { online: 0, order_sync: 100, pool_refresh: 0, watch: 0 },
    };
    const a = await instance(clockA, fractional);
    const b = await instance(clockB, fractional);
    const initial = await drain(a, 'order_sync');
    const granted: number[] = [];
    for (let step = 1; step <= 100; step += 1) {
      advance(100, clockA, clockB);
      if (await (step % 2 === 0 ? a : b).tryAcquire('order_sync')) granted.push(step * 100);
    }
    expect({ initial, granted }).toEqual({ initial: 10, granted: [3400, 6700, 10000] });
  });
});

it('[D10-446] 与内存版同语义：同一串（时间推进、用途、实例）调用下，共享桶的每次答复都与内存版相同', async () => {
  await withRedis(async ({ instance }) => {
    const parity = { bucketKey: 'union:jd:synthetic-parity' };
    const clockA = new FixedClock(T0);
    const clockB = new FixedClock(T0);
    const a = await instance(clockA, parity);
    const b = await instance(clockB, parity);
    let now = 0;
    const memory = createMemoryQuotaLimiter(config(parity), {
      now: () => now,
      sleep: async () => undefined,
    });
    const advances = [0, 0, 1, 7, 33, 100, 0, 333, 1, 999, 0, 0, 2_500, 17, 0, 0, 60_000];
    const order: QuotaPurpose[] = [
      'online',
      'online',
      'order_sync',
      'pool_refresh',
      'online',
      'watch',
      'order_sync',
      'online',
      'pool_refresh',
      'online',
      'online',
    ];
    const shared: boolean[] = [];
    const local: boolean[] = [];
    for (let step = 0; step < 400; step += 1) {
      const ms = advances[step % advances.length] ?? 0;
      const purpose = order[(step * 7 + Math.floor(step / 11)) % order.length] ?? 'online';
      now += ms;
      advance(ms, clockA, clockB);
      shared.push(await (step % 2 === 0 ? a : b).tryAcquire(purpose));
      local.push(await memory.tryAcquire(purpose));
    }
    expect({
      sameAnswers: shared,
      grantedSome: local.includes(true),
      refusedSome: local.includes(false),
    }).toEqual({ sameAnswers: local, grantedSome: true, refusedSome: true });
  });
});

it('[D10-446] 多进程并发不超发：三个实例同时发 120 次订单同步、150 次在线，只批出 30 与 70', async () => {
  await withRedis(async ({ instance }) => {
    const clock = new FixedClock(T0);
    const instances = [await instance(clock), await instance(clock), await instance(clock)];
    const pick = (index: number): RedisQuotaLimiter => instances[index % instances.length]!;
    const sync = await Promise.all(
      Array.from({ length: 120 }, (_, index) => pick(index).tryAcquire('order_sync')),
    );
    const live = await Promise.all(
      Array.from({ length: 150 }, (_, index) => pick(index).tryAcquire('online')),
    );
    const pool = await pick(1).tryAcquire('pool_refresh');
    expect({
      sync: sync.filter((granted) => granted).length,
      online: live.filter((granted) => granted).length,
      pool,
    }).toEqual({ sync: 30, online: 70, pool: false });
  });
});

it('[D10-446] 进程时钟落后不会倒拨桶的时间：慢 5 秒的实例拿不到令牌，也不让别的实例多拿', async () => {
  await withRedis(async ({ instance }) => {
    const ahead = new FixedClock(T0);
    const behind = new FixedClock(T0);
    behind.advanceMs(-5000);
    const a = await instance(ahead);
    const b = await instance(behind);
    const drained = await drain(a, 'order_sync');
    const behindRefused = await b.tryAcquire('order_sync');
    advance(1000, ahead, behind);
    const aheadAfterOneSecond = await drain(a, 'order_sync');
    const behindAfterOneSecond = await drain(b, 'order_sync');
    expect({ drained, behindRefused, aheadAfterOneSecond, behindAfterOneSecond }).toEqual({
      drained: 30,
      behindRefused: false,
      aheadAfterOneSecond: 3,
      behindAfterOneSecond: 0,
    });
  });
});

it('[D10-446] 桶键按 app × 平台隔离；写入的键都在命名空间下且带过期时间', async () => {
  await withRedis(async ({ instance, keys, raw }) => {
    const clock = new FixedClock(T0);
    const taobao = await instance(clock, { bucketKey: 'union:taobao:synthetic-app-a' });
    const jd = await instance(clock, { bucketKey: 'union:jd:synthetic-app-a' });
    const otherApp = await instance(clock, { bucketKey: 'union:taobao:synthetic-app-b' });
    const drained = {
      taobao: await drain(taobao, 'order_sync'),
      jd: await drain(jd, 'order_sync'),
      otherApp: await drain(otherApp, 'order_sync'),
    };
    const written = await keys();
    const ttls = await Promise.all(written.map((key) => raw.call('PTTL', key)));
    expect({
      drained,
      written: written.length > 0,
      allExpire: ttls.every((ttl) => typeof ttl === 'number' && ttl > 0),
    }).toEqual({
      drained: { taobao: 30, jd: 30, otherApp: 30 },
      written: true,
      allExpire: true,
    });
  });
});

it('[R-04] 真实驱动连不上 Redis：tryAcquire 一律答 false，不放行、不回落进程内桶；日志不带地址与口令', async () => {
  const secret = 'synthetic-quota-password';
  const { logger, lines } = memoryLogger();
  const handle = await createRedisHandle(connection('api', `redis://:${secret}@127.0.0.1:1/0`), {
    logger,
    connectTimeoutMs: 500,
    commandTimeoutMs: 500,
  });
  expect(handle).not.toBeNull();
  try {
    const limiter = createRedisQuotaLimiter(config(), {
      redis: handle!.namespace('b122v_unreachable'),
      clock: new FixedClock(T0),
      logger,
    });
    const answers: boolean[] = [];
    for (let call = 0; call < 3; call += 1) answers.push(await limiter.tryAcquire('online'));
    const text = lines.join('\n');
    expect({
      answers,
      warned: unavailableWarnings(lines).length > 0,
      secret: text.includes(secret),
      url: text.includes('redis://'),
    }).toEqual({ answers: [false, false, false], warned: true, secret: false, url: false });
  } finally {
    await handle?.close();
  }
});

it('[R-04] 进程的 Redis 句柄已关闭：该进程答 false 并记 warn，别的进程照常从同一桶取', async () => {
  await withRedis(async ({ handle, name, instance }) => {
    const clock = new FixedClock(T0);
    const closing = await handle();
    const { logger, lines } = memoryLogger();
    const local = createRedisQuotaLimiter(config(), {
      redis: closing.namespace(name),
      clock,
      logger,
    });
    const other = await instance(clock);
    const firstLocal = await local.tryAcquire('order_sync');
    await closing.close();
    const afterClose = await local.tryAcquire('order_sync');
    const otherAfter = await drain(other, 'order_sync');
    expect({
      firstLocal,
      afterClose,
      reasons: unavailableWarnings(lines).map((line) => line['reason']),
      otherAfter,
    }).toEqual({ firstLocal: true, afterClose: false, reasons: ['closed'], otherAfter: 29 });
  });
});
