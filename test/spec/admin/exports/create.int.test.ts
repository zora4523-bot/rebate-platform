import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { sql } from 'kysely';
import { decode } from '../../identity/token/kit.ts';
import { adminSurface } from '../permissions/expected.ts';
import { redisOf } from '../step-up/kit.ts';
import { error, harness, ok, setup, text, validate, type View } from './kit.ts';

const h = harness(createTestDatabase, acquireTestRedis);
const full = {
  resource: 'users',
  filters: { risk_state: 'banned' },
  unmasked: true,
  reason: '核对封禁账号',
};

it('[AC-B1-34f#33] 明文创建拒绝短信档令牌，必须使用 pii 权限点的 totp 档', async () => {
  const f = await setup(h);
  const surface = await adminSurface();
  const tokens = surface.createAdminStepUpTokens({
    clock: f.clock,
    redis: (await redisOf({ app: f.app } as Parameters<typeof redisOf>[0])).namespace(
      'admin-step-up',
    ),
  });
  const sessionId = decode(f.session.admin_token).payload['jti'];
  expect(sessionId).toBeTypeOf('string');
  const token = await tokens.issue({
    appId: f.appId,
    adminId: f.actor.id,
    sessionId: sessionId as string,
    tier: 'sms',
  });
  await error(await f.create(full, token.step_up_token), 10003, { tier: 'totp' });
  expect(await f.tasks()).toEqual([]);
  expect(await f.audits()).toEqual([]);
});

it('[AC-B1-34f#34] 明文创建的二次审计失败时不得留下任务和第一份审计', async () => {
  const db = h.db.withPlugin({
    transformQuery({ node }) {
      if (node.kind === 'InsertQueryNode' && text(node).includes('export_unmasked')) {
        throw new Error('synthetic audit write failure');
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const f = await setup({ ...h, db });
  const token = (await f.issue()).step_up_token;
  await error(await f.create(full, token), 50001, undefined);
  expect(await f.tasks()).toEqual([]);
  expect(await f.audits()).toEqual([]);
});

it('[AC-B1-34f#2] 默认脱敏，202 pending，创建、审计和 generate 入队在同一事务', async () => {
  const f = await setup(h);
  const observations: { inside: number; outside: number }[] = [];
  f.send.mockImplementation(async (queue, name, payload, options) => {
    if (queue === 'export') {
      expect(name).toBe('generate');
      expect(options.trx).not.toBeNull();
      const inside = await options
        .trx!.withSchema('app')
        .selectFrom('export_tasks')
        .selectAll()
        .where('app_id', '=', f.appId)
        .execute();
      observations.push({ inside: inside.length, outside: (await f.tasks()).length });
      expect(payload).toEqual({ appId: f.appId, taskId: inside[0]!.id });
    }
    return f.realSend(queue, name, payload, options);
  });
  const view = await ok<View>(
    await f.create(
      { resource: 'users', filters: { risk_state: 'frozen' } },
      'ignored-invalid-token',
    ),
  );
  expect(view).toMatchObject({
    masked: true,
    status: 'pending',
    progress: null,
    failure_reason: null,
    file_name: null,
    row_count: null,
    expires_at: null,
    created_by: f.actor.id,
  });
  expect(view.id).toMatch(/^exp_/);
  expect(new Date(view.created_at)).toEqual(f.clock.now());
  expect(observations).toEqual([{ inside: 1, outside: 0 }]);
  const [row] = await f.tasks();
  expect(row).toMatchObject({
    public_id: view.id,
    app_id: f.appId,
    masked: true,
    resource: 'users',
    filters: { risk_state: 'frozen' },
    status: 'pending',
    created_at: f.clock.now(),
  });
  expect(await f.audits()).toEqual([
    expect.objectContaining({
      action: 'export_create',
      admin_id: f.actor.id,
      at: f.clock.now(),
      after: expect.objectContaining({
        task_id: view.id,
        resource: 'users',
        masked: true,
        filters: { risk_state: 'frozen' },
      }),
    }),
  ]);
  expect(f.guarded.mock.calls.map(([input]) => input.permission)).toContain('export');
  expect(f.guarded.mock.calls.map(([input]) => input.permission)).not.toContain('pii.reveal_phone');
});

it('[AC-B1-34f#3] 创建没有幂等键：两次调用生成两个任务和两份入队', async () => {
  const f = await setup(h);
  const first = await ok<View>(await f.create());
  const second = await ok<View>(await f.create());
  expect(first.id).not.toBe(second.id);
  expect(await f.tasks()).toHaveLength(2);
  expect(f.send.mock.calls.filter(([queue]) => queue === 'export')).toHaveLength(2);
});

it('[AC-B1-34f#4] 入队完成后抛错回滚任务、审计和真实队列记录，令牌仍可重用', async () => {
  const f = await setup(h);
  const token = (await f.issue()).step_up_token;
  f.send.mockImplementationOnce(async (...args) => {
    await f.realSend(...args);
    throw new Error('synthetic enqueue failure');
  });
  await error(await f.create(full, token), 50001, undefined);
  expect(await f.tasks()).toEqual([]);
  expect(await f.audits()).toEqual([]);
  const jobs = await sql<{ n: string }>`select count(*)::text as n from pgboss.job
    where name = 'export' and data::text like ${`%${f.appId}%`}`.execute(h.db);
  expect(jobs.rows[0]!.n).toBe('0');
  expect((await ok<View>(await f.create(full, token))).masked).toBe(false);
});

it.each([
  ['export', ['user.list']],
  ['user.list', ['export']],
  ['pii.reveal_phone', ['export', 'user.list']],
] as const)('[AC-B1-34f#5] 创建缺少 %s 拒绝且无副作用', async (missing, permissions) => {
  const f = await setup(h, permissions);
  await error(await f.create(missing === 'pii.reveal_phone' ? full : undefined), 10403, {
    reason: 'admin_permission_denied',
  });
  expect(await f.tasks()).toEqual([]);
  expect(await f.audits()).toEqual([]);
  expect(f.send).not.toHaveBeenCalled();
});

it('[AC-B1-34f#6] audit_logs 只需 export，保留来源筛选、始终脱敏', async () => {
  const f = await setup(h, ['export']);
  const filters = {
    actor_id: f.actor.id,
    from: '2026-10-01T00:00:00+08:00',
    to: '2026-10-02T00:00:00+08:00',
  };
  const view = await ok<View>(await f.create({ resource: 'audit_logs', filters }));
  expect(view).toMatchObject({ resource: 'audit_logs', masked: true, status: 'pending' });
  expect((await f.tasks())[0]).toMatchObject({ filters, masked: true });
});

it('[AC-B1-34f#7] 明文创建用 pii.reveal_phone 守卫，202 消耗令牌并分别审计', async () => {
  const f = await setup(h);
  const token = (await f.issue()).step_up_token;
  const view = await ok<View>(await f.create(full, token));
  expect(view.masked).toBe(false);
  expect(f.guarded.mock.calls.map(([input]) => input.permission)).toContain('pii.reveal_phone');
  expect(
    f.guarded.mock.calls
      .filter(([input]) => input.permission === 'pii.reveal_phone')
      .every(([input]) => input.readOnly !== true),
  ).toBe(true);
  const audits = await f.audits();
  expect(audits.map((a) => a.action).sort()).toEqual(['export_create', 'export_unmasked']);
  expect(audits.find((a) => a.action === 'export_unmasked')).toMatchObject({
    admin_id: f.actor.id,
    at: f.clock.now(),
    after: expect.objectContaining({ task_id: view.id, resource: 'users', reason: full.reason }),
  });
  expect(text(audits)).not.toContain(token);
  expect(text(f.lines)).not.toContain(token);
  await error(await f.create(full, token), 10003, { tier: 'totp' });
  expect(await f.tasks()).toHaveLength(1);
  expect(await f.audits()).toHaveLength(2);
});

it.each(['missing', 'invalid', 'expired'] as const)(
  '[AC-B1-34f#8] 明文创建拒绝 %s 动态码令牌',
  async (kind) => {
    const f = await setup(h);
    let token: string | undefined;
    if (kind === 'invalid') token = 'invalid-step-up';
    if (kind === 'expired') {
      token = (await f.issue()).step_up_token;
      f.clock.advanceMs(300_000);
    }
    await error(await f.create(full, token), 10003, { tier: 'totp' });
    expect(await f.tasks()).toEqual([]);
    expect(await f.audits()).toEqual([]);
  },
);

it.each([
  [{ resource: 'users', filters: {}, unmasked: true }, ['reason']],
  [{ resource: 'users', filters: {}, reason: '多余理由' }, ['reason']],
  [{ resource: 'users', filters: {}, unmasked: false, reason: '多余理由' }, ['reason']],
  [
    {
      resource: 'audit_logs',
      filters: { from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' },
    },
    ['from', 'to'],
  ],
] as const)('[AC-B1-34f#9] 创建校验 %j，失败不消耗令牌', async (body, fields) => {
  const f = await setup(h);
  const token = (await f.issue()).step_up_token;
  await error(await f.create(body, token), 20001, { fields });
  expect(await f.tasks()).toEqual([]);
  expect(await f.audits()).toEqual([]);
  expect((await ok<View>(await f.create(full, token))).masked).toBe(false);
});

it.each([
  [{ ...full, reason: '' }, 'reason'],
  [{ ...full, reason: '理'.repeat(201) }, 'reason'],
  [{ resource: 'audit_logs', filters: {}, reason: '多余理由' }, 'reason'],
  [{ resource: 'audit_logs', filters: {}, unmasked: true }, 'unmasked'],
] as const)('[AC-B1-34f#36] 契约形状错误 %j 拒绝且不消耗令牌', async (body, field) => {
  const f = await setup(h);
  const token = (await f.issue()).step_up_token;
  const response = await f.create(body, token);
  expect(response.statusCode).toBe(400);
  // oneOf validation can report errors for both branches; do not require a single AJV error.
  expect(response.json()).toMatchObject({
    code: 20001,
    data: { fields: expect.arrayContaining([field]) },
  });
  await validate(response);
  expect(await f.tasks()).toEqual([]);
  expect(await f.audits()).toEqual([]);
  expect((await ok<View>(await f.create(full, token))).masked).toBe(false);
});

it('[AC-B1-34f#37] 脱敏创建不检查也不消耗合法动态码，随后仍可用于明文创建', async () => {
  const f = await setup(h);
  const token = (await f.issue()).step_up_token;
  expect((await ok<View>(await f.create({ resource: 'users', filters: {} }, token))).masked).toBe(
    true,
  );
  expect((await ok<View>(await f.create(full, token))).masked).toBe(false);
  expect(await f.tasks()).toHaveLength(2);
});

it('[AC-B1-34f#10] 合法理由边界 1 与 200 字均可创建', async () => {
  const f = await setup(h);
  for (const reason of ['查', '理'.repeat(200)]) {
    const token = (await f.issue()).step_up_token;
    expect((await ok<View>(await f.create({ ...full, reason }, token))).masked).toBe(false);
  }
  expect(await f.tasks()).toHaveLength(2);
});
