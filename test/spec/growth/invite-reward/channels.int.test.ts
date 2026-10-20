import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openSuite, closeSuite, withHttp, type HttpFixture } from '../../risk/sms-risk/http-kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import { phone } from '../../risk/sms-risk/kit.ts';
import {
  openKit as openLanding,
  fixture as landingFixture,
  answer as landingAnswer,
} from '../landing-register/kit.ts';
import { growth } from './kit.ts';

type Suite = Awaited<ReturnType<typeof openSuite>>;
let suite: Suite;
beforeAll(async () => {
  suite = await openSuite();
}, 180_000);
afterAll(async () => {
  await closeSuite(suite);
});
const CODE = 'K7Q2MZ';
const IP = '203.0.113.88';
const CONFIG = {
  h5_base_url: 'https://h5.example.test/',
  'h5_release.stable': 'stable',
  kf: { url: 'https://kf.example.test/' },
  'legal.privacy.version': 1,
  'legal.privacy.min_version': 1,
  'legal.agreement.version': 1,
  'growth.invite_reward.enabled': true,
  'growth.invite_reward.amount_fen': 1000,
  'growth.invite_reward.total_budget_fen': 100000,
  'growth.invite_reward.daily_budget_fen': 20000,
  'growth.invite_reward.eligibility_days': 45,
};
async function config(app: string, key: string, value: unknown) {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${app}, ${key}, ${JSON.stringify(value)}::jsonb, 'B1-35')
    ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value`.execute(suite.kit.db);
}
async function login(f: HttpFixture, invite = true) {
  const client = await f.client();
  const number = phone();
  const sent = await client.send(number);
  expect(sent.json()).toMatchObject({ code: 0 });
  const code = f.sender.outbox().findLast((m) => m.phone === number)?.code;
  expect(code).toMatch(/^\d{6}$/);
  const response = await client.post(
    '/v1/auth/login/sms',
    {
      phone: number,
      code,
      ...(invite ? { invite_code: CODE } : {}),
      legal_versions: { privacy: 1, agreement: 1 },
      consent_at: f.clock.now().toISOString(),
    },
    IP,
  );
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    code: 0,
    data: { is_new_user: true, ...(invite ? { invite_bind: { result: 'bound' } } : {}) },
  });
  return {
    client,
    data: response.json<{
      data: { user_id: string; tokens: { access_token: string } };
    }>().data,
  };
}
async function assertQualified(
  app: string,
  invitee: string,
  inviter: string,
  source: string,
  hmac: string,
  at: Date,
) {
  const db = suite.kit.db.withSchema('app');
  const rows = await db
    .selectFrom('invite_rewards')
    .selectAll()
    .where('app_id', '=', app)
    .where('invitee_id', '=', invitee)
    .execute();
  expect(rows).toEqual([
    expect.objectContaining({
      inviter_id: inviter,
      bind_source: source,
      amount_fen: 1000n,
      eligibility_days: 45,
      qualified_at: at,
      bind_ip_hmac: hmac,
      status: 'qualified',
      trigger_order_id: null,
    }),
  ]);
  const relation = await db
    .selectFrom('relation_change_logs')
    .selectAll()
    .where('app_id', '=', app)
    .where('user_id', '=', invitee)
    .execute();
  expect(relation).toEqual([expect.objectContaining({ source, at, to_parent_id: inviter })]);
  expect(
    await db
      .selectFrom('invite_reward_budgets')
      .selectAll()
      .where('app_id', '=', app)
      .where('period', '=', 'total')
      .executeTakeFirst(),
  ).toMatchObject({ reserved_fen: 2000n, granted_fen: 0n });
}

it('[AC-B1-35#80] AppModule 注册通道把 client_ip 和绑定时刻传入资格写入', async () => {
  await withHttp(suite, CONFIG, async (f) => {
    const inviter = await seedUser(suite.kit.db, f.id, {
      invite: CODE,
      phoneHmac: randomBytes(32).toString('hex'),
    });
    const { data } = await login(f);
    await assertQualified(
      f.id,
      data.user_id,
      inviter,
      'register',
      f.crypto.blindIndex(IP, 'invite_rewards.bind_ip'),
      f.clock.now(),
    );
  });
});

it('[AC-B1-35#81] AppModule backfill 从 request.ip 传递 IP，重复请求不多占预算', async () => {
  await withHttp(suite, CONFIG, async (f) => {
    const inviter = await seedUser(suite.kit.db, f.id, {
      invite: CODE,
      phoneHmac: randomBytes(32).toString('hex'),
    });
    const { client, data } = await login(f, false);
    const headers = {
      authorization: `Bearer ${data.tokens.access_token}`,
      'idempotency-key': randomUUID(),
    };
    const bind = () => client.post('/v1/me/inviter', { invite_code: CODE }, IP, headers);
    const response = await bind();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: 0 });
    await assertQualified(
      f.id,
      data.user_id,
      inviter,
      'backfill',
      f.crypto.blindIndex(IP, 'invite_rewards.bind_ip'),
      f.clock.now(),
    );
    expect((await bind()).json()).toMatchObject({ code: 0 });
    expect(
      await suite.kit.db
        .withSchema('app')
        .selectFrom('invite_reward_budgets')
        .select('reserved_fen')
        .where('app_id', '=', f.id)
        .where('period', '=', 'total')
        .executeTakeFirst(),
    ).toEqual({ reserved_fen: 2000n });
  });
});

it('[AC-B1-35#82] AppModule landing 通道同事务取得资格', async () => {
  const kit = await openLanding(
    suite.kit.db,
    suite.kit.database.urlFor('couli_app'),
    suite.server.url,
  );
  try {
    const f = await landingFixture(kit);
    for (const [key, value] of Object.entries(CONFIG)) await f.config(key, value);
    const body = await f.sms();
    landingAnswer(f, await f.post(body, { ip: IP }));
    const user = (await f.users()).find((u) => u.phone_hmac === f.hash(body.phone));
    expect(user).toBeDefined();
    await assertQualified(
      f.appId,
      user!.id,
      f.inviter,
      'landing',
      kit.crypto.blindIndex(IP, 'invite_rewards.bind_ip'),
      kit.clock.now(),
    );
  } finally {
    await kit.close();
  }
});

it('[AC-B1-35#83] AppModule 奖励 SQL 出错仍绑定成功并记录 error', async () => {
  const g = await growth();
  let calls = 0;
  const spy = vi.spyOn(g, 'createInviteRewardQualifier').mockImplementation(() => ({
    qualifyInviteReward: async (trx) => {
      calls++;
      await sql`select 1 / 0`.execute(trx);
    },
  }));
  try {
    await withHttp(suite, CONFIG, async (f) => {
      const inviter = await seedUser(suite.kit.db, f.id, {
        invite: CODE,
        phoneHmac: randomBytes(32).toString('hex'),
      });
      const { data } = await login(f);
      expect(calls).toBe(1);
      expect(
        await suite.kit.db
          .withSchema('app')
          .selectFrom('users')
          .select('parent_id')
          .where('app_id', '=', f.id)
          .where('id', '=', data.user_id)
          .executeTakeFirst(),
      ).toEqual({ parent_id: inviter });
      expect(
        await suite.kit.db
          .withSchema('app')
          .selectFrom('invite_rewards')
          .selectAll()
          .where('app_id', '=', f.id)
          .execute(),
      ).toEqual([]);
      expect(
        f.lines
          .map((line) => JSON.parse(line) as { level: number })
          .some((line) => line.level === 50),
      ).toBe(true);
      expect(f.lines.join('')).not.toContain(IP);
    });
  } finally {
    spy.mockRestore();
  }
});

it('[AC-B1-35#84] /v1/config 真实装配总预算端口，占用后 reward_enabled 关闭', async () => {
  await withHttp(suite, { ...CONFIG, 'growth.invite_reward.total_budget_fen': 2000 }, async (f) => {
    const get = () =>
      f.app.inject({
        method: 'GET',
        url: '/v1/config',
        headers: { 'x-app-id': f.id, 'x-platform': 'ios', 'x-app-version': '2.0.0' },
      });
    const initial = await get();
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      code: 0,
      data: { invite: { reward_enabled: true, reward_amount_fen: 1000 } },
    });
    await seedUser(suite.kit.db, f.id, {
      invite: CODE,
      phoneHmac: randomBytes(32).toString('hex'),
    });
    await login(f);
    expect((await get()).json()).toMatchObject({
      code: 0,
      data: { invite: { reward_enabled: false, reward_amount_fen: 1000 } },
    });
  });
});

it('[AC-B1-35#85] AppModule 两个注册争最后预算，均绑定成功但只有一个资格', async () => {
  await withHttp(suite, { ...CONFIG, 'growth.invite_reward.total_budget_fen': 2000 }, async (f) => {
    await seedUser(suite.kit.db, f.id, {
      invite: CODE,
      phoneHmac: randomBytes(32).toString('hex'),
    });
    const users = await Promise.all([login(f), login(f)]);
    expect(new Set(users.map((u) => u.data.user_id)).size).toBe(2);
    expect(
      await suite.kit.db
        .withSchema('app')
        .selectFrom('invite_rewards')
        .selectAll()
        .where('app_id', '=', f.id)
        .execute(),
    ).toHaveLength(1);
    expect(
      await suite.kit.db
        .withSchema('app')
        .selectFrom('invite_reward_budgets')
        .select('reserved_fen')
        .where('app_id', '=', f.id)
        .where('period', '=', 'total')
        .executeTakeFirst(),
    ).toEqual({ reserved_fen: 2000n });
  });
});

it('[AC-B1-35#86] AppModule 活动关闭的绑定无资格，重开后只给新绑定', async () => {
  await withHttp(suite, { ...CONFIG, 'growth.invite_reward.enabled': false }, async (f) => {
    await seedUser(suite.kit.db, f.id, {
      invite: CODE,
      phoneHmac: randomBytes(32).toString('hex'),
    });
    const first = await login(f);
    expect(
      await suite.kit.db
        .withSchema('app')
        .selectFrom('invite_rewards')
        .selectAll()
        .where('app_id', '=', f.id)
        .execute(),
    ).toEqual([]);
    await config(f.id, 'growth.invite_reward.enabled', true);
    const second = await login(f);
    const rows = await suite.kit.db
      .withSchema('app')
      .selectFrom('invite_rewards')
      .select('invitee_id')
      .where('app_id', '=', f.id)
      .execute();
    expect(rows).toEqual([{ invitee_id: second.data.user_id }]);
    expect(second.data.user_id).not.toBe(first.data.user_id);
  });
});
