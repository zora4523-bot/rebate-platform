// B1-10b 源码旁单元测试：同一幂等键的重试不重复计失败（Codex 资金评审 r1 S1 ①）。场景：当日失败 8 次，
// 提交不存在的单号，计数脚本在 Redis 已执行（9）但应答丢失 → 50001（幂等层不存结果）；同键同请求体重试只回
// 30201、计数仍是 9。不连库：脚本化驱动只回预设结果；不连 Redis：假实现按计数脚本的约定模拟 eval。
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import type { ContentReader } from '../../content/index.ts';
import {
  FixedClock,
  RedisUnavailableError,
  type RedisHandle,
  type RootLogger,
} from '../../platform/index.ts';
import {
  createOrderClaim,
  listOrderClaims,
  type ClaimRequest,
  type OrderClaimDeps,
} from './order-claims.ts';
import { orderLockKeyText } from '../infra/order-lock.ts';

const subject = { app_id: 'claims_unit', user_id: '019c0000-0000-7000-8000-000000000001' };
const COUNTER = `claim:${subject.app_id}:${subject.user_id}:20280115`;
const input = { platform: 'jd' as const, order_no: 'unit-missing', paid_date: '2028-01-15' };

/** No orders match, no claim of the day yet; statements are only recorded. */
function scriptedDb() {
  const log: string[] = [];
  class ScriptedDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(compiled: { sql: string }): Promise<QueryResult<R>> {
          log.push(compiled.sql);
          if (compiled.sql.includes('count(*)') && compiled.sql.includes('"app"."claims"')) {
            return Promise.resolve({ rows: [{ n: 0 }] as R[] });
          }
          return Promise.resolve({ rows: [] });
        },
        streamQuery() {
          throw new Error('not used');
        },
      });
    }
  }
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, log };
}

/** The counting script's contract: a known mark adds nothing (0), else +1 and the mark is set. */
function fakeRedis(values: Map<string, string>) {
  let loseNextReply = false;
  const handle: RedisHandle = {
    namespace: (name) => ({
      get: async (key) => values.get(`${name}:${key}`) ?? null,
      set: async () => {
        throw new Error('set is not used');
      },
      eval: async (_script, options) => {
        const [counter, mark] = options.keys.map((key) => `${name}:${key}`);
        let reply = 0;
        if (mark === undefined || !values.has(mark)) {
          reply = Number(values.get(counter!) ?? '0') + 1;
          values.set(counter!, String(reply));
          if (mark !== undefined) values.set(mark, '1');
        }
        if (loseNextReply) {
          loseNextReply = false;
          throw new RedisUnavailableError('command_failed');
        }
        return reply;
      },
    }),
    close: async () => undefined,
    onApplicationShutdown: async () => undefined,
  };
  return {
    handle,
    loseNextReply: () => {
      loseNextReply = true;
    },
  };
}

function setup(count: number) {
  const values = new Map<string, string>([[COUNTER, String(count)]]);
  const redis = fakeRedis(values);
  const warn = vi.fn();
  const logger = { info: vi.fn(), warn, error: vi.fn() } as Record<string, unknown>;
  logger['child'] = () => logger;
  const config: ContentReader = {
    appVersion: async () => null,
    minSupportedVersion: async () => null,
    configValue: async () => null,
  };
  const deps: OrderClaimDeps = {
    db: scriptedDb().db,
    redis: redis.handle,
    clock: new FixedClock('2028-01-15T04:00:00.000Z'),
    config,
    logger: logger as unknown as RootLogger,
  };
  const submit = (request?: ClaimRequest, body = input) =>
    createOrderClaim(deps, subject, body, request);
  const bursts = () => warn.mock.calls.filter(([, msg]) => msg === 'claim_fail_burst');
  return { values, redis, submit, bursts };
}

it('[AC-B1-10b#38] 计数已写入而应答丢失（50001），同键同请求重试不再计数；别的键照计', async () => {
  const s = setup(8);
  const key = { idempotencyKey: 'unit-key-0001' };
  s.redis.loseNextReply();
  expect(await s.submit(key)).toEqual({ code: 50001 });
  expect(s.values.get(COUNTER)).toBe('9');
  expect(await s.submit(key)).toEqual({ code: 30201 });
  expect(s.values.get(COUNTER)).toBe('9');
  expect(await s.submit(key)).toEqual({ code: 30201 });
  expect(s.values.get(COUNTER)).toBe('9');
  expect(s.bursts()).toHaveLength(0);
  // The 10th failure is another request: it counts, logs the burst once, then ① refuses.
  expect(await s.submit({ idempotencyKey: 'unit-key-0002' })).toEqual({ code: 30201 });
  expect(s.values.get(COUNTER)).toBe('10');
  expect(s.bursts()).toHaveLength(1);
  expect(await s.submit(key)).toEqual({ code: 30203, data: { reason: 'RISK_BLOCKED' } });
  expect(s.values.get(COUNTER)).toBe('10');
});

it('[AC-B1-10b#38] 同一幂等键换了请求体是另一请求，照计；直接调用（无幂等键）每次都计', async () => {
  const s = setup(0);
  const key = { idempotencyKey: 'unit-key-0001' };
  expect(await s.submit(key)).toEqual({ code: 30201 });
  expect(await s.submit(key, { ...input, order_no: 'unit-other' })).toEqual({ code: 30201 });
  expect(s.values.get(COUNTER)).toBe('2');
  expect(await s.submit()).toEqual({ code: 30201 });
  expect(await s.submit()).toEqual({ code: 30201 });
  expect(s.values.get(COUNTER)).toBe('4');
});

it.each(['2028-02-30T00:00:00.000Z', '2027-02-29T00:00:00.000Z', '2028-01-15T24:00:00.000Z'])(
  '[AC-B1-10b#34] 游标里不存在的时刻%s按20001拒绝（严格解析，不靠Date.parse归一化）',
  async (instant) => {
    const cursor = Buffer.from(
      JSON.stringify([instant, '019c0000-0000-7000-8000-000000000002']),
      'utf8',
    ).toString('base64url');
    // No database: a refused cursor answers before any read (a valid one would be 50001).
    const deps: OrderClaimDeps = {
      clock: new FixedClock('2028-01-15T04:00:00.000Z'),
      config: {
        appVersion: async () => null,
        minSupportedVersion: async () => null,
        configValue: async () => null,
      },
      logger: { child: () => ({}) } as unknown as RootLogger,
    };
    expect(await listOrderClaims(deps, subject, { cursor })).toEqual({
      code: 20001,
      data: { fields: ['cursor'] },
    });
  },
);

/** Parent number P matches; the re-read under the order locks answers `reread` (B1-10k r2). */
function lockingDb(first: readonly object[], reread: readonly object[]) {
  const log: { sql: string; parameters: readonly unknown[] }[] = [];
  let parentReads = 0;
  class LockingDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(compiled: {
          sql: string;
          parameters: readonly unknown[];
        }): Promise<QueryResult<R>> {
          log.push({ sql: compiled.sql, parameters: compiled.parameters });
          if (compiled.sql.includes('count(*)') && compiled.sql.includes('"app"."claims"')) {
            return Promise.resolve({ rows: [{ n: 0 }] as R[] });
          }
          if (compiled.sql.includes('"app"."orders"') && compiled.sql.includes('parent_order_id')) {
            parentReads += 1;
            return Promise.resolve({ rows: (parentReads === 1 ? first : reread) as R[] });
          }
          return Promise.resolve({ rows: [] });
        },
        streamQuery() {
          throw new Error('not used');
        },
      });
    }
  }
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new LockingDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, log };
}

function child(sub_order_id: string, user_id: string | null) {
  return {
    order_id: `order-${sub_order_id}`,
    sub_order_id,
    buy_type: null,
    user_id,
    rebate_status: 'PENDING',
    locked: false,
    attr_at: new Date('2028-01-15T02:00:00.000Z'),
    product_key: null,
    shop_id: null,
    raw_item_id: 'item-1',
  };
}

it('[AC-B1-10k#36] 受理对匹配到的子订单按键升序取订单锁，锁内重读归属再判定；首读后才出现的子订单不纳入', async () => {
  const other = '019c0000-0000-7000-8000-0000000000ff';
  // First read: both children unattributed. Under the locks a review has meanwhile attributed
  // them to another user, and a child S-0 (already the applicant's) has appeared unlocked.
  const { db, log } = lockingDb(
    [child('S-2', null), child('S-1', null)],
    [child('S-0', subject.user_id), child('S-1', other), child('S-2', other)],
  );
  const s = setup(0);
  const deps: OrderClaimDeps = {
    db,
    redis: s.redis.handle,
    clock: new FixedClock('2028-01-15T04:00:00.000Z'),
    config: {
      appVersion: async () => null,
      minSupportedVersion: async () => null,
      configValue: async () => null,
    },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) } as unknown as RootLogger,
  };
  // S-0 left out: the answer is S-1's 30204 (attributed under the lock), not ALREADY_YOURS.
  expect(await createOrderClaim(deps, subject, { ...input, order_no: 'P' })).toEqual({
    code: 30204,
  });
  const locks = log
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => entry.sql.includes('pg_advisory_xact_lock'));
  expect(locks.map((entry) => entry.parameters[0])).toEqual([
    `orders.claim_user:${subject.app_id}:${subject.user_id}`,
    orderLockKeyText('jd', 'S-1'),
    orderLockKeyText('jd', 'S-2'),
  ]);
  const parentReads = log
    .map((entry, index) => ({ ...entry, index }))
    .filter(
      (entry) => entry.sql.includes('"app"."orders"') && entry.sql.includes('parent_order_id'),
    )
    .map((entry) => entry.index);
  expect(parentReads).toHaveLength(2);
  expect(parentReads[0]!).toBeLessThan(locks[1]!.index);
  expect(parentReads[1]!).toBeGreaterThan(locks[2]!.index);
});

it('[AC-B1-10k#37] 单号一个订单也没匹配到时不取订单锁（30201）', async () => {
  const { db, log } = lockingDb([], []);
  const s = setup(0);
  const deps: OrderClaimDeps = {
    db,
    redis: s.redis.handle,
    clock: new FixedClock('2028-01-15T04:00:00.000Z'),
    config: {
      appVersion: async () => null,
      minSupportedVersion: async () => null,
      configValue: async () => null,
    },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) } as unknown as RootLogger,
  };
  expect(await createOrderClaim(deps, subject, input)).toEqual({ code: 30201 });
  expect(log.filter((entry) => entry.sql.includes('pg_advisory_xact_lock'))).toHaveLength(1);
});
