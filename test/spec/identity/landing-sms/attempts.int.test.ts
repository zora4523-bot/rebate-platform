import { createDb, destroyDb } from '@couli/db';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { sql, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { api, envelope, fixture, NOW, openKit, phone, type Kit, type Response } from './kit.ts';
import {
  ATTEMPT_STATUSES,
  ATTEMPT_TABLE,
  EXTENDED_WINDOW_MS,
  SEND_TIMEOUT_MS,
  assertAttemptTable,
  readAttempts,
  type Attempt,
} from './attempt-store.ts';

// B1-11g 第七轮：这是待实现迁移的测试约定，不在测试里创建表或替业务写 attempt。
// 实现迁移提供 app.sms_send_attempts，至少有以下列；所有发码均经真实 AppModule。
const START = new Date(NOW).getTime();
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
let registrationDown = false;
let registrationFailures = 0;
let sendRisk: ReturnType<RiskModule['createSmsRisk']> | undefined;
// These stores have independent outage rules. Every other sms_risk key fails, regardless of
// how the implementation names its optional send-count cache. No cache contents are fabricated.
const REDIS_OUTAGE_EXEMPT_PREFIXES = ['ip_reg:', 'dev:', 'req:', 'budget:'] as const;
let reached = Promise.withResolvers<void>();
let resume = Promise.withResolvers<void>();
let pauseInsert = false;
let insertReached = Promise.withResolvers<void>();
let insertResume = Promise.withResolvers<void>();
const pausedQueries = new Set<object>();
const POOL_NAME = 'b1-11g-attempts';

async function rows(appId: string): Promise<Attempt[]> {
  return readAttempts(db, appId);
}

// Query-boundary faults, not mocks of a future repository method. All unaffected queries go
// to real PG. A failed result write leaves the already-committed pending attempt untouched.
const faultPlugin: KyselyPlugin = {
  transformQuery({ node, queryId }) {
    // Inspect compiled SQL, including raw SQL and upserts, not Kysely builder node kinds.
    const compiled = db.getExecutor().compileQuery(node, queryId);
    const text = compiled.sql.replaceAll('"', '');
    const isAttempt = text.includes(ATTEMPT_TABLE);
    const inserting = isAttempt && /\binsert\s+into\b/i.test(text);
    const writingResult =
      isAttempt &&
      (/\bupdate\s+(?:only\s+)?[\w.]+\s+(?:as\s+\w+\s+)?set\b/i.test(text) ||
        (inserting && /\bdo\s+update\b/i.test(text) && !compiled.parameters.includes('pending')));
    if (inserting && failInsert) {
      insertFailures++;
      throw Object.assign(new Error('simulated process loss before attempt insert'), {
        code: '08006',
      });
    }
    if (writingResult && failResult) {
      resultFailures++;
      throw Object.assign(new Error('simulated result persistence unavailable'), { code: '08006' });
    }
    if (inserting && pauseInsert) {
      pauseInsert = false;
      pausedQueries.add(queryId);
    }
    return node;
  },
  async transformResult({ result, queryId }) {
    if (pausedQueries.delete(queryId)) {
      // Hold the inserted row before the surrounding transaction can commit. A concurrent
      // unlocked count cannot see it; a correct serialized admission waits for this transaction.
      insertReached.resolve();
      await insertResume.promise;
    }
    return result;
  },
};

beforeAll(async () => {
  redis = await acquireTestRedis();
  database = await createTestDatabase();
  db = createDb({
    connectionString: database.urlFor('couli_app'),
    max: 8,
    applicationName: POOL_NAME,
  });
  const identity = await api<SenderModule>('modules/identity/infra/fake-sms.ts');
  const risk = await api<RiskModule>('modules/risk/index.ts');
  const { RedisUnavailableError } = await api<RedisModule>('modules/platform/redis/index.ts');
  const realSender = identity.createSmsSender;
  const wrapSender: SenderModule['createSmsSender'] = (env, logger) => {
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
        expect(
          persisted.some(
            (row) =>
              row.status === 'pending' &&
              row.phone_hmac === kit.crypto.blindIndex(message.phone, 'risk.sms.phone'),
          ),
        ).toBe(true);
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
  };
  const senderFactory = vi.spyOn(identity, 'createSmsSender').mockImplementation(wrapSender);
  restores.push(() => senderFactory.mockRestore());
  // The current AppModule also supports an explicit sender provider via the public index.
  // Wrap both existing factories so the same fake reaches either supported wiring.
  const exports = await api<SenderModule>('modules/identity/index.ts');
  const publicFactory = vi.spyOn(exports, 'createSmsSender').mockImplementation(wrapSender);
  restores.push(() => publicFactory.mockRestore());
  const realRisk = risk.createSmsRisk;
  const riskFactory = vi.spyOn(risk, 'createSmsRisk').mockImplementation((options) => {
    const handle = options.redis;
    const instance = realRisk({
      ...options,
      redis:
        handle === null
          ? null
          : {
              ...handle,
              namespace(name) {
                const ns = handle.namespace(name);
                function checkOutage(keys: readonly string[]) {
                  if (name !== 'sms_risk') return;
                  if (registrationDown && keys.some((key) => key.startsWith('ip_reg:'))) {
                    registrationFailures++;
                    throw new RedisUnavailableError('command_failed');
                  }
                  if (
                    redisDown &&
                    (keys.length === 0 ||
                      keys.some(
                        (key) =>
                          !REDIS_OUTAGE_EXEMPT_PREFIXES.some((prefix) => key.startsWith(prefix)),
                      ))
                  )
                    throw new RedisUnavailableError('command_failed');
                }
                return {
                  async get(key) {
                    checkOutage([key]);
                    return ns.get(key);
                  },
                  async set(key, value, ttl) {
                    checkOutage([key]);
                    return ns.set(key, value, ttl);
                  },
                  async eval(script, options) {
                    checkOutage(options.keys);
                    return ns.eval(script, options);
                  },
                };
              },
            },
    });
    // Retain the real PG-backed port wired into AppModule, not kit's registration-only helper.
    if (options.db != null) sendRisk = instance;
    return instance;
  });
  restores.push(() => riskFactory.mockRestore());
  kit = await openKit(db.withPlugin(faultPlugin), database.urlFor('couli_app'), redis.url);
}, 180_000);

afterAll(async () => {
  resume.resolve();
  insertResume.resolve();
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
  registrationDown = false;
  registrationFailures = 0;
  insertFailures = 0;
  resultFailures = 0;
  reached = Promise.withResolvers<void>();
  resume = Promise.withResolvers<void>();
  pauseInsert = false;
  insertReached = Promise.withResolvers<void>();
  insertResume = Promise.withResolvers<void>();
  targetPhone = phone();
  // Missing migration must fail as an assertion, never as relation-not-found or TypeError.
  await assertAttemptTable(db);
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

async function counts(
  f: Case,
  expectedCalls: number,
  expectedRows: number,
  limit = 3,
  expectedCounted = expectedRows,
) {
  const attempts = await rows(f.appId);
  const now = kit.clock.now().getTime();
  const counted = attempts.filter(
    (row) =>
      ['pending', 'accepted', 'unknown'].includes(row.status) &&
      row.created_at.getTime() >= now - EXTENDED_WINDOW_MS &&
      row.created_at.getTime() <= now,
  );
  expect(f.providerCalls()).toBe(expectedCalls);
  expect(attempts).toHaveLength(expectedRows);
  // Explicit refusals retain an audit row, but release quota. Lifetime calls/rows may exceed
  // the limit; only pending/accepted/unknown rows within the extended window are bounded.
  expect(f.providerCalls()).toBeLessThanOrEqual(attempts.length);
  expect(counted).toHaveLength(expectedCounted);
  expect(counted.length).toBeLessThanOrEqual(limit);
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
        if (scenario.mode === 'result-write-fails')
          expect(resultFailures).toBeGreaterThanOrEqual(1);
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

it('[AC-B1-11g#56] 明确拒绝保留审计行但不占 IP 额度', async () => {
  const f = await start(2);
  mode = 'rejected';
  envelope(kit, await f.request('landing', targetPhone), 50001);
  expect((await rows(f.appId)).map((row) => row.status)).toEqual([ATTEMPT_STATUSES.rejected]);
  await counts(f, 1, 1, 2, 0);
  envelope(kit, await f.request('app'));
  await counts(f, 2, 2, 2, 1);
  envelope(kit, await f.request('landing'));
  envelope(kit, await f.request('app'), 42901, 3611);
  await counts(f, 3, 3, 2, 2);
});

it('[AC-B1-11g#57] 结果未知保留 unknown 行并占 IP 额度', async () => {
  const f = await start(2);
  mode = 'unknown';
  envelope(kit, await f.request('landing', targetPhone));
  expect((await rows(f.appId)).map((row) => row.status)).toEqual(['unknown']);
  await counts(f, 1, 1, 2);
  envelope(kit, await f.request('app'));
  envelope(kit, await f.request('landing'), 42901, 3611);
  await counts(f, 2, 2, 2);
});

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

it('[AC-B1-11g#63] 手机号频控拦下不写 attempt、不占 IP 额度，换号码可发', async () => {
  const f = await start(2);
  envelope(kit, await f.request('landing', targetPhone));
  envelope(kit, await f.request('app', targetPhone), 42901, 60);
  const attempts = await counts(f, 1, 1, 2);
  expect(attempts.map((row) => row.status)).toEqual(['accepted']);
  expect(new Set(attempts.map((row) => row.phone_hmac)).size).toBe(1);
  envelope(kit, await f.request('landing'));
  envelope(kit, await f.request('landing'), 42901, 3611);
  await counts(f, 2, 2, 2);
});

it('[AC-B1-11g#64] 结果双写失败与 IP Redis 故障叠加，过旧租约后仍按 PG pending 计次', async () => {
  const f = await start(2);
  failResult = true;
  redisDown = true;
  try {
    envelope(kit, await f.request('landing'));
    expect(resultFailures).toBeGreaterThanOrEqual(1);
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

it('[AC-B1-11g#66] Redis 中断后恢复但缓存只有一条，准入仍以 PG 两条为准', async () => {
  const f = await start(3);
  envelope(kit, await f.request('landing'));
  expect(f.providerCalls(), '真实入口必须调用已注入的供应商替身').toBe(1);
  redisDown = true;
  try {
    envelope(kit, await f.request('app'));
    await counts(f, 2, 2, 3);
  } finally {
    redisDown = false;
  }
  // Resume with whatever stale cache the outage naturally left. Do not delete or rewrite keys:
  // a cache-authoritative implementation must not escape detection through a type error.
  envelope(kit, await f.request('landing'));
  envelope(kit, await f.request('app'), 42901, 3611);
  envelope(kit, await f.request('landing'), 42901, 3611);
  await counts(f, 3, 3, 3);
});

for (const [index, [first, next]] of (
  [
    ['landing', 'app'],
    ['app', 'landing'],
  ] as const
).entries()) {
  it(`[AC-B1-11g#${67 + index}] ${first} 暂停在 attempt 插入后提交前，${next} 不能抢占最后额度`, async () => {
    const f = await start(2);
    envelope(kit, await f.request('landing'));
    pauseInsert = true;
    const initial = f.request(first);
    let competitor: Promise<Response> | undefined;
    let finished = false;
    try {
      expect(
        await Promise.race([
          insertReached.promise.then(() => 'paused'),
          initial.then(() => 'returned'),
        ]),
      ).toBe('paused');
      competitor = f.request(next).then((response) => {
        finished = true;
        return response;
      });
      // Observe actual PG lock contention (or completion in an unsafe implementation), not
      // a sleep followed by an assumption that both HTTP requests happened to overlap.
      let overlapping = false;
      for (let poll = 0; poll < 1000; poll++) {
        const blocked = await sql<{ waiting: boolean }>`select exists (
          select 1 from pg_stat_activity
          where datname = current_database() and application_name = ${POOL_NAME}
            and cardinality(pg_blocking_pids(pid)) > 0
        ) as waiting`.execute(db);
        if (finished || blocked.rows[0]?.waiting === true) {
          overlapping = true;
          break;
        }
      }
      expect(overlapping, '竞争请求已完成或在 PG 等待首请求的事务锁').toBe(true);
      insertResume.resolve();
      envelope(kit, await initial);
      envelope(kit, await competitor, 42901, 3611);
      await counts(f, 2, 2, 2);
    } finally {
      pauseInsert = false;
      insertResume.resolve();
      await initial;
      await competitor;
    }
  });
}

for (const [index, terminal] of (
  [
    { mode: 'normal', status: ATTEMPT_STATUSES.accepted, code: 0, counted: 1, calls: 2, rows: 2 },
    {
      mode: 'rejected',
      status: ATTEMPT_STATUSES.rejected,
      code: 50001,
      counted: 0,
      calls: 3,
      rows: 3,
    },
    { mode: 'unknown', status: ATTEMPT_STATUSES.unknown, code: 0, counted: 1, calls: 2, rows: 2 },
  ] as const
).entries()) {
  it(`[AC-B1-11g#${69 + index}] ${terminal.mode} 终态收到重复或非法结果回写时状态与额度不变`, async () => {
    const f = await start(2);
    mode = terminal.mode;
    envelope(kit, await f.request('landing', targetPhone), terminal.code);
    const original = await counts(f, 1, 1, 2, terminal.counted);
    expect(original.map((row) => row.status)).toEqual([terminal.status]);
    expect(sendRisk, '使用真实 AppModule 内已有的 PG 结果回写端口').toBeDefined();

    // The first completion above came through HTTP and the real provider adapter. Replay late
    // completions through that same existing port; never write status in SQL from the test.
    // Reflect.apply deliberately includes the runtime-invalid terminal → pending input, which
    // TypeScript excludes. Rejecting it or ignoring it is fine; persisting it is not.
    for (const outcome of Object.values(ATTEMPT_STATUSES)) {
      await Promise.allSettled([
        Promise.resolve().then(() =>
          Reflect.apply(sendRisk!.finishAttempt, sendRisk, [
            { appId: f.appId, attemptId: original[0]!.attempt_id, outcome },
          ]),
        ),
      ]);
      expect(await rows(f.appId), `终态不可转为 ${outcome}`).toEqual(original);
      await counts(f, 1, 1, 2, terminal.counted);
    }

    // Verify the observable admission result too, rather than only recounting statuses in JS.
    envelope(kit, await f.request('app'));
    if (terminal.mode === 'rejected') envelope(kit, await f.request('landing'));
    envelope(kit, await f.request('landing'), 42901, 3611);
    await counts(f, terminal.calls, terminal.rows, 2, 2);
  });
}

for (const [index, entry] of (['landing', 'app'] as const).entries()) {
  it(`[AC-B1-11g#${72 + index}] ${entry} 注册计数读取失败时拒绝，不写 attempt、不调用供应商`, async () => {
    const f = await start(2);
    registrationDown = true;
    try {
      envelope(kit, await f.request(entry, targetPhone), 42901, 1);
      expect(registrationFailures).toBeGreaterThanOrEqual(1);
      await counts(f, 0, 0, 2, 0);
    } finally {
      registrationDown = false;
    }
    // The rejected request consumed neither phone nor IP quota; recovery can use the same phone.
    envelope(kit, await f.request(entry, targetPhone));
    await counts(f, 1, 1, 2, 1);
  });
}
