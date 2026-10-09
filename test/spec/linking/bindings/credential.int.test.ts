import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { ACCOUNT_NAME, RELATION, suite } from './kit.ts';
import { sdk, web } from './client.ts';
import { binding, bindings, configure, scenario, state, states } from './records.ts';
import { accepted, rejected, validate } from './assertions.ts';

const use = suite(createTestDatabase, acquireTestRedis);

it.each(['web_code', 'sdk_token'] as const)(
  '[AC-B1-06h#1][AC-B1-06h#2][AC-B1-06h#3] %s 使用下发应用配置并直接创建 active',
  async (method) => {
    const f = use();
    const { c, accountId } = await scenario(f);
    await configure(f, c, ['sdk_token', 'web_code']);
    const s = await state(f, c, { auth_methods: ['sdk_token', 'web_code'] });
    const body = method === 'web_code' ? web(s.state) : sdk(s.state);
    const trace = randomUUID();
    const response = await c.post(body, { trace });
    await accepted(response);
    expect(response.json()).toMatchObject({ trace_id: trace });
    const { state: ignoredState, auth_method: ignoredMethod, ...credential } = body;
    void ignoredState;
    void ignoredMethod;
    expect(f.exchange).toHaveBeenCalledExactlyOnceWith({
      appId: c.appId,
      method,
      credential,
      appRef: `synthetic/issued-app/${method}`,
      traceId: trace,
    });
    expect(await bindings(f, c)).toEqual([
      expect.objectContaining({
        app_id: c.appId,
        user_id: c.uid,
        platform: 'taobao',
        status: 'active',
        relation_id: RELATION,
        union_account_id: accountId,
        bound_at: f.clock.now(),
        released_at: null,
        cooldown_until: null,
        blocked_reason: null,
      }),
    ]);
    expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
    expect(response.payload).not.toContain(RELATION);
    expect(response.payload).not.toContain(ACCOUNT_NAME);
  },
);

it.each(['web_code', 'sdk_token'] as const)(
  '[AC-B1-06h#7] %s 凭证无效：state 已用，既有绑定全不变且不可重试',
  async (method) => {
    const f = use();
    const { c, accountId } = await scenario(f);
    await configure(f, c, ['sdk_token', 'web_code']);
    await binding(f, c, accountId, { status: 'invalid' });
    const before = await bindings(f, c);
    const s = await state(f, c, { auth_methods: ['sdk_token', 'web_code'] });
    f.exchange.mockResolvedValue({ kind: 'credential_invalid' });
    const body = method === 'web_code' ? web(s.state) : sdk(s.state);
    await rejected(await c.post(body), 30104, 'credential_invalid');
    expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
    expect(await bindings(f, c)).toEqual(before);
    expect(f.exchange).toHaveBeenCalledOnce();
    await rejected(await c.post(body), 30104);
    expect(f.exchange).toHaveBeenCalledOnce();
    expect(await bindings(f, c)).toEqual(before);
  },
);

it('[AC-B1-06h#13] 同键同体逐字节重放，同键异体 20901，不重复换凭证或写绑定', async () => {
  const f = use();
  const { c } = await scenario(f);
  const s = await state(f, c);
  const key = randomUUID();
  const body = web(s.state);
  const first = await c.post(body, { key });
  await accepted(first);
  const before = await bindings(f, c);
  expect(before).toHaveLength(1);
  const replay = await c.post(body, { key });
  await accepted(replay);
  expect(replay.payload).toBe(first.payload);
  const changed = await c.post(web(s.state, 'synthetic-different-code'), { key });
  expect(changed.statusCode).toBe(409);
  expect(changed.json()).toMatchObject({ code: 20901 });
  await validate(changed.json(), 'ErrorEnvelope');
  expect(f.exchange).toHaveBeenCalledOnce();
  expect(await bindings(f, c)).toEqual(before);
  expect(await states(f, c)).toEqual([{ ...s, used_at: f.clock.now() }]);
});

it.each([
  { method: 'web_code', outcome: 'bound' },
  { method: 'web_code', outcome: 'credential_invalid' },
  { method: 'sdk_token', outcome: 'bound' },
  { method: 'sdk_token', outcome: 'credential_invalid' },
] as const)(
  '[AC-B1-06h#14] $method / $outcome 凭证不进库、日志、响应',
  async ({ method, outcome }) => {
    const f = use();
    const { c } = await scenario(f);
    await configure(f, c, ['sdk_token', 'web_code']);
    const s = await state(f, c, { auth_methods: ['sdk_token', 'web_code'] });
    f.exchange.mockResolvedValue(
      outcome === 'bound'
        ? { kind: 'bound', relationId: RELATION }
        : { kind: 'credential_invalid' },
    );
    const sensitive = Buffer.from(`synthetic credential ${randomUUID()}`, 'ascii').toString('hex');
    const body =
      method === 'web_code'
        ? web(s.state, sensitive)
        : { ...sdk(s.state), access_token: sensitive };
    const response = await c.post(body);
    if (outcome === 'bound') await accepted(response);
    else await rejected(response, 30104, 'credential_invalid');
    expect(f.exchange).toHaveBeenCalledOnce();
    for (const table of ['union_bindings', 'union_auth_sessions', 'idempotency_keys'] as const) {
      const result = await sql<{ row: string }>`SELECT to_jsonb(t)::text AS row
        FROM ${sql.table(`app.${table}`)} AS t WHERE app_id = ${c.appId}`.execute(f.db);
      expect(JSON.stringify(result.rows)).not.toContain(sensitive);
      if (table !== 'union_bindings' || outcome === 'bound')
        expect(result.rows.length).toBeGreaterThan(0);
    }
    expect(f.lines.join('')).not.toContain(sensitive);
    expect(response.payload).not.toContain(sensitive);
  },
);
