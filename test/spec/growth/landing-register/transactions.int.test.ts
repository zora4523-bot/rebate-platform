import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { sql, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { api } from '../../identity/landing-sms/kit.ts';
import { answer, fixture, noAccount, openKit, registered, type Kit } from './kit.ts';

let server: Awaited<ReturnType<typeof acquireTestRedis>> | undefined;
let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let db: ReturnType<typeof createDb>;
let kit: Kit;
let fault: string | undefined;
let failures = 0;
let failIdempotencyResult = false;
let afterInsert: (() => Promise<void>) | undefined;
let redisFailure: 'read' | 'write' | undefined;
let redisFailures = 0;
let restoreRedis: (() => void) | undefined;
const callbacks = new Map<object, () => Promise<void>>();

// Observe actual PG statements without naming or replacing any future landing service member.
// Fail after the write has happened: a passing result must undo the write, not merely avoid it.
const plugin: KyselyPlugin = {
  transformQuery({ node, queryId }) {
    const compiled = db.getExecutor().compileQuery(node, queryId);
    const text = compiled.sql.replaceAll('"', '');
    if (
      failIdempotencyResult &&
      /\bupdate\s+(?:app\.)?idempotency_keys\b/i.test(text) &&
      compiled.parameters.includes('completed')
    ) {
      failIdempotencyResult = false;
      callbacks.set(queryId, async () => {
        failures++;
        throw new Error('injected failure before idempotency commit');
      });
    } else if (fault && new RegExp(`\\binsert\\s+into\\s+(?:app\\.)?${fault}\\b`, 'i').test(text)) {
      callbacks.set(queryId, async () => {
        failures++;
        throw new Error('injected persistence failure after insert');
      });
    } else if (afterInsert && /\binsert\s+into\s+(?:app\.)?users\b/i.test(text)) {
      callbacks.set(queryId, afterInsert);
      afterInsert = undefined;
    }
    return node;
  },
  async transformResult({ result, queryId }) {
    const callback = callbacks.get(queryId);
    callbacks.delete(queryId);
    await callback?.();
    return result;
  },
};

beforeAll(async () => {
  server = await acquireTestRedis();
  database = await createTestDatabase();
  db = createDb({
    connectionString: database.urlFor('couli_app'),
    max: 12,
    applicationName: 'b1-11h-transactions',
  });
  type RedisModule = typeof import('../../../../apps/api/src/modules/platform/redis/index.ts');
  const redisModule = await api<RedisModule>('modules/platform/redis/index.ts');
  const createRedis = redisModule.createRedisHandle;
  const spy = vi.spyOn(redisModule, 'createRedisHandle').mockImplementation(async (...args) => {
    const handle = await createRedis(...args);
    if (handle === null) return null;
    return {
      ...handle,
      namespace(name) {
        const ns = handle.namespace(name);
        if (name !== 'invite_fail') return ns;
        return {
          ...ns,
          async get(key) {
            if (redisFailure === 'read') {
              redisFailures++;
              throw new redisModule.RedisUnavailableError('command_failed');
            }
            return ns.get(key);
          },
          async eval(script, options) {
            if (redisFailure === 'write') {
              redisFailures++;
              throw new redisModule.RedisUnavailableError('command_failed');
            }
            return ns.eval(script, options);
          },
        };
      },
    };
  });
  restoreRedis = () => spy.mockRestore();
  kit = await openKit(db.withPlugin(plugin), database.urlFor('couli_app'), server.url);
}, 180_000);
afterAll(async () => {
  try {
    await kit?.close();
  } finally {
    restoreRedis?.();
    try {
      if (db) await destroyDb(db);
      await database?.drop();
    } finally {
      await server?.stop();
    }
  }
}, 120_000);

for (const table of ['consent_records', 'relation_change_logs', 'landing_registrations']) {
  it(`[AC-B1-11h#23] ${table} 已插入后抛错，账号、关系、同意与限额行全部回滚，短信仍已消费`, async () => {
    const f = await fixture(kit);
    const body = await f.sms();
    const key = randomUUID();
    failures = 0;
    fault = table;
    try {
      answer(f, await f.post(body, { key }), 50001);
    } finally {
      fault = undefined;
    }
    expect(failures).toBe(1);
    await noAccount(f, body.phone);
    expect(await f.idempotency()).toEqual([]);
    expect(
      await kit.db
        .selectFrom('level_change_logs')
        .selectAll()
        .where('app_id', '=', f.appId)
        .execute(),
    ).toEqual([]);
    answer(f, await f.post(body, { key }), 20003);
    kit.clock.advanceMs(60_000);
    answer(f, await f.post(await f.sms(body.phone), { key }));
    await registered(f, body.phone);
  });
}

it('[AC-B1-11h#24] 预检后邀请人被封禁，bind 重读失败 30401；保存点撤销建号再提交幂等结果', async () => {
  const f = await fixture(kit);
  const body = await f.sms();
  const key = randomUUID();
  let changed = false;
  afterInsert = async () => {
    await f.risk('banned');
    changed = true;
  };
  try {
    answer(f, await f.post(body, { key }), 30401);
  } finally {
    afterInsert = undefined;
  }
  expect(changed).toBe(true);
  await noAccount(f, body.phone);
  expect(await f.idempotency()).toHaveLength(1);
  await kit.db
    .updateTable('user_risk_state')
    .set({ state: 'normal' })
    .where('user_id', '=', f.inviter)
    .execute();
  answer(f, await f.post(body, { key }), 30401);
  answer(f, await f.post(body), 20003);
  // The bind-time 30401 counts in the same phone/IP daily budget as precheck failures.
  for (let n = 0; n < 4; n++) answer(f, await f.post({ ...body, invite_code: '' }), 30401);
  answer(f, await f.post(body), 42901);
});

// A timeout prevents a broken implementation hanging the runner. The timeout itself does not
// count as success: every use asserts the arrival signal, with the response as an early failure.
async function arrived(signal: Promise<void>, request: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      signal.then(() => true),
      request.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 5000);
      }),
    ]);
    expect(result, 'request must reach the database barrier before returning').toBe(true);
  } finally {
    clearTimeout(timer);
  }
}

async function databaseWaiters(count: number, requests: Promise<unknown>[]) {
  let finished = false;
  void Promise.allSettled(requests).then(() => {
    finished = true;
  });
  let observed = 0;
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity
      where application_name = 'b1-11h-transactions' and state = 'active'
        and wait_event_type = 'Lock' and wait_event in ('advisory', 'transactionid')`.execute(db);
    observed = result.rows[0]!.n;
    if (observed >= count || finished) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  expect(
    observed,
    'competitors must reach a PG lock while the first account is uncommitted',
  ).toBeGreaterThanOrEqual(count);
}

it('[AC-B1-11h#25] 已有二号，三个新号并发争最后名额，只有一个建号且恰有三条 PG 记录', async () => {
  const f = await fixture(kit);
  for (let n = 0; n < 2; n++) answer(f, await f.post(await f.sms()));
  const bodies = await Promise.all([f.sms(), f.sms(), f.sms()]);
  const reached = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  afterInsert = async () => {
    reached.resolve();
    await resume.promise;
  };
  const first = f.post(bodies[0]!);
  let others: ReturnType<typeof f.post>[] = [];
  try {
    await arrived(reached.promise, first);
    // The first inserted account is still uncommitted while both competitors enter HTTP.
    others = bodies.slice(1).map((body) => f.post(body));
    await databaseWaiters(2, others);
    resume.resolve();
    const responses = await Promise.all([first, ...others]);
    expect(responses.map((r) => r.json()['code']).sort()).toEqual([0, 44001, 44001]);
    for (const response of responses) answer(f, response, response.json()['code'] as number);
    expect(await f.registrations()).toHaveLength(3);
    expect((await f.users()).filter((u) => u.register_method === 'h5_landing')).toHaveLength(3);
    expect(await f.consents()).toHaveLength(6);
    expect(await f.relations()).toHaveLength(3);
    for (const body of bodies) answer(f, await f.post(body), 20003);
  } finally {
    afterInsert = undefined;
    resume.resolve();
    await Promise.allSettled([first, ...others]);
  }
});

it('[AC-B1-11h#26] 同号两键并发，各自真实有效短信均已核销，只有一个账号且另一请求 already_registered', async () => {
  const f = await fixture(kit);
  const body = await f.sms();
  const reached = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  afterInsert = async () => {
    reached.resolve();
    await resume.promise;
  };
  const first = f.post(body);
  let second: ReturnType<typeof f.post> | undefined;
  try {
    await arrived(reached.promise, first);
    // A single SMS cannot be consumed twice. Issue a second genuine code while the first
    // transaction is paused, so both distinct keys can legitimately pass SMS validation.
    kit.clock.advanceMs(60_000);
    const next = await f.sms(body.phone);
    second = f.post(next, { ip: '203.0.113.89' });
    await databaseWaiters(1, [second]);
    resume.resolve();
    const responses = await Promise.all([first, second]);
    expect(
      responses.map((r) => r.json<{ data?: { result: string } }>().data?.result).sort(),
    ).toEqual(['already_registered', 'registered']);
    for (const response of responses)
      answer(f, response, 0, response.json<{ data: { result: string } }>().data.result);
    expect((await f.users()).filter((u) => u.phone_hmac === f.hash(body.phone))).toHaveLength(1);
    expect(await f.consents()).toHaveLength(2);
    expect(await f.relations()).toHaveLength(1);
    expect(await f.registrations()).toHaveLength(1);
    expect(await f.idempotency()).toHaveLength(2);
    answer(f, await f.post(next), 20003);
  } finally {
    afterInsert = undefined;
    resume.resolve();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
});

it('[AC-B1-11h#27] 失败后不占同 IP PG 名额，别的号码仍可注册到配置上限', async () => {
  const f = await fixture(kit);
  await f.config('landing.ip_register_limit', 1);
  const body = await f.sms();
  fault = 'relation_change_logs';
  try {
    answer(f, await f.post(body), 50001);
  } finally {
    fault = undefined;
  }
  await noAccount(f, body.phone);
  const next = await f.sms();
  answer(f, await f.post(next));
  await registered(f, next.phone);
  // Counts come from PG committed landing rows, not the all-registration Redis hook.
  const count = await sql<{ n: number }>`select count(*)::int as n from app.landing_registrations
    where app_id = ${f.appId}`.execute(db);
  expect(count.rows[0]?.n).toBe(1);
});

it('[AC-B1-11h#32] PG 提交失败后同键重试不重复计 Redis 30401，seen 标记随 phone 主体去重', async () => {
  const f = await fixture(kit);
  const body = { ...(await f.sms()), invite_code: '' };
  const key = randomUUID();
  failures = 0;
  failIdempotencyResult = true;
  try {
    answer(f, await f.post(body, { key }), 50001);
  } finally {
    failIdempotencyResult = false;
  }
  expect(failures).toBe(1);
  expect(await f.idempotency()).toEqual([]);
  answer(f, await f.post(body, { key }), 30401);
  for (let n = 0; n < 4; n++) answer(f, await f.post(body), 30401);
  answer(f, await f.post(body), 42901);
  expect(await f.idempotency()).toHaveLength(5);
  await noAccount(f, body.phone);
});

for (const mode of ['read', 'write'] as const) {
  it(`[AC-B1-11h#33] invite_fail Redis ${mode} 失败返回 50001，不保存幂等、不核销短信`, async () => {
    const f = await fixture(kit);
    const body = await f.sms();
    const key = randomUUID();
    redisFailures = 0;
    redisFailure = mode;
    try {
      answer(f, await f.post({ ...body, invite_code: '' }, { key }), 50001);
    } finally {
      redisFailure = undefined;
    }
    expect(redisFailures).toBeGreaterThan(0);
    expect(await f.idempotency()).toEqual([]);
    await noAccount(f, body.phone);
    // Unstored 5xxxx permits a changed request body with the same key after recovery.
    answer(f, await f.post(body, { key }));
    await registered(f, body.phone);
  });
}
