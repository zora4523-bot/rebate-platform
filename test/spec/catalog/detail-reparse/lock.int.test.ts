// B1-05w: 重新解析步骤 3 on a real Redis. One (app_id, product_key) sends one re-parse and concurrent
// requests wait for its result, whatever the result. Two instances over one Redis stand for two
// processes, so an in-process map does not pass. The union holds each answer for a moment, which
// keeps the first request inside its lock while the others arrive.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireTestRedis, type TestRedis } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createRootLogger,
  loadConnectionConfig,
  type RedisNamespace,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createRedisHandle,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { PRODUCT_KEY } from '../detail/kit.ts';
import { rejection } from '../hot-rank/kit.ts';
import {
  CANONICAL_URL,
  NEW_RAW,
  askedRaws,
  found,
  hang,
  onePage,
  reparseFixture,
  unionFake,
  type ReparseSetup,
  type UnionFake,
} from './kit.ts';

const HOLD_MS = 400;
/** A slow union inside the 3 s of 步骤 3: a waiter that gives up early sends its own search. */
const SLOW_MS = 2500;
const TIMEOUT = 60_000;
const OTHER_KEY = 'tb:synthetic002';
const OTHER_RAW = 'synthetic-renewed-synthetic002';
/** BR-PROD-05 重新解析步骤 3. */
const LOCK_TTL_SEC = 10;

let server: TestRedis | undefined;
let handle: RedisHandle | null = null;
let namespace: RedisNamespace;

beforeAll(async () => {
  server = await acquireTestRedis();
  const connection = loadConnectionConfig('api', {
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/rules',
    REDIS_URL: server.url,
  });
  handle = await createRedisHandle(connection, {
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
  namespace = handle!.namespace('catalog-reparse-spec');
}, TIMEOUT);

afterAll(async () => {
  try {
    await handle?.close();
  } finally {
    await server?.stop();
  }
}, TIMEOUT);

/** Two instances of one app, one union and one Redis; each case takes an app of its own. */
function twoInstances(setup: ReparseSetup = {}) {
  const fake = unionFake();
  const shared = {
    appId: `synthetic_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    fake,
    redis: namespace,
    ...setup,
  };
  return { fake, a: reparseFixture(shared), b: reparseFixture(shared) };
}

/** The title search answers only after `ms`. */
function holdSearch(
  fake: UnionFake,
  answer: () => ReturnType<typeof onePage>,
  ms: number = HOLD_MS,
): void {
  fake.searchItems.mockImplementation(async () => {
    await delay(ms);
    return answer();
  });
}

/** Answers once two searches have arrived: a search that waits for the other never does. */
function meetInSearch(fake: UnionFake, answer: () => ReturnType<typeof onePage>): void {
  const both = Promise.withResolvers<void>();
  let arrived = 0;
  fake.searchItems.mockImplementation(async () => {
    arrived += 1;
    if (arrived === 2) both.resolve();
    await both.promise;
    return answer();
  });
}

it(
  '[B1-05w#46][BR-PROD-05] 步骤 3：两个实例并发同一 (app_id, product_key) → 只发一次标题搜索，两边都用同一新原串出正常卡',
  async () => {
    const { fake, a, b } = twoInstances();
    holdSearch(fake, () => onePage());

    const cards = await Promise.all([a.run(), b.run()]);

    expect(cards).toMatchObject([
      { stale: false, final_price_fen: 2990 },
      { stale: false, final_price_fen: 2990 },
    ]);
    expect(fake.searchItems).toHaveBeenCalledTimes(1);
    expect(new Set(askedRaws(fake))).toEqual(new Set([NEW_RAW]));
    expect(a.rows.map((row) => row.ref.rawItemId)).toEqual([NEW_RAW]);
    expect(b.rows.map((row) => row.ref.rawItemId)).toEqual([NEW_RAW]);
  },
  TIMEOUT,
);

it(
  '[B1-05w#47][BR-PROD-05] 步骤 3：同一实例五个并发 → 只发一次',
  async () => {
    const { fake, a } = twoInstances();
    holdSearch(fake, () => onePage());

    await Promise.all([a.run(), a.run(), a.run(), a.run(), a.run()]);

    expect(fake.searchItems).toHaveBeenCalledTimes(1);
    expect(a.rows).toHaveLength(5);
  },
  TIMEOUT,
);

it(
  '[B1-05w#48][BR-PROD-05] 步骤 3：按链接解析也只发一次',
  async () => {
    const { fake, a, b } = twoInstances({ stored: { canonicalUrl: CANONICAL_URL } });
    fake.resolveLink.mockImplementation(async () => {
      await delay(HOLD_MS);
      return { item: { platform: 'taobao', item_id: NEW_RAW } };
    });

    await Promise.all([a.run(), b.run()]);

    expect(fake.resolveLink).toHaveBeenCalledTimes(1);
    expect(fake.searchItems).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[B1-05w#49][BR-PROD-05] 步骤 3：等到的结果是引用失效 → 两边都 30143，只发一次',
  async () => {
    const { fake, a, b } = twoInstances();
    holdSearch(fake, () => onePage([]));

    const failures = await Promise.all([rejection(() => a.run()), rejection(() => b.run())]);

    expect(failures).toMatchObject([{ code: 30143 }, { code: 30143 }]);
    expect(fake.searchItems).toHaveBeenCalledTimes(1);
  },
  TIMEOUT,
);

it(
  '[B1-05w#50][BR-PROD-05] 步骤 3：等到的结果是暂时失败 → 两边都 50401，只发一次；联盟恢复后重试重新搜索，不读留下的失败',
  async () => {
    const { fake, a, b } = twoInstances();
    fake.searchItems.mockImplementation(async () => {
      await delay(HOLD_MS);
      throw new UnionError('upstream_unavailable', 'synthetic outage', 'taobao');
    });

    const failures = await Promise.all([rejection(() => a.run()), rejection(() => b.run())]);

    expect(failures).toMatchObject([{ code: 50401 }, { code: 50401 }]);
    expect(fake.searchItems).toHaveBeenCalledTimes(1);

    fake.searchItems.mockResolvedValue(onePage());

    expect(await a.run()).toMatchObject({ stale: false, final_price_fen: 2990 });
    expect(fake.searchItems).toHaveBeenCalledTimes(2);
  },
  TIMEOUT,
);

it(
  '[B1-05w#70][BR-PROD-05] 步骤 3：联盟答得慢、仍在 3 秒内 → 等的一方不提前放弃，只发一次，两边同一新原串',
  async () => {
    const { fake, a, b } = twoInstances();
    holdSearch(fake, () => onePage(), SLOW_MS);

    const cards = await Promise.all([a.run(), b.run()]);

    expect(cards).toMatchObject([
      { stale: false, final_price_fen: 2990 },
      { stale: false, final_price_fen: 2990 },
    ]);
    expect(fake.searchItems).toHaveBeenCalledTimes(1);
    expect(new Set(askedRaws(fake))).toEqual(new Set([NEW_RAW]));
  },
  TIMEOUT,
);

it(
  '[B1-05w#71][BR-PROD-05] 步骤 3：联盟不返回 → 等的一方等到持锁方 3 秒超时的结果，只发一次，两边都 50401',
  async () => {
    const { fake, a, b } = twoInstances();
    fake.searchItems.mockImplementation(hang);

    const failures = await Promise.all([rejection(() => a.run()), rejection(() => b.run())]);

    expect(failures).toMatchObject([{ code: 50401 }, { code: 50401 }]);
    expect(fake.searchItems).toHaveBeenCalledTimes(1);
  },
  TIMEOUT,
);

it(
  '[B1-05w#51][BR-PROD-05] 步骤 3：等到的结果是下架 → 两边都 30141，只发一次',
  async () => {
    const { fake, a, b } = twoInstances({ stored: { canonicalUrl: CANONICAL_URL } });
    fake.resolveLink.mockImplementation(async () => {
      await delay(HOLD_MS);
      throw new UnionError('item_unavailable', 'synthetic off shelf', 'taobao');
    });

    const failures = await Promise.all([rejection(() => a.run()), rejection(() => b.run())]);

    expect(failures).toMatchObject([{ code: 30141 }, { code: 30141 }]);
    expect(fake.resolveLink).toHaveBeenCalledTimes(1);
  },
  TIMEOUT,
);

it(
  '[B1-05w#52][BR-PROD-05] 步骤 3：锁按键：同 App 两个 key 并发各发一次，互不等待',
  async () => {
    const fake = unionFake();
    const appId = `synthetic_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const answers = [found(), found({ item_id: OTHER_RAW })];
    meetInSearch(fake, () => onePage(answers));
    fake.getItem.mockImplementation(async (ref) => found({ item_id: ref.item_id ?? null }));
    const a = reparseFixture({ appId, fake, redis: namespace });
    const b = reparseFixture({ appId, fake, redis: namespace, productKey: OTHER_KEY });

    const cards = await Promise.all([a.run(), b.run()]);

    expect(cards.map((card) => card.product_key)).toEqual([PRODUCT_KEY, OTHER_KEY]);
    expect(fake.searchItems).toHaveBeenCalledTimes(2);
  },
  TIMEOUT,
);

it(
  '[B1-05w#53][BR-PROD-05] 步骤 3：锁 10 秒：问联盟之前的第一次写入就是取锁，它的 TTL 是 10 秒',
  async () => {
    const ttls: number[] = [];
    let beforeSearch: number[] = [];
    const recording: RedisNamespace = {
      get: (key) => namespace.get(key),
      set: (key, value, ttlSeconds) => {
        ttls.push(ttlSeconds);
        return namespace.set(key, value, ttlSeconds);
      },
      eval: (script, options) => {
        ttls.push(options.ttlSeconds);
        return namespace.eval(script, options);
      },
    };
    const { fake, a } = twoInstances({ redis: recording });
    fake.searchItems.mockImplementation(async () => {
      beforeSearch = [...ttls];
      return onePage();
    });

    await a.run();

    expect(beforeSearch[0]).toBe(LOCK_TTL_SEC);
  },
  TIMEOUT,
);
