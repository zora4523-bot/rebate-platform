import { randomUUID } from 'node:crypto';
import { createDb, destroyDb } from '@couli/db';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { api } from '../../identity/landing-sms/kit.ts';
import {
  answer,
  CODE,
  fixture,
  IP,
  noAccount,
  NOW,
  openKit,
  phone,
  registered,
  type Kit,
} from './kit.ts';

let server: Awaited<ReturnType<typeof acquireTestRedis>> | undefined;
let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let kit: Kit;
beforeAll(async () => {
  server = await acquireTestRedis();
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  kit = await openKit(db, database.urlFor('couli_app'), server.url);
}, 180_000);
afterAll(async () => {
  try {
    await kit?.close();
  } finally {
    try {
      if (db) await destroyDb(db);
      await database?.drop();
    } finally {
      await server?.stop();
    }
  }
}, 120_000);

it('[AC-B1-11h#2] 新号规范化并绑定，同事务记录两份协议与一条关系，不收设备不签发令牌', async () => {
  const f = await fixture(kit);
  const body = await f.sms();
  const start = kit.lines.length;
  answer(
    f,
    await f.post(
      {
        ...body,
        phone: `＋８６\u3000${body.phone}\u200b`,
        invite_code: ' ｋ７\u200bｑ２\u200cｍｚ\u200d\ufeff ',
        channel: 'official',
      },
      { headers: { 'x-channel': 'appstore' } },
    ),
  );
  await registered(f, body.phone, 'official');
  const logs = kit.lines.slice(start).join('');
  for (const secret of [body.phone, f.hash(body.phone), IP, body.sms_code, CODE])
    expect(logs).not.toContain(secret);
});

for (const channel of [undefined, 'appstore']) {
  it(`[AC-B1-11h#3] 未给 body channel 时使用头或 NULL：${String(channel)}`, async () => {
    const f = await fixture(kit);
    const body = await f.sms();
    answer(f, await f.post(body, { headers: channel ? { 'x-channel': channel } : {} }));
    await registered(f, body.phone, channel ?? null);
  });
}

it('[AC-B1-11h#4] schema 在 agreed 之前；额外身份字段被拒绝且不消费短信', async () => {
  const f = await fixture(kit);
  const body = await f.sms();
  for (const extra of [
    { app_id: 'other' },
    { device_id: randomUUID() },
    { captcha_token: 'unused' },
    { user_id: randomUUID() },
  ]) {
    answer(f, await f.post({ ...body, agreed: false, ...extra }), 20001);
  }
  expect(await f.idempotency()).toEqual([]);
  answer(f, await f.post(body));
  await registered(f, body.phone);
});

it('[AC-B1-11h#5] 10004 先于手机号、幂等与开关；1xxxx 不落库、不消费短信、不计邀请码失败', async () => {
  const f = await fixture(kit);
  const body = await f.sms();
  await f.config('growth.invite_bind.enabled', false);
  for (let n = 0; n < 6; n++) {
    const result = answer(
      f,
      await f.post({ ...body, agreed: false, phone: 'invalid', invite_code: '' }),
      10004,
    );
    expect(result['data']).toEqual({ consent_type: 'agreement' });
  }
  expect(await f.idempotency()).toEqual([]);
  await noAccount(f, body.phone);
  await f.config('growth.invite_bind.enabled', true);
  answer(f, await f.post(body));
});

it('[AC-B1-11h#6] 不合法手机号在幂等与开关之前 20001，不计 30401 且不核销验证码', async () => {
  const f = await fixture(kit);
  const body = await f.sms();
  await f.config('growth.invite_bind.enabled', false);
  for (let n = 0; n < 6; n++) {
    const result = answer(
      f,
      await f.post({ ...body, phone: 'invalid', invite_code: '' }),
      20001,
    );
    expect(result['data']).toEqual({ fields: ['phone'], reason: 'phone_invalid' });
  }
  expect(await f.idempotency()).toEqual([]);
  await f.config('growth.invite_bind.enabled', true);
  answer(f, await f.post(body));
});

for (const key of [null, 'bad key']) {
  it(`[AC-B1-11h#7] 缺失或坏幂等键先于业务开关，不核销：${String(key)}`, async () => {
    const f = await fixture(kit);
    const body = await f.sms();
    await f.config('growth.invite_bind.enabled', false);
    answer(f, await f.post(body, { key }), 20001);
    expect(await f.idempotency()).toEqual([]);
    await f.config('growth.invite_bind.enabled', true);
    answer(f, await f.post(body));
  });
}

it('[AC-B1-11h#8] 开关 30408 先于坏邀请码与验证码；同键回放、新键可继续且短信未消费', async () => {
  const f = await fixture(kit);
  const body = await f.sms();
  const key = randomUUID();
  await f.config('growth.invite_bind.enabled', false);
  const first = answer(
    f,
    await f.post({ ...body, invite_code: '', sms_code: 'bad' }, { key }),
    30408,
  );
  await f.config('growth.invite_bind.enabled', true);
  expect(
    answer(f, await f.post({ ...body, invite_code: '', sms_code: 'bad' }, { key }), 30408),
  ).toEqual(first);
  expect(await f.idempotency()).toHaveLength(1);
  answer(f, await f.post(body));
});

for (const invite of [
  '',
  '\u3000\u200b\u200c\u200d\ufeff',
  'K7Q2M',
  'K7Q2MZZ',
  'I0O1LL',
  'R8W3NX',
]) {
  it(`[AC-B1-11h#9] 空、格式错误与不存在的邀请码都 30401，不核销同一个短信码：${JSON.stringify(invite)}`, async () => {
    const f = await fixture(kit);
    const body = await f.sms();
    const result = answer(f, await f.post({ ...body, invite_code: invite }), 30401);
    expect(result['msg']).toBe('邀请码无效');
    await noAccount(f, body.phone);
    answer(f, await f.post(body));
  });
}

for (const state of ['banned', 'appealing', 'frozen', 'deleted', 'no_phone'] as const) {
  it(`[AC-B1-11h#10] 邀请人不可用先于短信校验，统一 30401：${state}`, async () => {
    const f = await fixture(kit);
    const body = await f.sms();
    if (state === 'deleted' || state === 'no_phone') {
      await kit.db
        .updateTable('users')
        .set(state === 'deleted' ? { status: 'deleted' } : { phone_hmac: null })
        .where('id', '=', f.inviter)
        .execute();
    } else await f.risk(state);
    const result = answer(f, await f.post({ ...body, sms_code: 'bad' }), 30401);
    expect(result['msg']).toBe('邀请码无效');
    // Restore only the fixture's facts, then use the original real login code through HTTP.
    if (state === 'deleted' || state === 'no_phone') {
      await kit.db
        .updateTable('users')
        .set({ status: 'normal', phone_hmac: f.hash(phone()) })
        .where('id', '=', f.inviter)
        .execute();
    } else {
      await kit.db
        .updateTable('user_risk_state')
        .set({ state: 'normal', frozen_until: null })
        .where('user_id', '=', f.inviter)
        .execute();
    }
    answer(f, await f.post(body));
  });
}

for (const dimension of ['phone', 'ip'] as const) {
  it(`[AC-B1-11h#11] ${dimension} 独立累计五次 30401 后先返回 42901，+08 午夜重置`, async () => {
    const f = await fixture(kit);
    kit.clock.set('2026-10-18T23:59:30+08:00');
    const body = await f.sms();
    for (let n = 0; n < 5; n++) {
      answer(
        f,
        await f.post(
          {
            ...body,
            phone: dimension === 'phone' ? body.phone : phone(),
            invite_code: n % 2 ? '' : 'R8W3NX',
          },
          { ip: dimension === 'phone' ? `203.0.113.${n + 1}` : IP },
        ),
        30401,
      );
    }
    const request = dimension === 'phone' ? { ...body, phone: `0086${body.phone}` } : body;
    const response = await f.post(request, { ip: dimension === 'phone' ? '192.0.2.99' : IP });
    answer(f, response, 42901);
    expect(String(response.headers['retry-after'])).toBe('30');
    expect(await f.idempotency()).toHaveLength(5);
    await f.config('growth.invite_bind.enabled', false);
    answer(f, await f.post(request), 30408);
    await f.config('growth.invite_bind.enabled', true);
    kit.clock.set('2026-10-19T00:00:00+08:00');
    answer(f, await f.post(request));
    await registered(f, body.phone);
  });
}

it('[AC-B1-11h#12] 30401 回放不重复计数，同键不同请求 20901；第六个独立失败才被频控', async () => {
  const f = await fixture(kit);
  const body = await f.sms();
  const bad = { ...body, invite_code: '' };
  const key = randomUUID();
  const original = answer(f, await f.post(bad, { key }), 30401);
  for (let n = 0; n < 6; n++)
    expect(answer(f, await f.post(bad, { key }), 30401)).toEqual(original);
  answer(f, await f.post(body, { key }), 20901);
  for (let n = 0; n < 4; n++) answer(f, await f.post(bad), 30401);
  answer(f, await f.post(body), 42901);
  expect(await f.idempotency()).toHaveLength(5);
});

it('[AC-B1-11h#13] 已注册仍先检查邀请码与短信；20002/20003 不存，之后仍能注册结果回放', async () => {
  const f = await fixture(kit);
  const body = await f.sms();
  await f.seed({ number: body.phone });
  const before = await f.users();
  answer(f, await f.post({ ...body, invite_code: '' }), 30401);
  const key = randomUUID();
  const wrong = body.sms_code === '000000' ? '000001' : '000000';
  answer(f, await f.post({ ...body, sms_code: wrong }, { key }), 20002);
  kit.clock.advanceMs(300_000);
  answer(f, await f.post(body, { key }), 20003);
  expect(await f.idempotency()).toHaveLength(1);
  const fresh = await f.sms(body.phone);
  const first = answer(f, await f.post(fresh, { key }), 0, 'already_registered');
  expect(answer(f, await f.post(fresh, { key }), 0, 'already_registered')).toEqual(first);
  expect(await f.users()).toEqual(before);
  expect(await f.relations()).toEqual([]);
  expect(await f.consents()).toEqual([]);
  expect(await f.registrations()).toEqual([]);
});

it('[AC-B1-11h#14] 已有关系与自助次数绝不覆盖；已注册先于号码黑名单和 IP 上限', async () => {
  const f = await fixture(kit);
  await f.config('landing.ip_register_limit', 1);
  const first = await f.sms();
  answer(f, await f.post(first));
  const againPhone = phone();
  const uid = await f.seed({ number: againPhone });
  await kit.db
    .updateTable('users')
    .set({
      parent_id: f.inviter,
      parent_bind_source: 'register',
      parent_bound_at: kit.clock.now(),
      self_bind_used: true,
    })
    .where('id', '=', uid)
    .execute();
  const body = await f.sms(againPhone);
  await f.blocked(againPhone);
  const before = {
    users: await f.users(),
    consents: await f.consents(),
    relations: await f.relations(),
    registrations: await f.registrations(),
  };
  answer(f, await f.post(body), 0, 'already_registered');
  expect({
    users: await f.users(),
    consents: await f.consents(),
    relations: await f.relations(),
    registrations: await f.registrations(),
  }).toEqual(before);
});

for (const clearPhone of [true, false]) {
  it(`[AC-B1-11h#15] status=deleted 墓碑不占手机号，原墓碑不变：phone_hmac 已清空=${clearPhone}`, async () => {
    const f = await fixture(kit);
    const body = await f.sms();
    const old = await f.seed({ number: body.phone, status: 'deleted' });
    // 注销表尚未建；本任务按 users.status 判定，部分唯一索引也排除 deleted。
    if (clearPhone)
      await kit.db.updateTable('users').set({ phone_hmac: null }).where('id', '=', old).execute();
    const tombstone = (await f.users()).find((u) => u.id === old);
    answer(f, await f.post(body));
    const user = await registered(f, body.phone);
    expect(user.id).not.toBe(old);
    expect((await f.users()).find((u) => u.id === old)).toEqual(tombstone);
  });
}

it('[AC-B1-11h#16] 黑名单在已注册之后、IP 限额之前，44001 已核销且不保存幂等', async () => {
  const f = await fixture(kit);
  await f.config('landing.ip_register_limit', 1);
  answer(f, await f.post(await f.sms()));
  const body = await f.sms();
  await f.blocked(body.phone);
  const key = randomUUID();
  const result = answer(f, await f.post(body, { key }), 44001);
  expect(result['data']).toEqual({ risk_msg_code: 'blocklist.other' });
  answer(f, await f.post(body, { key }), 20003);
  expect((await f.users()).filter((u) => u.phone_hmac === f.hash(body.phone))).toEqual([]);
  expect(await f.registrations()).toHaveLength(1);
  expect(await f.idempotency()).toHaveLength(1);
});

it('[AC-B1-11h#17] 默认三号上限闭区间：10:00、10:20、10:40 成功，11:00 仍拒绝、11:00:01 放行', async () => {
  const f = await fixture(kit);
  for (const time of ['10:00:00', '10:20:00', '10:40:00']) {
    kit.clock.set(`2026-10-18T${time}+08:00`);
    answer(f, await f.post(await f.sms()));
  }
  for (const time of ['10:50:00', '11:00:00']) {
    kit.clock.set(`2026-10-18T${time}+08:00`);
    const body = await f.sms();
    const key = randomUUID();
    expect(answer(f, await f.post(body, { key }), 44001)['data']).toEqual({ risk_msg_code: null });
    answer(f, await f.post(body, { key }), 20003);
    expect((await f.users()).filter((u) => u.phone_hmac === f.hash(body.phone))).toEqual([]);
    expect(await f.registrations()).toHaveLength(3);
    expect(await f.idempotency()).toHaveLength(3);
  }
  kit.clock.set('2026-10-18T11:00:01+08:00');
  answer(f, await f.post(await f.sms()));
  expect(await f.registrations()).toHaveLength(4);
});

it('[AC-B1-11h#18] 两次成功、三次 already_registered、两次 20002 只计二，第三个新号可注册', async () => {
  const f = await fixture(kit);
  const existing = phone();
  for (const number of [existing, phone()]) answer(f, await f.post(await f.sms(number)));
  for (let n = 0; n < 3; n++) {
    kit.clock.advanceMs(60_000);
    answer(f, await f.post(await f.sms(existing)), 0, 'already_registered');
  }
  const body = await f.sms();
  for (let n = 0; n < 2; n++)
    answer(
      f,
      await f.post({ ...body, sms_code: body.sms_code === '000000' ? '000001' : '000000' }),
      20002,
    );
  expect(await f.registrations()).toHaveLength(2);
  answer(f, await f.post(body));
  expect(await f.registrations()).toHaveLength(3);
});

it('[AC-B1-11h#19] registered 同键完整回放，不再核销或建号，主体为规范化号码的 p:HMAC', async () => {
  const f = await fixture(kit);
  const body = { ...(await f.sms()), channel: 'landing' };
  const alias = { ...body, phone: `0086${body.phone}` };
  const key = randomUUID();
  const original = answer(f, await f.post(alias, { key }));
  await f.config('growth.invite_bind.enabled', false);
  expect(answer(f, await f.post(alias, { key }))).toEqual(original);
  answer(f, await f.post({ ...alias, channel: 'changed' }, { key }), 20901);
  await registered(f, body.phone, 'landing');
  const rows = await f.idempotency();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    subject: `p:${f.hash(body.phone)}`,
    user_id: null,
    method: 'POST',
    key,
    status: 'completed',
    request_hash: expect.stringMatching(/^hmac1:/),
  });
});

for (const value of [undefined, 0, -1, 1.5, '7', null]) {
  it(`[AC-B1-11h#20] legal 缺失或非法时 50001，不存幂等也不消费短信：${String(value)}`, async () => {
    const f = await fixture(kit, false);
    const body = await f.sms();
    await f.config('legal.privacy.version', 11);
    if (value !== undefined) await f.config('legal.agreement.version', value);
    const key = randomUUID();
    answer(f, await f.post(body, { key }), 50001);
    expect(await f.idempotency()).toEqual([]);
    await noAccount(f, body.phone);
    await f.config('legal.agreement.version', 7);
    answer(f, await f.post(body, { key }));
  });
}

for (const value of [0, -1, 1.5, '3']) {
  it(`[AC-B1-11h#21] 非法 landing.ip_register_limit 回退三且警告不泄露数据：${String(value)}`, async () => {
    const f = await fixture(kit);
    await f.config('landing.ip_register_limit', value);
    const start = kit.lines.length;
    const numbers: string[] = [];
    for (let n = 0; n < 3; n++) {
      const body = await f.sms();
      numbers.push(body.phone);
      answer(f, await f.post(body));
    }
    const blocked = await f.sms();
    numbers.push(blocked.phone);
    answer(f, await f.post(blocked), 44001);
    const warnings = kit.lines
      .slice(start)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['level'] === 40 && line['config_key'] === 'landing.ip_register_limit');
    expect(warnings.length).toBeGreaterThan(0);
    expect(await f.registrations()).toHaveLength(3);
    const logs = kit.lines.slice(start).join('');
    for (const secret of [
      ...numbers.flatMap((number) => [
        number,
        f.hash(number),
        `${number.slice(0, 3)}****${number.slice(-4)}`,
      ]),
      IP,
      '198.51.100.19',
      kit.crypto.blindIndex(IP, 'invite_fail.ip'),
      ...(await f.registrations()).map((row) => row.ip_hmac),
    ])
      expect(logs).not.toContain(secret);
    for (const warning of warnings)
      expect(Object.keys(warning).join(' ')).not.toMatch(
        /phone|\bip\b|ip_hmac|ip_hash|client_ip|remoteAddress/i,
      );
  });
}

it('[AC-B1-11h#22] app_id 隔离邀请码、短信、幂等主体和 IP 计数', async () => {
  const a = await fixture(kit);
  const b = await fixture(kit);
  await a.config('landing.ip_register_limit', 1);
  await b.config('landing.ip_register_limit', 1);
  const bodyA = await a.sms();
  const key = randomUUID();
  answer(b, await b.post(bodyA, { key }), 20003);
  answer(a, await a.post(bodyA, { key }));
  answer(a, await a.post(await a.sms()), 44001);
  const bodyB = await b.sms(bodyA.phone);
  answer(b, await b.post(bodyB, { key }));
  expect(await a.registrations()).toHaveLength(1);
  expect(await b.registrations()).toHaveLength(1);
  await registered(b, bodyA.phone);
  kit.clock.set(NOW);
});

for (const birth of ['2008-10-18', '2008-10-19']) {
  it(`[AC-B1-11h#28] 实名邀请人按判定时刻满十八岁方可用：${birth}`, async () => {
    const f = await fixture(kit);
    const body = await f.sms();
    const { FIELD_CRYPTO } = await api<{ FIELD_CRYPTO: symbol }>('modules/platform/index.ts');
    const crypto =
      kit.app.get<import('../../../../apps/api/src/modules/platform/crypto/index.ts').FieldCrypto>(
        FIELD_CRYPTO,
      );
    const cipher = (value: string, context: string) => Buffer.from(crypto.encrypt(value, context));
    await kit.db
      .insertInto('realname')
      .values({
        id: randomUUID(),
        app_id: f.appId,
        user_id: f.inviter,
        status: 'verified',
        name_cipher: cipher('测试', 'realname.name'),
        id_no_cipher: cipher('fixture-identity', 'realname.id_no'),
        id_no_hmac: kit.crypto.blindIndex('fixture-identity', 'realname.id_no'),
        birth_date_cipher: cipher(birth, 'realname.birth_date'),
        provider: 'test-two-elements',
        verified_at: kit.clock.now(),
        created_at: kit.clock.now(),
        updated_at: kit.clock.now(),
      })
      .execute();
    answer(f, await f.post(body), birth === '2008-10-18' ? 0 : 30401);
    if (birth !== '2008-10-18') await noAccount(f, body.phone);
  });
}

it('[AC-B1-11h#29] 邀请码查询必须限定 app_id，不可借用其他应用的邀请人', async () => {
  const a = await fixture(kit);
  const b = await fixture(kit);
  await kit.db
    .updateTable('users')
    .set({ invite_code: 'R8W3NX' })
    .where('id', '=', b.inviter)
    .execute();
  const body = await b.sms();
  answer(b, await b.post(body), 30401);
  answer(b, await b.post({ ...body, invite_code: 'R8W3NX' }));
  await registered(b, body.phone);
  expect(await a.relations()).toEqual([]);
});

it('[AC-B1-11h#30] 30401 phone 键与其他渠道共用 invite_fail 命名空间，并且两个维度都各计一次', async () => {
  const f = await fixture(kit);
  const body = await f.sms();
  answer(f, await f.post({ ...body, invite_code: '' }), 30401);
  type RedisModule = typeof import('../../../../apps/api/src/modules/platform/redis/index.ts');
  const { REDIS } = await api<{ REDIS: symbol }>('modules/platform/index.ts');
  const redis = kit.app
    .get<NonNullable<Awaited<ReturnType<RedisModule['createRedisHandle']>>>>(REDIS)
    .namespace('invite_fail');
  expect(await redis.get(`${f.appId}:2026-10-18:${f.hash(body.phone)}`)).toBe('1');
  // Four more failures use different phones, so only the independent IP budget is exhausted.
  for (let n = 0; n < 4; n++)
    answer(f, await f.post({ ...body, phone: phone(), invite_code: '' }), 30401);
  answer(f, await f.post(body), 42901);
  expect(await redis.get(`${f.appId}:2026-10-18:${f.hash(body.phone)}`)).toBe('1');
  answer(f, await f.post(body, { ip: '192.0.2.100' }));
});

for (const [key, value] of [
  ['growth.invite_bind.enabled', 'invalid'],
  ['invite.fail_limit_per_day', 0],
] as const) {
  it(`[AC-B1-11h#31] growth 非法配置 ${key} 返回 50001，不存结果、计数或核销`, async () => {
    const f = await fixture(kit);
    const body = await f.sms();
    await f.config(key, value);
    const idempotencyKey = randomUUID();
    answer(f, await f.post(body, { key: idempotencyKey }), 50001);
    expect(await f.idempotency()).toEqual([]);
    await noAccount(f, body.phone);
    await f.config(key, key === 'growth.invite_bind.enabled' ? true : 5);
    answer(f, await f.post(body, { key: idempotencyKey }));
  });
}

it('[AC-B1-11h#34] 同 IP 窗口不包含未来记录，不同 IP 的成功记录也不占本 IP 名额', async () => {
  const f = await fixture(kit);
  await f.config('landing.ip_register_limit', 1);
  kit.clock.set('2026-10-18T11:00:00+08:00');
  answer(f, await f.post(await f.sms()));
  kit.clock.set('2026-10-18T10:59:59+08:00');
  answer(f, await f.post(await f.sms()));
  answer(f, await f.post(await f.sms(), { ip: '192.0.2.101' }));
  expect(await f.registrations()).toHaveLength(3);
});
