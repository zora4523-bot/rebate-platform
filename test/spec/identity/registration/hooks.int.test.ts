import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import {
  createRegistrationService,
  type RegistrationOptions,
} from '../../../../apps/api/src/modules/identity/application/registration.ts';
import {
  openKit,
  closeKit,
  context,
  success,
  user,
  sizes,
  seedUser,
  anchorAfterRecords,
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

it('[BR-INV-06] 未携带或规范化后空邀请码不调用端口，结果无 invite_bind', async () => {
  const ctx = await context(kit);
  const bind = vi.fn<NonNullable<RegistrationOptions['bindInvite']>>(async () => ({
    result: 'bound',
    code: null,
  }));
  const omitted = success(await ctx.register({}, { bindInvite: bind }));
  const empty = success(await ctx.register({ invite_code: '', phone: null }, { bindInvite: bind }));
  expect(omitted).not.toHaveProperty('invite_bind');
  expect(empty).not.toHaveProperty('invite_bind');
  expect(bind).not.toHaveBeenCalled();
}, 30_000);

it('[BR-INV-06] 携带邀请码但端口未接时返回 failed/50001，账号仍提交', async () => {
  const ctx = await context(kit);
  const result = success(await ctx.register({ invite_code: 'ABCDEF' }));
  expect(result.invite_bind).toEqual({ result: 'failed', code: 50001 });
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 1, registrations: 1 });
  expect((await user(kit.db, result.user_id)).invite_code).toBe(result.invite_code);
});

for (const code of [30401, 30403, 30408, 42901] as const) {
  it(`[BR-INV-06] 绑定业务失败 ${code} 原样返回，回滚端口写入且保留账号`, async () => {
    const ctx = await context(kit);
    const marker = await seedUser(kit.db, ctx.appId);
    const bind = vi.fn<NonNullable<RegistrationOptions['bindInvite']>>(async (trx) => {
      await sql`UPDATE app.users SET nickname = 'binding-write' WHERE id = ${marker}`.execute(trx);
      return { result: 'failed', code };
    });
    const result = success(await ctx.register({ invite_code: 'ABCDEF' }, { bindInvite: bind }));
    expect(result.invite_bind).toEqual({ result: 'failed', code });
    expect(bind).toHaveBeenCalledTimes(1);
    expect((await user(kit.db, marker)).nickname).toBe('fixture');
    expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 2, registrations: 1 });
  });
}

for (const mode of ['throw', 'sql'] as const) {
  it(`[BR-INV-06] 绑定先写库再${mode === 'throw' ? '抛错' : '执行失败 SQL'}，只回滚绑定并告警`, async () => {
    const ctx = await context(kit);
    const marker = await seedUser(kit.db, ctx.appId);
    const bind = vi.fn<NonNullable<RegistrationOptions['bindInvite']>>(async (trx) => {
      await sql`UPDATE app.users SET nickname = 'binding-write' WHERE id = ${marker}`.execute(trx);
      if (mode === 'sql') await sql`SELECT 1 / 0`.execute(trx);
      throw new Error(`provider exposed ${PHONE} / ${PHONE.slice(3)}`);
    });
    const result = success(await ctx.register({ invite_code: 'ABCDEF' }, { bindInvite: bind }));
    expect(result.invite_bind).toEqual({ result: 'failed', code: 50001 });
    expect(bind).toHaveBeenCalledTimes(1);
    expect((await user(kit.db, marker)).nickname).toBe('fixture');
    expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 2, registrations: 1 });
    expect(await user(kit.db, result.user_id)).toMatchObject({ status: 'normal' });
    assertPrivateWarnings(ctx.lines);
  });
}

it('[BR-INV-06] bound 保留端口写入，并传入新号、规范化邀请码、设备及客户端信息', async () => {
  const ctx = await context(kit);
  const marker = await seedUser(kit.db, ctx.appId);
  const bind = vi.fn<NonNullable<RegistrationOptions['bindInvite']>>(async (trx, input) => {
    expect(trx.isTransaction).toBe(true);
    expect(await user(trx, input.user_id)).toMatchObject({ app_id: ctx.appId });
    // Not visible outside the supplied transaction: registration has not auto-committed.
    expect(
      await kit.db.selectFrom('users').select('id').where('id', '=', input.user_id).execute(),
    ).toEqual([]);
    await sql`UPDATE app.users SET nickname = 'binding-write' WHERE id = ${marker}`.execute(trx);
    return { result: 'bound', code: null };
  });
  const result = success(await ctx.register({ invite_code: 'ABCDEF' }, { bindInvite: bind }));
  expect(result.invite_bind).toEqual({ result: 'bound', code: null });
  expect(bind).toHaveBeenCalledTimes(1);
  expect(bind.mock.calls[0]![1]).toMatchObject({
    ...ctx.command,
    invite_code: 'ABCDEF',
    user_id: result.user_id,
  });
  expect((await user(kit.db, marker)).nickname).toBe('binding-write');
});

it('[BR-ID-05] 申诉插入点在拦截返回前调用，允许时越过本次上限且仍写来源', async () => {
  const ctx = await context(kit);
  for (let i = 0; i < 3; i++) await seedUser(kit.db, ctx.appId, { hash: ctx.hash });
  await anchorAfterRecords(kit, ctx);
  const seen: unknown[] = [];
  const allow = vi.fn<NonNullable<RegistrationOptions['allowBlockedRegistration']>>(
    async (trx, input) => {
      expect(trx.isTransaction).toBe(true);
      expect(await sizes(trx, ctx.appId)).toEqual({ users: 3, registrations: 3 });
      seen.push(input);
      return true;
    },
  );
  const result = success(await ctx.register({}, { allowBlockedRegistration: allow }));
  expect(allow).toHaveBeenCalledTimes(1);
  expect(seen).toEqual([{ app_id: ctx.appId, device_hash: ctx.hash, count: 3, limit: 3 }]);
  expect(await user(kit.db, result.user_id)).toMatchObject({ status: 'normal' });
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 4, registrations: 4 });
});

it('[BR-ID-05] 申诉端口不允许则仍返回 44001，判定所需计数及上限传给端口', async () => {
  const ctx = await context(kit);
  for (let i = 0; i < 3; i++) await seedUser(kit.db, ctx.appId, { hash: ctx.hash });
  await anchorAfterRecords(kit, ctx);
  const allow = vi.fn(async () => false);
  expect(await ctx.register({}, { allowBlockedRegistration: allow })).toMatchObject({
    code: 44001,
    count: 3,
    limit: 3,
  });
  expect(allow).toHaveBeenCalledTimes(1);
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 3, registrations: 3 });
});

for (const level of ['L1', 'L3'] as const) {
  it(`[BR-INV-14] 注册等级 ${level} 写入点同事务调用一次，source=register；B1-03g 成功调用点也在提交前`, async () => {
    const ctx = await context(kit);
    if (level !== 'L1') ctx.values.set('level.default', level);
    const marker = await seedUser(kit.db, ctx.appId);
    const record = vi.fn<NonNullable<RegistrationOptions['recordInitialLevel']>>(
      async (trx, input) => {
        expect(trx.isTransaction).toBe(true);
        expect(await user(trx, input.user_id)).toMatchObject({ level });
        expect(
          await kit.db.selectFrom('users').select('id').where('id', '=', input.user_id).execute(),
        ).toEqual([]);
        await sql`UPDATE app.users SET nickname = 'level-write' WHERE id = ${marker}`.execute(trx);
      },
    );
    const after = vi.fn<NonNullable<RegistrationOptions['afterRegistered']>>(async (trx, input) => {
      expect(trx.isTransaction).toBe(true);
      expect(await user(trx, input.user_id)).toMatchObject({ app_id: ctx.appId });
      expect(
        await kit.db.selectFrom('users').select('id').where('id', '=', input.user_id).execute(),
      ).toEqual([]);
    });
    const service = createRegistrationService({
      ...ctx.options,
      recordInitialLevel: record,
      afterRegistered: after,
    });
    const trx = await kit.db.startTransaction().execute();
    try {
      const result = success(await service.register(trx, ctx.command));
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]![1]).toEqual({
        app_id: ctx.appId,
        user_id: result.user_id,
        level,
        source: 'register',
      });
      expect(after).toHaveBeenCalledTimes(1);
      expect(after.mock.calls[0]![1]).toMatchObject({ ...ctx.command, user_id: result.user_id });
      expect((await user(trx, marker)).nickname).toBe('level-write');
    } finally {
      await trx.rollback().execute();
    }
    expect((await user(kit.db, marker)).nickname).toBe('fixture');
    expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 1, registrations: 0 });
  });
}
