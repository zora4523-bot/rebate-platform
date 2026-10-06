import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createRegistrationService } from '../../../../apps/api/src/modules/identity/application/registration.ts';
import {
  openKit,
  closeKit,
  context,
  success,
  registrations,
  sizes,
  seedUser,
  merge,
  anchorAfterRecords,
  WINDOW,
  type Kit,
} from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
});
afterAll(async () => {
  await closeKit(kit);
});

it('[BR-ID-05] 同设备三个账号后第四次微信建号返回 44001，携带风控所需字段且不写入', async () => {
  const ctx = await context(kit);
  const afterRegistered = vi.fn(async () => undefined);
  for (let i = 0; i < 3; i++) {
    success(
      await ctx.register(
        { phone: `+86138001381${i}`, device_id: randomUUID() },
        { afterRegistered },
      ),
    );
    await anchorAfterRecords(kit, ctx);
  }
  expect(
    await ctx.register(
      { phone: null, register_method: 'wechat', device_id: randomUUID() },
      { afterRegistered },
    ),
  ).toMatchObject({
    code: 44001,
    kind: 'device_register_limit',
    app_id: ctx.appId,
    device_hash: ctx.hash,
    count: 3,
    limit: 3,
  });
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 3, registrations: 3 });
  expect(afterRegistered).toHaveBeenCalledTimes(3);
}, 60_000);

it('[BR-ID-05] 已注销、封禁和并号墓碑仍占额度，不按当前可用账号数计数', async () => {
  const ctx = await context(kit);
  const target = await seedUser(kit.db, ctx.appId, { hash: randomBytes(32).toString('hex') });
  await seedUser(kit.db, ctx.appId, { hash: ctx.hash, status: 'deleted' });
  await seedUser(kit.db, ctx.appId, { hash: ctx.hash, status: 'banned' });
  const source = await seedUser(kit.db, ctx.appId, { hash: ctx.hash });
  await merge(kit.db, ctx.appId, source, target);
  await anchorAfterRecords(kit, ctx);
  const before = await registrations(kit.db, ctx.appId);
  expect(await ctx.register()).toMatchObject({ code: 44001, count: 3 });
  expect(await registrations(kit.db, ctx.appId)).toEqual(before);
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 4, registrations: 4 });
});

for (const enabled of [true, false]) {
  it(`[AC-S1-59 ⑥][BR-ID-05] 家人注册：去重${enabled ? '默认 on' : 'off'}时逐个判定 X/Y/Z`, async () => {
    const ctx = await context(kit);
    if (!enabled) ctx.values.set('risk.merge_tombstone_dedupe', false);
    const a = await seedUser(kit.db, ctx.appId, { hash: ctx.hash });
    const u9 = await seedUser(kit.db, ctx.appId, { hash: ctx.hash, method: 'wechat' });
    await merge(kit.db, ctx.appId, u9, a);
    await anchorAfterRecords(kit, ctx);
    const before = await registrations(kit.db, ctx.appId);
    expect(before).toHaveLength(2);
    expect(before.find((r) => r.user_id === u9)?.merged_into_user_id).toBe(a);
    success(await ctx.register({ phone: '+8613800138001' }));
    await anchorAfterRecords(kit, ctx);
    const y = await ctx.register({ phone: '+8613800138002' });
    if (enabled) {
      success(y);
      await anchorAfterRecords(kit, ctx);
      expect(await ctx.register({ phone: '+8613800138003' })).toMatchObject({
        code: 44001,
        count: 3,
      });
    } else {
      expect(y).toMatchObject({ code: 44001, count: 3 });
    }
    const after = await registrations(kit.db, ctx.appId);
    expect(after).toHaveLength(enabled ? 4 : 3);
    for (const record of before) expect(after).toContainEqual(record);
    expect(await sizes(kit.db, ctx.appId)).toEqual({
      users: enabled ? 4 : 3,
      registrations: enabled ? 4 : 3,
    });
  }, 60_000);
}

it('[AC-S1-59 ⑦] 三个跨设备并号不返还任一设备名额，来源记录保留', async () => {
  const ctx = await context(kit);
  const targets = [];
  const otherHash = randomBytes(32).toString('hex');
  for (let i = 0; i < 3; i++) targets.push(await seedUser(kit.db, ctx.appId, { hash: otherHash }));
  const sources = [];
  for (const [i, method] of (['wechat', 'apple', 'wechat'] as const).entries()) {
    const result = success(await ctx.register({ phone: null, register_method: method }));
    sources.push(result.user_id);
    await merge(kit.db, ctx.appId, result.user_id, targets[i]!);
    await anchorAfterRecords(kit, ctx);
  }
  const before = await registrations(kit.db, ctx.appId);
  expect(await ctx.register()).toMatchObject({ code: 44001, count: 3 });
  expect(await ctx.register({ device_hash: otherHash })).toMatchObject({ code: 44001, count: 3 });
  expect(before).toHaveLength(6);
  for (const [i, id] of sources.entries()) {
    expect(before.find((r) => r.user_id === id)).toMatchObject({ merged_into_user_id: targets[i] });
  }
  expect(await registrations(kit.db, ctx.appId)).toEqual(before);
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 6, registrations: 6 });
}, 60_000);

it('[BR-ID-05] 窗口内多个源号并入同设备同一个目标时只占一个名额', async () => {
  const ctx = await context(kit);
  const target = await seedUser(kit.db, ctx.appId, { hash: ctx.hash });
  for (const method of ['wechat', 'apple', 'huawei']) {
    const source = await seedUser(kit.db, ctx.appId, { hash: ctx.hash, method });
    await merge(kit.db, ctx.appId, source, target);
  }
  await anchorAfterRecords(kit, ctx);
  success(await ctx.register({ phone: null, register_method: 'wechat' }));
  await anchorAfterRecords(kit, ctx);
  success(await ctx.register({ phone: null, register_method: 'wechat' }));
  await anchorAfterRecords(kit, ctx);
  expect(await ctx.register({ phone: null, register_method: 'wechat' })).toMatchObject({
    code: 44001,
    count: 3,
  });
  expect(await registrations(kit.db, ctx.appId)).toHaveLength(6);
}, 60_000);

it('[BR-ID-05] App 分隔计数、配置上限 2 生效，device_id 改变不重置额度', async () => {
  const ctx = await context(kit);
  ctx.values.set('risk.device_register_limit', 2);
  for (let i = 0; i < 3; i++) await seedUser(kit.db, `${ctx.appId}_other`, { hash: ctx.hash });
  success(await ctx.register({ phone: null, register_method: 'wechat' }));
  await anchorAfterRecords(kit, ctx);
  success(await ctx.register({ phone: null, register_method: 'wechat', device_id: randomUUID() }));
  await anchorAfterRecords(kit, ctx);
  expect(
    await ctx.register({ phone: null, register_method: 'wechat', device_id: randomUUID() }),
  ).toMatchObject({
    code: 44001,
    count: 2,
    limit: 2,
  });
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 2, registrations: 2 });
  expect(await sizes(kit.db, `${ctx.appId}_other`)).toEqual({ users: 3, registrations: 3 });
}, 60_000);

it('[BR-ID-05] 注入时钟移动到窗口前后一分钟：旧记录仍在但滑出后释放名额', async () => {
  const ctx = await context(kit);
  for (let i = 0; i < 3; i++) await seedUser(kit.db, ctx.appId, { hash: ctx.hash });
  await anchorAfterRecords(kit, ctx, WINDOW - 60_000);
  const before = await registrations(kit.db, ctx.appId);
  expect(await ctx.register()).toMatchObject({ code: 44001, count: 3 });
  await anchorAfterRecords(kit, ctx, WINDOW + 60_000);
  success(await ctx.register());
  const after = await registrations(kit.db, ctx.appId);
  expect(after).toHaveLength(4);
  for (const record of before) expect(after).toContainEqual(record);
});

it('[BR-ID-05] 落地页无设备，不调用设备放行端口、不判额度、不写设备来源', async () => {
  const ctx = await context(kit);
  for (let i = 0; i < 3; i++) await seedUser(kit.db, ctx.appId, { hash: ctx.hash });
  const allow = vi.fn(async () => false);
  const service = createRegistrationService({ ...ctx.options, allowBlockedRegistration: allow });
  const result = await kit.db.transaction().execute((trx) =>
    service.register(trx, {
      app_id: ctx.appId,
      phone: ctx.command.phone,
      register_method: 'h5_landing',
      client_ip: ctx.command.client_ip,
    }),
  );
  success(result);
  expect(allow).not.toHaveBeenCalled();
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 4, registrations: 3 });
});

it('[BR-ID-05] 同一新设备同时建五个号，恰好三成功、两拦截', async () => {
  const ctx = await context(kit);
  ctx.clock.advanceMs(60_000);
  const service = createRegistrationService(ctx.options);
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      kit.db
        .transaction()
        .execute((trx) =>
          service.register(trx, {
            ...ctx.command,
            phone: null,
            register_method: 'wechat',
            device_id: randomUUID(),
          }),
        ),
    ),
  );
  expect(results.filter((r) => 'code' in r && r.code === 0)).toHaveLength(3);
  expect(results.filter((r) => 'code' in r && r.code === 44001)).toHaveLength(2);
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 3, registrations: 3 });
}, 30_000);

it('[BR-ID-05] 已有两条：A 成功未提交时 B 等待，A 提交后 B 读到三条并拒绝', async () => {
  const ctx = await context(kit);
  for (let i = 0; i < 2; i++) await seedUser(kit.db, ctx.appId, { hash: ctx.hash });
  await anchorAfterRecords(kit, ctx);
  const service = createRegistrationService(ctx.options);
  const a = await kit.db.startTransaction().execute();
  let committed = false;
  let pending: Promise<unknown> | undefined;
  try {
    success(await service.register(a, { ...ctx.command, phone: null, register_method: 'wechat' }));
    let settled = false;
    const started = Promise.withResolvers<void>();
    const b = kit.db.transaction().execute(async (trx) => {
      started.resolve();
      try {
        return await service.register(trx, {
          ...ctx.command,
          phone: null,
          register_method: 'wechat',
          device_id: randomUUID(),
        });
      } finally {
        settled = true;
      }
    });
    pending = b;
    // Attach a rejection handler immediately so cleanup cannot cause an unhandled rejection.
    void b.catch(() => undefined);
    await started.promise;
    await delay(250);
    expect(settled).toBe(false);
    await a.commit().execute();
    committed = true;
    expect(await b).toMatchObject({ code: 44001, count: 3 });
    expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 3, registrations: 3 });
  } finally {
    if (!committed) await a.rollback().execute();
    await pending?.catch(() => undefined);
  }
}, 30_000);

it('[BR-ID-05] 同 App 不同设备：A 建号未提交时 B 能独立完成并提交', async () => {
  const ctx = await context(kit);
  ctx.clock.advanceMs(60_000);
  const service = createRegistrationService(ctx.options);
  const a = await kit.db.startTransaction().execute();
  let pending: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = success(await service.register(a, ctx.command));
    const otherHash = randomBytes(32).toString('hex');
    const b = kit.db.transaction().execute((trx) =>
      service.register(trx, {
        ...ctx.command,
        phone: '+8613800138001',
        device_hash: otherHash,
        device_id: randomUUID(),
      }),
    );
    pending = b;
    void b.catch(() => undefined);
    const result = await Promise.race([
      b,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 5_000);
      }),
    ]);
    expect(result, '另一台设备必须在 A 提交或回滚之前完成').toMatchObject({ code: 0 });
    expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 1, registrations: 1 });
    const committed = await registrations(kit.db, ctx.appId);
    expect(committed).toEqual([expect.objectContaining({ device_hash: otherHash })]);
    expect(committed[0]!.user_id).not.toBe(first.user_id);
  } finally {
    clearTimeout(timer);
    await a.rollback().execute();
    await pending?.catch(() => undefined);
  }
}, 30_000);

it('[BR-ID-05] 44001 后调用方仍可提交原有写入，服务不增加来源', async () => {
  const ctx = await context(kit);
  const first = await seedUser(kit.db, ctx.appId, { hash: ctx.hash });
  for (let i = 0; i < 2; i++) await seedUser(kit.db, ctx.appId, { hash: ctx.hash });
  await anchorAfterRecords(kit, ctx);
  const service = createRegistrationService(ctx.options);
  const result = await kit.db.transaction().execute(async (trx) => {
    await sql`UPDATE app.users SET nickname = 'caller' WHERE id = ${first}`.execute(trx);
    return service.register(trx, ctx.command);
  });
  expect(result).toMatchObject({ code: 44001 });
  expect(
    await kit.db.selectFrom('users').select('nickname').where('id', '=', first).executeTakeFirst(),
  ).toEqual({ nickname: 'caller' });
  expect(await sizes(kit.db, ctx.appId)).toEqual({ users: 3, registrations: 3 });
});
