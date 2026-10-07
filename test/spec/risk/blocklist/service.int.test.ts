import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createBlocklistService,
  blocklistHmacContexts,
  type BlocklistDimension,
} from '../../../../apps/api/src/modules/risk/index.ts';
import {
  closeKit,
  expectRegistrationHit,
  hits,
  openKit,
  PHONE,
  phoneHmac,
  seedBlock,
  seedUser,
  setup,
  UUID_V7,
  type Kit,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

const dimensions: BlocklistDimension[] = [
  'phone',
  'id_no',
  'alipay',
  'bank_card',
  'wechat_openid',
  'device',
  'relation_id',
];

it.each(dimensions)(
  '[AC-B1-03d#1][BR-ID-31/36] %s 按预计算 HMAC 命中且补登记规则',
  async (dimension) => {
    const f = await setup(kit);
    const digest = randomBytes(32).toString('hex');
    await seedBlock(kit.db, f.appId, dimension, digest, f.clock);
    const result = await createBlocklistService(f.options).check({
      app_id: f.appId,
      dimension,
      value_hmac: digest,
      related_phone: PHONE,
      request_type: 'register',
    });
    expect(result).toMatchObject({
      code: 44001,
      data: { risk_msg_code: 'blocklist.fraud_invite' },
    });
    const row = await expectRegistrationHit(kit.db, {
      app: f.appId,
      crypto: kit.crypto,
      clock: f.clock,
      phone: PHONE,
      dimension,
      value_hmac: digest,
      rule: `BLACKLIST_${dimension.toUpperCase()}`,
    });
    expect(result?.ref_id).toBe(row.ref_id);
    expect(JSON.stringify(result)).not.toContain('fixture reason');
  },
);

it('[AC-B1-03d#2][BR-ID-31/33] 明文入口经 blindIndex，手机号沿用 users.phone，其他维度上下文稳定且分离', async () => {
  const f = await setup(kit);
  const blindIndex = vi.fn(kit.crypto.blindIndex.bind(kit.crypto));
  const service = createBlocklistService({ ...f.options, crypto: { ...kit.crypto, blindIndex } });
  // F1-10 and B2 must use this public source of contexts when registering account values.
  const sharedContexts = blocklistHmacContexts();
  expect(sharedContexts.phone).toBe('users.phone');
  const contexts: string[] = [];
  for (const dimension of dimensions.filter((d) => d !== 'device')) {
    const value = dimension === 'phone' ? PHONE : `private-${dimension}-fixture`;
    blindIndex.mockClear();
    expect(await service.check({ ...f.input, dimension, value })).toBeNull();
    const call = blindIndex.mock.calls.find(([raw]) => raw === value);
    expect(call, `${dimension} must hash the supplied value`).toBeDefined();
    const context = call![1];
    expect(context).toEqual(expect.any(String));
    expect(context.length).toBeGreaterThan(0);
    expect(context).toBe(sharedContexts[dimension]);
    if (dimension === 'phone') expect(context).toBe('users.phone');
    contexts.push(context);
    const digest = kit.crypto.blindIndex(value, context);
    await seedBlock(kit.db, f.appId, dimension, digest, f.clock);
    expect(await service.check({ ...f.input, dimension, value })).toMatchObject({ code: 44001 });
    const row = (await hits(kit.db, f.appId)).find((r) => r.dimension === dimension);
    expect(row?.value_hmac).toBe(digest);
    expect(JSON.stringify(row)).not.toContain(value);
    expect(f.lines.join('')).not.toContain(value);
  }
  expect(new Set(contexts).size).toBe(contexts.length);
  expect(f.lines.join('')).not.toContain(PHONE);
});

it('[AC-B1-03d#3][BR-ID-31] 设备哈希直接匹配，不再次 HMAC', async () => {
  const f = await setup(kit);
  await seedBlock(kit.db, f.appId, 'device', f.hash, f.clock);
  const blindIndex = vi.fn(kit.crypto.blindIndex.bind(kit.crypto));
  const result = await createBlocklistService({
    ...f.options,
    crypto: { ...kit.crypto, blindIndex },
  }).check({ ...f.input, dimension: 'device', value: f.hash });
  expect(result).toMatchObject({ code: 44001 });
  expect(blindIndex.mock.calls.some(([value]) => value === f.hash)).toBe(false);
  expect((await hits(kit.db, f.appId))[0]?.value_hmac).toBe(f.hash);
});

it.each([
  { status: 'inactive' as const, offset: 1, blocked: false },
  { status: 'active' as const, offset: -1, blocked: false },
  { status: 'active' as const, offset: 0, blocked: false },
  { status: 'active' as const, offset: 1, blocked: true },
])(
  '[AC-B1-03d#4][BR-ID-31] $status / 到期偏移 $offset 毫秒严格使用 Clock',
  async ({ status, offset, blocked }) => {
    const f = await setup(kit);
    // Deliberately unrelated to wall time; comparisons and audit timestamps use this Clock.
    f.clock.set(new Date('2042-01-02T03:04:05.678Z'));
    await seedBlock(kit.db, f.appId, 'phone', phoneHmac(kit.crypto), f.clock, {
      status,
      expires: new Date(f.clock.now().getTime() + offset),
    });
    const result = await createBlocklistService(f.options).check(f.input);
    if (blocked) {
      expect(result).toMatchObject({ code: 44001 });
      expect((await hits(kit.db, f.appId))[0]?.created_at).toEqual(f.clock.now());
    } else {
      expect(result).toBeNull();
      expect(await hits(kit.db, f.appId)).toEqual([]);
    }
  },
);

it('[AC-B1-03d#5][BR-ID-31] 同值有失效条目也检查有效条目，同规则只记一次', async () => {
  const f = await setup(kit);
  const digest = phoneHmac(kit.crypto);
  await seedBlock(kit.db, f.appId, 'phone', digest, f.clock, { status: 'inactive' });
  await seedBlock(kit.db, f.appId, 'phone', digest, f.clock, { expires: f.clock.now() });
  await seedBlock(kit.db, f.appId, 'phone', digest, f.clock);
  await seedBlock(kit.db, f.appId, 'phone', digest, f.clock);
  expect(await createBlocklistService(f.options).check(f.input)).toMatchObject({ code: 44001 });
  expect(await hits(kit.db, f.appId)).toHaveLength(1);
});

it('[AC-B1-03d#6][BR-ID-31] app_id、维度和值必须全部匹配，未命中不留 risk_hits', async () => {
  const f = await setup(kit);
  const digest = phoneHmac(kit.crypto);
  await seedBlock(kit.db, `${f.appId}_other`, 'phone', digest, f.clock);
  await seedBlock(kit.db, f.appId, 'alipay', digest, f.clock);
  await seedBlock(kit.db, f.appId, 'phone', phoneHmac(kit.crypto, '13987654321'), f.clock);
  expect(await createBlocklistService(f.options).check(f.input)).toBeNull();
  expect(await hits(kit.db, f.appId)).toEqual([]);
  expect(await hits(kit.db, `${f.appId}_other`)).toEqual([]);
});

it.each(['absent', 'deleted'])(
  '[AC-B1-03d#7][BR-ID-31] users 为 %s 仍然拦截注册且 user_id 为空',
  async (state) => {
    const f = await setup(kit);
    if (state === 'deleted')
      await seedUser(kit.db, f.appId, { status: 'deleted', phoneHmac: phoneHmac(kit.crypto) });
    await seedBlock(kit.db, f.appId, 'phone', phoneHmac(kit.crypto), f.clock);
    expect(await createBlocklistService(f.options).check(f.input)).toMatchObject({ code: 44001 });
    expect((await hits(kit.db, f.appId))[0]?.user_id).toBeNull();
  },
);

it.each(['malicious_rights', 'fraud_invite', 'other'] as const)(
  '[AC-B1-03d#8][BR-ID-31][04 §7] %s 仅返回提示编码，不泄露登记原因与明文',
  async (violation) => {
    const f = await setup(kit);
    await seedBlock(kit.db, f.appId, 'phone', phoneHmac(kit.crypto), f.clock, { violation });
    const result = await createBlocklistService(f.options).check(f.input);
    expect(result?.data).toEqual({ risk_msg_code: `blocklist.${violation}` });
    expect(JSON.stringify(result)).not.toContain(PHONE);
    expect(JSON.stringify(result)).not.toContain('fixture reason');
    expect(f.lines.join('')).not.toContain(PHONE);
  },
);

it('[AC-B1-03d#9][BR-ID-36] 同请求多维度共用 UUIDv7，不同请求独立编号', async () => {
  const f = await setup(kit);
  await seedBlock(kit.db, f.appId, 'phone', phoneHmac(kit.crypto), f.clock);
  await seedBlock(kit.db, f.appId, 'device', f.hash, f.clock);
  const service = createBlocklistService(f.options);
  const first = await service.check(f.input);
  expect(first?.ref_id).toMatch(UUID_V7);
  const second = await service.check({
    ...f.input,
    dimension: 'device',
    value: f.hash,
    ref_id: first!.ref_id,
  });
  const third = await service.check(f.input);
  expect(second?.ref_id).toBe(first?.ref_id);
  expect(third?.ref_id).toMatch(UUID_V7);
  expect(third?.ref_id).not.toBe(first?.ref_id);
  expect((await hits(kit.db, f.appId)).map((r) => r.ref_id)).toEqual([
    first?.ref_id,
    first?.ref_id,
    third?.ref_id,
  ]);
});

it('[AC-B1-03d#10][BR-ID-36] 外层事务回滚，独立短事务写入的命中和规则仍存在', async () => {
  const f = await setup(kit);
  await seedBlock(kit.db, f.appId, 'phone', phoneHmac(kit.crypto), f.clock);
  const service = createBlocklistService(f.options);
  const rollback = new Error('spec rollback');
  await expect(
    kit.db.transaction().execute(async (trx) => {
      await seedUser(trx, f.appId);
      expect(await service.check(f.input)).toMatchObject({ code: 44001 });
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  const users = await sql<{
    count: number;
  }>`SELECT count(*)::int AS count FROM app.users WHERE app_id = ${f.appId}`.execute(kit.db);
  expect(users.rows[0]?.count).toBe(0);
  await expectRegistrationHit(kit.db, {
    app: f.appId,
    crypto: kit.crypto,
    clock: f.clock,
    phone: PHONE,
    dimension: 'phone',
    value_hmac: phoneHmac(kit.crypto),
    rule: 'BLACKLIST_PHONE',
  });
});

it('[AC-B1-03d#11][BR-ID-36] 并发首次命中补登记规则不冲突，每次请求留下独立记录', async () => {
  const f = await setup(kit);
  await seedBlock(kit.db, f.appId, 'phone', phoneHmac(kit.crypto), f.clock);
  const service = createBlocklistService(f.options);
  const results = await Promise.all(Array.from({ length: 4 }, () => service.check(f.input)));
  expect(results.every((r) => r?.code === 44001)).toBe(true);
  expect(new Set(results.map((r) => r?.ref_id)).size).toBe(4);
  expect(await hits(kit.db, f.appId)).toHaveLength(4);
  const rules = await sql<{
    count: number;
  }>`SELECT count(*)::int AS count FROM app.risk_rules WHERE app_id = ${f.appId} AND rule_id = 'BLACKLIST_PHONE'`.execute(
    kit.db,
  );
  expect(rules.rows[0]?.count).toBe(1);
});

it.each(['withdraw', 'phone_change', 'payout_account'] as const)(
  '[AC-B1-03d#12][BR-ID-36] 公共服务保存 %s 请求类型、用户、手机号及整数分金额',
  async (request_type) => {
    const f = await setup(kit);
    const user = await seedUser(kit.db, f.appId);
    await seedBlock(kit.db, f.appId, 'phone', phoneHmac(kit.crypto), f.clock);
    const amount = 9007199254740993n;
    expect(
      await createBlocklistService(f.options).check({
        ...f.input,
        request_type,
        user_id: user,
        ...(request_type === 'withdraw' ? { amount_fen: amount } : {}),
      }),
    ).toMatchObject({ code: 44001 });
    expect((await hits(kit.db, f.appId))[0]).toMatchObject({
      user_id: user,
      request_type,
      related_phone_hmac: phoneHmac(kit.crypto),
      related_phone_masked: '138****5678',
      amount_fen: request_type === 'withdraw' ? amount : null,
    });
  },
);

it.each([
  { dimension: 'phone_prefix', rule_id: 'SMS_BLOCKED_PREFIX' },
  { dimension: 'device', rule_id: 'DEVICE_REGISTER_LIMIT' },
])(
  '[AC-B1-03d#13][BR-ID-05/36] recordHit 记录已有的 $rule_id 判定，不重新查黑名单',
  async ({ dimension, rule_id }) => {
    const f = await setup(kit);
    const digest = dimension === 'device' ? f.hash : phoneHmac(kit.crypto);
    const result = await createBlocklistService(f.options).recordHit({
      app_id: f.appId,
      request_type: 'register',
      related_phone: PHONE,
      dimension,
      rule_id,
      value_hmac: digest,
    });
    expect(result.ref_id).toMatch(UUID_V7);
    const row = await expectRegistrationHit(kit.db, {
      app: f.appId,
      crypto: kit.crypto,
      clock: f.clock,
      phone: PHONE,
      dimension,
      value_hmac: digest,
      rule: rule_id,
    });
    expect(row.ref_id).toBe(result.ref_id);
  },
);

it.each([
  { scenario: '仅手机号', phone: true, device: false, withDevice: true },
  { scenario: '仅设备', phone: false, device: true, withDevice: true },
  { scenario: '手机号与设备同时', phone: true, device: true, withDevice: true },
  { scenario: '均未', phone: false, device: false, withDevice: true },
  { scenario: '无设备时手机号', phone: true, device: false, withDevice: false },
])(
  '[AC-B1-03d#21][BR-ID-31/36] 建号前端口 $scenario 命中：检查两维度、同请求共用编号、回滚后留存',
  async ({ phone, device, withDevice }) => {
    const f = await setup(kit);
    const digest = phoneHmac(kit.crypto);
    if (phone) await seedBlock(kit.db, f.appId, 'phone', digest, f.clock);
    if (device) await seedBlock(kit.db, f.appId, 'device', f.hash, f.clock);
    const service = createBlocklistService(f.options);
    const before = await hits(kit.db, f.appId);
    expect(before).toEqual([]);
    const rollback = new Error('registration request rolled back');
    let refId: string | undefined;
    await expect(
      kit.db.transaction().execute(async (trx) => {
        const result = await service.checkRegistration(trx, {
          app_id: f.appId,
          phone_hmac: digest,
          ...(withDevice ? { device_hash: f.hash } : {}),
          related_phone: PHONE,
        });
        if (phone || device) {
          expect(result).toMatchObject({
            code: 44001,
            data: { risk_msg_code: 'blocklist.fraud_invite' },
          });
          expect(result?.ref_id).toMatch(UUID_V7);
          refId = result!.ref_id;
        } else {
          expect(result).toBeNull();
        }
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    const recorded = await hits(kit.db, f.appId);
    const expected = [
      ...(phone ? [{ dimension: 'phone', value_hmac: digest, rule_id: 'BLACKLIST_PHONE' }] : []),
      ...(device ? [{ dimension: 'device', value_hmac: f.hash, rule_id: 'BLACKLIST_DEVICE' }] : []),
    ];
    expect(recorded).toHaveLength(expected.length);
    for (const hit of expected) {
      expect(recorded).toContainEqual(
        expect.objectContaining({
          ...hit,
          app_id: f.appId,
          risk_action: 'block',
          ref_type: 'blocked_request',
          ref_id: refId,
          request_type: 'register',
          user_id: null,
          related_phone_hmac: digest,
          related_phone_masked: '138****5678',
          amount_fen: null,
          created_at: f.clock.now(),
        }),
      );
    }
  },
);
