import { createDb, destroyDb } from '@couli/db';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { sql, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { api, envelope, fixture, NOW, openKit, phone, type Kit } from './kit.ts';

// B1-11g 第七轮：这是待实现迁移的测试约定，不在测试里创建表或替业务写 attempt。
// 实现迁移提供 app.sms_send_attempts，至少有以下列；所有发码均经真实 AppModule。
const ATTEMPT_TABLE = 'app.sms_send_attempts';
const ATTEMPT_NAME = 'sms_send_attempts';
const SEND_TIMEOUT_MS = 10_000;
const EXTENDED_WINDOW_MS = 3_610_000;
const START = new Date(NOW).getTime();
type Attempt = {
  app_id: string;
  attempt_id: string;
  ip_hmac: string;
  phone_hmac: string;
  created_at: Date;
  status: 'pending' | 'accepted' | 'failed' | 'unknown';
};
type SenderModule = typeof import('../../../../apps/api/src/modules/identity/infra/fake-sms.ts');
type RiskModule = typeof import('../../../../apps/api/src/modules/risk/application/sms-risk.ts');
type RedisModule = typeof import('../../../../apps/api/src/modules/platform/redis/index.ts');
type Message = Parameters<ReturnType<SenderModule['createSmsSender']>['send']>[0];
type Delivery = Awaited<ReturnType<ReturnType<SenderModule['createSmsSender']>['send']>>;
type Entry = 'landing' | 'app';
type Mode =
  | 'normal'
  | 'slow'
  | 'result-write-fails'
  | 'redis-down'
  | 'before-insert'
  | 'after-insert'
  | 'after-provider'
  | 'rejected'
  | 'unknown';

let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let redis: Awaited<ReturnType<typeof acquireTestRedis>> | undefined;
let db: ReturnType<typeof createDb>;
let kit: Kit;
const restores: (() => void)[] = [];
const calls: Message[] = [];
let mode: Mode = 'normal';
let targetPhone = '';
let failInsert = false;
let insertFailures = 0;
let failResult = false;
let resultFailures = 0;
let redisDown = false;
let reached = Promise.withResolvers<void>();
let resume = Promise.withResolvers<void>();

async function rows(appId: string): Promise<Attempt[]> {
  return (
    await sql<Attempt>`select app_id, attempt_id, ip_hmac, phone_hmac, created_at, status
      from ${sql.table(ATTEMPT_TABLE)} where app_id = ${appId}
      order by created_at, attempt_id`.execute(db)
  ).rows;
}

// Query-boundary faults, not mocks of a future repository method. All unaffected queries go
// to real PG. A failed result write leaves the already-committed pending attempt untouched.
const faultPlugin: KyselyPlugin = {
  transformQuery({ node }) {
    const isAttempt = JSON.stringify(node).includes(ATTEMPT_NAME);
    if (isAttempt && node.kind === 'InsertQueryNode' && failInsert) {
      insertFailures++;
      throw Object.assign(new Error('simulated process loss before attempt insert'), {
        code: '08006',
      });
    }
    if (isAttempt && node.kind === 'UpdateQueryNode' && failResult) {
      resultFailures++;
      throw Object.assign(new Error('simulated result persistence unavailable'), { code: '08006' });
    }
    return node;
  },
  async transformResult({ result }) {
    return result;
  },
};

beforeAll(async () => {
  redis = await acquireTestRedis();
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  const identity = await api<SenderModule>('modules/identity/index.ts');
  const risk = await api<RiskModule>('modules/risk/index.ts');
  const { RedisUnavailableError } = await api<RedisModule>('modules/platform/redis/index.ts');
  const realSender = identity.createSmsSender;
  const senderFactory = vi.spyOn(identity, 'createSmsSender').mockImplementation((env, logger) => {
    const sender = realSender(env, logger);
    return {
      ...sender,
      async send(message): Promise<Delivery> {
        // Before crossing the provider boundary the committed row must be visible on another
        // connection. The provider-call log counts rejected/unknown calls as well as successes.
        const persisted = await rows(message.app_id);
        // Do not compare a completed SELECT snapshot with another request's later call log:
        // under concurrency that mixes two instants. The complete counts are checked below.
        expect(persisted.length).toBeGreaterThan(0);
        expect(persisted.some((row) => row.status === 'pending')).toBe(true);
        if (message.phone === targetPhone && mode === 'after-insert') {
          reached.resolve();
          await resume.promise;
          // Cleanup only: do not manufacture a provider call for the stopped process.
          return 'rejected';
        }
        calls.push(message);
        if (message.phone === targetPhone) {
          if (mode === 'after-provider') {
            reached.resolve();
            await resume.promise;
            return 'unknown';
          }
          if (mode === 'slow') kit.clock.advanceMs(9_999);
          if (mode === 'rejected') return 'rejected';
          if (mode === 'unknown') return 'unknown';
        }
        return sender.send(message);
      },
    };
  });
  restores.push(() => senderFactory.mockRestore());
  const realRisk = risk.createSmsRisk;
  const riskFactory = vi.spyOn(risk, 'createSmsRisk').mockImplementation((options) => {
    const handle = options.redis;
    return realRisk({
      ...options,
      redis:
        handle === null
          ? null
          : {
              ...handle,
              namespace(name) {
                const ns = handle.namespace(name);
                return {
                  async get(key) {
                    if (redisDown) throw new RedisUnavailableError('command_failed');
                    return ns.get(key);
                  },
                  async set(key, value, ttl) {
                    if (redisDown) throw new RedisUnavailableError('command_failed');
                    return ns.set(key, value, ttl);
                  },
                  async eval(script, options) {
                    // Device admission remains under its own fail-closed rule. This fault
                    // affects IP counting/cache commands, not signature, code or device stores.
                    if (
                      redisDown &&
                      options.keys.some(
                        (key) =>
                          !key.startsWith('dev:') &&
                          !key.startsWith('req:') &&
                          !key.startsWith('budget:'),
                      )
                    )
                      throw new RedisUnavailableError('command_failed');
                    return ns.eval(script, options);
                  },
                };
              },
            },
    });
  });
  restores.push(() => riskFactory.mockRestore());
  kit = await openKit(db.withPlugin(faultPlugin), database.urlFor('couli_app'), redis.url);
}, 180_000);

afterAll(async () => {
  resume.resolve();
  try {
    await kit?.close();
  } finally {
    for (const restore of restores.reverse()) restore();
    try {
      if (db !== undefined) await destroyDb(db);
      await database?.drop();
    } finally {
      await redis?.stop();
    }
  }
}, 120_000);

async function start(limit = 3) {
  mode = 'normal';
  failInsert = false;
  failResult = false;
  redisDown = false;
  insertFailures = 0;
  resultFailures = 0;
  reached = Promise.withResolvers<void>();
  resume = Promise.withResolvers<void>();
  targetPhone = phone();
  // Missing migration must fail as an assertion, never as relation-not-found or TypeError.
  const relation = await sql<{ present: boolean }>`select to_regclass(${ATTEMPT_TABLE}) is not null
    as present`.execute(db);
  expect(relation.rows[0]?.present, 'PG authoritative SMS attempt migration').toBe(true);
  const sms = await api<
    typeof import('../../../../apps/api/src/modules/identity/application/sms-codes.ts')
  >('modules/identity/application/sms-codes.ts');
  expect(sms.SMS_SEND_TIMEOUT_MS).toBe(SEND_TIMEOUT_MS);
  const f = fixture(kit);
  await f.config('sms.ip_sends_per_hour', limit);
  await f.config('sms.device_distinct_phones_per_hour', 100);
  const appSend = await f.appSender();
  return {
    ...f,
    request: (entry: Entry, number = phone()) =>
      entry === 'landing' ? f.send(number) : appSend(number),
    providerCalls: () => calls.filter((call) => call.app_id === f.appId).length,
  };
}
type Case = Awaited<ReturnType<typeof start>>;

async function counts(f: Case, expectedCalls: number, expectedRows: number, limit = 3) {
  const attempts = await rows(f.appId);
  expect(f.providerCalls()).toBe(expectedCalls);
  expect(attempts).toHaveLength(expectedRows);
  expect(f.providerCalls()).toBeLessThanOrEqual(attempts.length);
  expect(attempts.length).toBeLessThanOrEqual(limit);
  expect(new Set(attempts.map((row) => row.attempt_id)).size).toBe(expectedRows);
  expect(new Set(attempts.map((row) => row.ip_hmac)).size).toBe(expectedRows === 0 ? 0 : 1);
  for (const row of attempts) {
    expect(row.app_id).toBe(f.appId);
    expect(row.attempt_id).toEqual(expect.any(String));
    expect(row.attempt_id.length).toBeGreaterThan(0);
    expect(row.ip_hmac).toMatch(/^[a-f0-9]{32,128}$/);
    expect(row.phone_hmac).toMatch(/^[a-f0-9]{32,128}$/);
    expect(row.created_at.getTime()).toBeGreaterThanOrEqual(START);
    expect(row.created_at.getTime()).toBeLessThanOrEqual(kit.clock.now().getTime());
  }
  return attempts;
}

const scenarios = [
  { mode: 'normal', label: '正常', calls: 1, rows: 1, finalCalls: 3, allowed: 2, wait: 3611 },
  {
    mode: 'slow',
    label: '接近超时才接受',
    calls: 1,
    rows: 1,
    finalCalls: 3,
    allowed: 2,
    wait: 3601,
  },
  {
    mode: 'result-write-fails',
    label: '记录结果双失败',
    calls: 1,
    rows: 1,
    finalCalls: 3,
    allowed: 2,
    wait: 3611,
  },
  {
    mode: 'redis-down',
    label: 'IP Redis 不可用',
    calls: 1,
    rows: 1,
    finalCalls: 3,
    allowed: 2,
    wait: 3611,
  },
  {
    mode: 'before-insert',
    label: '写行前进程丢失',
    calls: 0,
    rows: 0,
    finalCalls: 3,
    allowed: 3,
    wait: 3611,
  },
  {
    mode: 'after-insert',
    label: '写行后停进程',
    calls: 0,
    rows: 1,
    finalCalls: 2,
    allowed: 2,
    wait: 3550,
  },
  {
    mode: 'after-provider',
    label: '调用供应商后停进程',
    calls: 1,
    rows: 1,
    finalCalls: 3,
    allowed: 2,
    wait: 3550,
  },
] as const;
const entryPairs = [
  ['landing', 'landing'],
  ['landing', 'app'],
  ['app', 'landing'],
  ['app', 'app'],
] as const;

// Exhaustive 7 × 2 × 2 table. The three subsequent requests race on the same authoritative
// counter. Expectations above are literals, not recomputed using the implementation's formula.
for (const [index, scenario] of scenarios.entries()) {
  for (const [pairIndex, [first, next]] of entryPairs.entries()) {
    it(`[AC-B1-11g#${28 + index * 4 + pairIndex}] ${scenario.label}，${first} 后续 ${next}：调用数 ≤ PG 行数 ≤ 3`, async () => {
      const f = await start();
      mode = scenario.mode;
      failInsert = mode === 'before-insert';
      failResult = mode === 'result-write-fails';
      redisDown = mode === 'redis-down';
      const stopped = mode === 'after-insert' || mode === 'after-provider';
      const initial = f.request(first, targetPhone);
      try {
        if (stopped) {
          // Stop at an observable I/O boundary; do not throw a catchable exception which would
          // run release/finally and misrepresent a crash. The suffix stays suspended until all
          // later requests and durable-state assertions finish. No real process is killed.
          const state = await Promise.race([
            reached.promise.then(() => 'stopped'),
            initial.then(() => 'returned'),
          ]);
          expect(state).toBe('stopped');
          kit.clock.advanceMs(60_001); // beyond every obsolete 60-second in-flight lease
        } else {
          const response = await initial;
          if (scenario.mode === 'before-insert') {
            expect(response.statusCode).toBeGreaterThanOrEqual(400);
            expect(insertFailures).toBeGreaterThanOrEqual(1);
          } else envelope(kit, response);
        }
        const initialRows = await counts(f, scenario.calls, scenario.rows);
        if (scenario.rows === 1) expect(initialRows[0]!.created_at.getTime()).toBe(START);
        if (stopped || scenario.mode === 'result-write-fails') {
          expect(initialRows.map((row) => row.status)).toEqual(['pending']);
        } else if (scenario.rows === 1) {
          expect(initialRows.map((row) => row.status)).toEqual(['accepted']);
        }
        if (scenario.mode === 'result-write-fails') expect(resultFailures).toBe(2);
        failInsert = false;
        failResult = false;
        const subsequent = await Promise.all([f.request(next), f.request(next), f.request(next)]);
        expect(subsequent.filter((r) => r.statusCode === 200)).toHaveLength(scenario.allowed);
        expect(subsequent.filter((r) => r.statusCode === 429)).toHaveLength(3 - scenario.allowed);
        for (const response of subsequent) {
          if (response.statusCode === 200) envelope(kit, response);
          else envelope(kit, response, 42901, scenario.wait);
        }
        await counts(f, scenario.finalCalls, 3);
        envelope(kit, await f.request(next), 42901, scenario.wait);
        await counts(f, scenario.finalCalls, 3);
      } finally {
        failInsert = false;
        failResult = false;
        redisDown = false;
        resume.resolve();
        await initial;
      }
    });
  }
}

for (const [index, outcome] of ['rejected', 'unknown'].entries()) {
  it(`[AC-B1-11g#${56 + index}] ${outcome} 不退 IP attempt，后续新请求也占额度`, async () => {
    const f = await start(2);
    mode = outcome as 'rejected' | 'unknown';
    envelope(kit, await f.request('landing', targetPhone), outcome === 'rejected' ? 50001 : 0);
    expect((await rows(f.appId)).map((row) => row.status)).toEqual([
      outcome === 'rejected' ? 'failed' : 'unknown',
    ]);
    await counts(f, 1, 1, 2);
    envelope(kit, await f.request('app'));
    envelope(kit, await f.request('landing'), 42901, 3611);
    await counts(f, 2, 2, 2);
  });
}

it('[AC-B1-11g#58] 已有 N−1 行时两个入口并发仅放行一个；N 行不新增 attempt', async () => {
  const f = await start();
  envelope(kit, await f.request('app'));
  envelope(kit, await f.request('landing'));
  const responses = await Promise.all([
    f.request('landing'),
    f.request('app'),
    f.request('landing'),
    f.request('app'),
  ]);
  expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
  expect(responses.filter((r) => r.statusCode === 429)).toHaveLength(3);
  for (const response of responses)
    envelope(
      kit,
      response,
      response.statusCode === 200 ? 0 : 42901,
      response.statusCode === 200 ? undefined : 3611,
    );
  await counts(f, 3, 3);
});

for (const [index, boundary] of [
  { advance: 3_609_999, code: 42901, calls: 1, rows: 1, inWindow: 1 },
  { advance: 3_610_000, code: 42901, calls: 1, rows: 1, inWindow: 1 },
  { advance: 3_610_001, code: 0, calls: 2, rows: 2, inWindow: 1 },
].entries()) {
  it(`[AC-B1-11g#${59 + index}] 扩展窗口毫秒边界，首行年龄 ${boundary.advance}ms`, async () => {
    const f = await start(1);
    envelope(kit, await f.request('landing'));
    kit.clock.advanceMs(boundary.advance);
    const response = await f.request('app');
    envelope(kit, response, boundary.code, boundary.code === 42901 ? 1 : undefined);
    const attempts = await rows(f.appId);
    expect(f.providerCalls()).toBe(boundary.calls);
    expect(attempts).toHaveLength(boundary.rows); // expired rows are retained, never deleted
    expect(attempts[0]!.created_at.getTime()).toBe(START);
    const lower = kit.clock.now().getTime() - EXTENDED_WINDOW_MS;
    expect(attempts.filter((row) => row.created_at.getTime() >= lower)).toHaveLength(
      boundary.inWindow,
    );
  });
}

it('[AC-B1-11g#62] 慢接受按 created_at 计次，Retry-After 取最早行滑出时间', async () => {
  const f = await start(2);
  mode = 'slow';
  envelope(kit, await f.request('landing', targetPhone));
  kit.clock.set(new Date(START + 100_000));
  envelope(kit, await f.request('app'));
  envelope(kit, await f.request('landing'), 42901, 3511);
  kit.clock.set(new Date(START + 3_610_000));
  envelope(kit, await f.request('app'), 42901, 1);
  kit.clock.advanceMs(1);
  envelope(kit, await f.request('landing'));
  expect(f.providerCalls()).toBe(3);
  const attempts = await rows(f.appId);
  expect(attempts.map((row) => row.created_at.getTime())).toEqual([
    START,
    START + 100_000,
    START + 3_610_001,
  ]);
});

it('[AC-B1-11g#63] 同手机号新请求独立计次，手机号 42901 的 failed 行也不退 IP 额度', async () => {
  const f = await start(2);
  envelope(kit, await f.request('landing', targetPhone));
  envelope(kit, await f.request('app', targetPhone), 42901, 60);
  const attempts = await counts(f, 1, 2, 2);
  expect(attempts.map((row) => row.status).sort()).toEqual(['accepted', 'failed']);
  expect(new Set(attempts.map((row) => row.phone_hmac)).size).toBe(1);
  envelope(kit, await f.request('landing'), 42901, 3611);
  await counts(f, 1, 2, 2);
});

it('[AC-B1-11g#64] 结果双写失败与 IP Redis 故障叠加，过旧租约后仍按 PG pending 计次', async () => {
  const f = await start(2);
  failResult = true;
  redisDown = true;
  try {
    envelope(kit, await f.request('landing'));
    expect(resultFailures).toBe(2);
    expect((await rows(f.appId)).map((row) => row.status)).toEqual(['pending']);
    failResult = false;
    kit.clock.advanceMs(60_001);
    envelope(kit, await f.request('app'));
    envelope(kit, await f.request('landing'), 42901, 3550);
    await counts(f, 2, 2, 2);
  } finally {
    failResult = false;
    redisDown = false;
  }
});

it('[AC-B1-11g#65] 相同 IP 在不同 app 有独立的 PG attempt 上限', async () => {
  const first = await start(1);
  envelope(kit, await first.request('landing'));
  envelope(kit, await first.request('app'), 42901, 3611);
  const second = await start(1);
  envelope(kit, await second.request('app'));
  envelope(kit, await second.request('landing'), 42901, 3611);
  await counts(first, 1, 1, 1);
  await counts(second, 1, 1, 1);
});
