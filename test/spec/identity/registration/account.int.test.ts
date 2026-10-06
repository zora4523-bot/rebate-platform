import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import {
  createRegistrationService,
  registrationConstants,
  type RegisterMethod,
} from '../../../../apps/api/src/modules/identity/application/registration.ts';
import {
  openKit,
  closeKit,
  context,
  success,
  user,
  registrations,
  sizes,
  seedUser,
  assertPrivateWarnings,
  PHONE,
  type Kit,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
});
afterAll(async () => {
  await closeKit(kit);
});

it('[BR-ID-04][BR-INV-14][04 §3.2] 手机建号写密文/盲索引、默认资料与注册来源', async () => {
  const ctx = await context(kit);
  const result = success(await ctx.register());
  const constants = registrationConstants();
  const saved = await user(kit.db, result.user_id);
  expect(saved.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(Buffer.isBuffer(saved.phone_cipher)).toBe(true);
  expect(
    kit.crypto.decrypt(saved.phone_cipher!.toString('utf8'), constants.PHONE_CIPHER_CONTEXT),
  ).toBe(PHONE);
  expect(saved.phone_hmac).toBe(kit.crypto.blindIndex(PHONE, constants.PHONE_BLIND_INDEX_CONTEXT));
  expect(saved.phone_cipher!.toString('utf8')).not.toContain(PHONE);
  expect(saved).toMatchObject({
    app_id: ctx.appId,
    nickname: `用户${saved.id.slice(-4)}`,
    nickname_change_count: 0,
    nickname_change_month: null,
    avatar: constants.DEFAULT_AVATAR,
    level: 'L1',
    status: 'normal',
    register_method: 'sms',
    registered_channel: 'test_channel',
    invite_code: result.invite_code,
    attr_code: result.attr_code,
  });
  expect(saved.avatar.length).toBeGreaterThan(0);
  expect(result.invite_code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  expect(result.attr_code).toMatch(/^[0-9a-z]{8}$/);
  expect(await registrations(kit.db, ctx.appId)).toEqual([
    expect.objectContaining({
      app_id: ctx.appId,
      user_id: saved.id,
      device_hash: ctx.hash,
      register_method: 'sms',
      merged_into_user_id: null,
    }),
  ]);
  expect(ctx.lines.join('')).not.toContain(PHONE);
  expect(ctx.lines.join('')).not.toContain(PHONE.slice(3));
});

it('[BR-ID-04][BR-INV-14] 六种建号方式保留来源，第三方可无手机号、渠道未给为 NULL，等级取配置', async () => {
  const methods: RegisterMethod[] = ['sms', 'wechat', 'apple', 'huawei', 'h5_landing', 'admin'];
  for (const [index, method] of methods.entries()) {
    const ctx = await context(kit);
    const level = index % 2 === 0 ? 'L2' : 'L3';
    ctx.values.set('level.default', level);
    const { channel, device_hash, device_id, ...base } = ctx.command;
    void channel;
    void device_hash;
    void device_id;
    const service = createRegistrationService(ctx.options);
    const result = success(
      await kit.db.transaction().execute((trx) =>
        service.register(trx, {
          ...base,
          phone: null,
          register_method: method,
        }),
      ),
    );
    expect(await user(kit.db, result.user_id)).toMatchObject({
      register_method: method,
      registered_channel: null,
      phone_cipher: null,
      phone_hmac: null,
      level,
    });
  }
}, 30_000);

it('[BR-INV-01][BR-ATTR-06] 默认随机源连续建号，邀请码及归属码格式正确且不重复', async () => {
  const ctx = await context(kit);
  const invites = new Set<string>();
  const attrs = new Set<string>();
  for (let i = 0; i < 24; i++) {
    const result = success(await ctx.register({ phone: null, device_hash: `hash-${i}` }));
    expect(result.invite_code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    expect(result.attr_code).toMatch(/^[0-9a-z]{8}$/);
    invites.add(result.invite_code);
    attrs.add(result.attr_code);
  }
  expect(invites.size).toBe(24);
  expect(attrs.size).toBe(24);
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 24, registrations: 24 });
}, 30_000);

it('[BR-INV-01] 敏感命中、唯一冲突各算一次，第 3 候选写入且事务可继续提交', async () => {
  const ctx = await context(kit);
  await seedUser(kit.db, ctx.appId, { invite: 'BBBBBB' });
  const candidate = vi
    .fn()
    .mockReturnValueOnce('AAAAAA')
    .mockReturnValueOnce('BBBBBB')
    .mockReturnValue('CCCCCC');
  const filter = vi.fn((scene: 'invite_code', code: string) => {
    expect(scene).toBe('invite_code');
    return code === 'AAAAAA';
  });
  const result = success(
    await ctx.register({}, { inviteCandidate: candidate, sensitiveWords: { matches: filter } }),
  );
  expect(result.invite_code).toBe('CCCCCC');
  expect(candidate).toHaveBeenCalledTimes(3);
  expect(filter.mock.calls).toEqual([
    ['invite_code', 'AAAAAA'],
    ['invite_code', 'BBBBBB'],
    ['invite_code', 'CCCCCC'],
  ]);
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 2, registrations: 1 });
});

it('[BR-INV-01] 第 5 个候选仍可成功，敏感词和冲突共享 5 次预算', async () => {
  const ctx = await context(kit);
  await seedUser(kit.db, ctx.appId, { invite: 'BBBBBB' });
  const candidates = ['AAAAAA', 'BBBBBB', 'AAAAAA', 'BBBBBB', 'CCCCCC'];
  const candidate = vi.fn(() => candidates.shift() ?? 'DDDDDD');
  const result = success(
    await ctx.register(
      {},
      {
        inviteCandidate: candidate,
        sensitiveWords: { matches: (_scene, code) => code === 'AAAAAA' },
      },
    ),
  );
  expect(result.invite_code).toBe('CCCCCC');
  expect(candidate).toHaveBeenCalledTimes(5);
});

for (const failure of ['sensitive', 'collision', 'mixed'] as const) {
  it(`[BR-INV-01] ${failure} 耗尽五次返回 50001、告警、不取第六次，调用方提交后无建号残留`, async () => {
    const ctx = await context(kit);
    if (failure !== 'sensitive') await seedUser(kit.db, ctx.appId, { invite: 'BBBBBB' });
    const before = await sizes(kit.db, ctx.appId);
    const afterRegistered = vi.fn(async () => undefined);
    let draws = 0;
    const candidate = vi.fn(() => {
      draws++;
      if (draws > 5) return 'CCCCCC';
      return failure === 'sensitive' || (failure === 'mixed' && draws % 2 === 1)
        ? 'AAAAAA'
        : 'BBBBBB';
    });
    const result = await ctx.register(
      {},
      {
        inviteCandidate: candidate,
        afterRegistered,
        sensitiveWords: { matches: (_scene, code) => code === 'AAAAAA' },
      },
    );
    expect(result).toEqual({ code: 50001 });
    expect(candidate).toHaveBeenCalledTimes(5);
    expect(afterRegistered).not.toHaveBeenCalled();
    expect(await sizes(kit.db, ctx.appId)).toEqual(before);
    assertPrivateWarnings(ctx.lines);
  });
}

it('[BR-INV-01] 注销账号邀请码不回收；不同 App 可以各自持有同码', async () => {
  const ctx = await context(kit);
  await seedUser(kit.db, ctx.appId, { invite: 'BBBBBB', status: 'deleted' });
  await seedUser(kit.db, `${ctx.appId}_other`, { invite: 'CCCCCC', attr: 'abcd1234' });
  const candidate = vi.fn().mockReturnValueOnce('BBBBBB').mockReturnValue('CCCCCC');
  const result = success(
    await ctx.register({}, { inviteCandidate: candidate, attrCandidate: () => 'abcd1234' }),
  );
  expect(result.invite_code).toBe('CCCCCC');
  expect(result.attr_code).toBe('abcd1234');
  expect(candidate).toHaveBeenCalledTimes(2);
});

it('[BR-ATTR-06] 归属码本 App 唯一冲突后重试成功', async () => {
  const ctx = await context(kit);
  await seedUser(kit.db, ctx.appId, { attr: 'abcd1234' });
  const candidate = vi.fn().mockReturnValueOnce('abcd1234').mockReturnValue('abcd5678');
  const result = success(await ctx.register({}, { attrCandidate: candidate }));
  expect(result.attr_code).toBe('abcd5678');
  expect(candidate).toHaveBeenCalledTimes(2);
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 2, registrations: 1 });
});

it('[BR-ATTR-06] 归属码持续冲突有界失败并告警，不留下账号或注册来源', async () => {
  const ctx = await context(kit);
  await seedUser(kit.db, ctx.appId, { attr: 'abcd1234' });
  const afterRegistered = vi.fn(async () => undefined);
  const candidate = vi.fn(() => 'abcd1234');
  expect(await ctx.register({}, { attrCandidate: candidate, afterRegistered })).toEqual({
    code: 50001,
  });
  expect(candidate).toHaveBeenCalled();
  expect(afterRegistered).not.toHaveBeenCalled();
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 1, registrations: 0 });
  assertPrivateWarnings(ctx.lines);
}, 30_000);

it('[04 §3.2] 手机盲索引唯一冲突返回独立 phone_taken，调用方前后写入可提交', async () => {
  const ctx = await context(kit);
  const first = success(await ctx.register());
  const service = createRegistrationService(ctx.options);
  const result = await kit.db.transaction().execute(async (trx) => {
    await sql`UPDATE app.users SET nickname = 'caller_before' WHERE id = ${first.user_id}`.execute(
      trx,
    );
    const result = await service.register(trx, { ...ctx.command, device_hash: 'another-device' });
    await sql`UPDATE app.users SET avatar = 'caller_after' WHERE id = ${first.user_id}`.execute(
      trx,
    );
    return result;
  });
  expect(result).toEqual({ outcome: 'phone_taken' });
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 1, registrations: 1 });
  expect(await user(kit.db, first.user_id)).toMatchObject({
    nickname: 'caller_before',
    avatar: 'caller_after',
  });
});

it('[04 §3.2] 同一新手机号在不同设备并发建号：一个成功、另一个 phone_taken，无部分写入', async () => {
  const ctx = await context(kit);
  const service = createRegistrationService(ctx.options);
  const results = await Promise.all(
    ['device-a', 'device-b'].map((device_hash) =>
      kit.db.transaction().execute((trx) => service.register(trx, { ...ctx.command, device_hash })),
    ),
  );
  expect(results.filter((r) => 'code' in r && r.code === 0)).toHaveLength(1);
  expect(results.filter((r) => 'outcome' in r && r.outcome === 'phone_taken')).toHaveLength(1);
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 1, registrations: 1 });
}, 30_000);

it('[04 §3.2][BR-ID-04] 注销后可重新用同手机号建号，旧号及其来源不复用、不删除', async () => {
  const ctx = await context(kit);
  const first = success(await ctx.register());
  await sql`UPDATE app.users SET status = 'deleted' WHERE id = ${first.user_id}`.execute(kit.db);
  const second = success(await ctx.register({ device_hash: 'new-device' }));
  expect(second.user_id).not.toBe(first.user_id);
  expect(second.invite_code).not.toBe(first.invite_code);
  expect(await user(kit.db, first.user_id)).toMatchObject({
    status: 'deleted',
    invite_code: first.invite_code,
  });
  expect((await user(kit.db, second.user_id)).phone_hmac).toBe(
    (await user(kit.db, first.user_id)).phone_hmac,
  );
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 2, registrations: 2 });
}, 30_000);

it('[BR-ID-04] 同一设备手机号与第三方首次登录分别创建账号，不自动合并', async () => {
  const ctx = await context(kit);
  const sms = success(await ctx.register());
  const wechat = success(await ctx.register({ phone: null, register_method: 'wechat' }));
  expect(wechat.user_id).not.toBe(sms.user_id);
  expect(await user(kit.db, sms.user_id)).toMatchObject({
    status: 'normal',
    register_method: 'sms',
  });
  expect(await user(kit.db, wechat.user_id)).toMatchObject({
    status: 'normal',
    register_method: 'wechat',
    phone_hmac: null,
  });
  expect(await registrations(kit.db, ctx.appId)).toHaveLength(2);
}, 30_000);

it('[BR-INV-01] 50001 回滚范围只含建号，调用方先前写入和后续 SQL 均保留', async () => {
  const ctx = await context(kit);
  const existing = await seedUser(kit.db, ctx.appId);
  const service = createRegistrationService({
    ...ctx.options,
    sensitiveWords: { matches: () => true },
  });
  const result = await kit.db.transaction().execute(async (trx) => {
    await sql`UPDATE app.users SET nickname = 'caller_before' WHERE id = ${existing}`.execute(trx);
    const result = await service.register(trx, ctx.command);
    await sql`UPDATE app.users SET avatar = 'caller_after' WHERE id = ${existing}`.execute(trx);
    return result;
  });
  expect(result).toEqual({ code: 50001 });
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 1, registrations: 0 });
  expect(await user(kit.db, existing)).toMatchObject({
    nickname: 'caller_before',
    avatar: 'caller_after',
  });
});

it('[04 §3.2] 调用方回滚同时撤销 users 与 device_registrations', async () => {
  const ctx = await context(kit);
  const service = createRegistrationService(ctx.options);
  const rollback = new Error('caller rollback');
  await expect(
    kit.db.transaction().execute(async (trx) => {
      success(await service.register(trx, ctx.command));
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 0, registrations: 0 });
});
