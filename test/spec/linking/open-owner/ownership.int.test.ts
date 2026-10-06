// B1-06d: only ownership and registration. Authorization, price re-check, attempts,
// open logs and wire responses belong to B1-06e/f/k, and are not simulated here.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { ColumnNode, TableNode, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createGuestCallerContext } from '../../../../apps/api/src/modules/linking/index.ts';
import { seed } from '../register/kit.ts';
import {
  allLinks,
  DEVICE_A,
  DEVICE_B,
  ownerFixture,
  ownerService,
  QUOTED,
  SESSION,
  sourceLink,
  START,
  stored,
  unknownPriceLink,
  unknownPricePddLink,
  USER_A,
  USER_B,
  USER_C,
} from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  await seed(db);
  await db
    .insertInto('users')
    .values({
      id: USER_C,
      app_id: 'register-app',
      nickname: '合成第三用户',
      avatar: 'synthetic-avatar',
      invite_code: 'demo3',
      attr_code: 'demo0003',
      level: 'T1',
      register_method: 'synthetic',
      created_at: START,
      updated_at: START,
    })
    .execute();
});
afterAll(async () => {
  await destroyDb(db);
  await database.drop();
});

it.each([
  ['taobao', null],
  ['taobao', USER_B],
  ['jd', null],
  ['jd', USER_B],
  ['pdd', null],
  ['pdd', USER_B],
] as const)(
  '[AC-B1-06d#1] BR-ATTR-05①：%s 分享 link，打开者 %s 始终沿用分享者快照',
  async (platform, userId) => {
    const original = await sourceLink(db, { scene: 'share' }, {}, platform);
    const before = await allLinks(db);
    const f = ownerFixture(db, { userId, deviceId: DEVICE_B });
    const result = await ownerService(f).open({ linkId: original.link_id });
    expect(result.link).toEqual(original);
    expect(result.identitySnapshot).toEqual(original.identity_snapshot);
    expect(result.identitySnapshot).toMatchObject({
      user_id: USER_A,
      pid_scene: 'share',
      attr_code: 'demo0001',
    });
    expect(result.new_link_id).toBeNull();
    expect(result.old_final_price_fen).toBe('10000');
    expect(await allLinks(db)).toEqual(before);
  },
);

it.each([
  ['search', 'self_buy'],
  ['detail', 'self_buy'],
  ['agent', 'agent'],
  ['taolijin', 'taolijin'],
] as const)(
  '[AC-B1-06d#2] BR-ATTR-05②：本人 %s link 保留原 id 与 %s 身份',
  async (scene, pidScene) => {
    const original = await sourceLink(db, { scene, agentSessionId: SESSION });
    const before = await allLinks(db);
    const f = ownerFixture(db, { userId: USER_A, deviceId: DEVICE_B });
    const result = await ownerService(f).open({ linkId: original.link_id });
    expect(result.link).toEqual(original);
    expect(result.identitySnapshot).toEqual(original.identity_snapshot);
    expect(result.identitySnapshot).toMatchObject({ user_id: USER_A, pid_scene: pidScene });
    expect(result.new_link_id).toBeNull();
    expect(result.old_final_price_fen).toBe('10000');
    expect(await allLinks(db)).toEqual(before);
  },
);

it.each([
  ['search', 'self_buy'],
  ['detail', 'self_buy'],
  ['home_card', 'self_buy'],
  ['feed', 'self_buy'],
  ['clipboard', 'self_buy'],
  ['h5', 'self_buy'],
  ['push', 'self_buy'],
  ['agent', 'agent'],
  ['watch_alert', 'self_buy'],
  ['share_ext', 'self_buy'],
  ['wechat_bot', 'self_buy'],
  ['mcp', 'agent'],
] as const)(
  '[AC-B1-06d#3] BR-ATTR-05③：他人 %s link 为当前用户按原 scene 登记，推广位 %s',
  async (scene, pidScene) => {
    const original = await sourceLink(db, { scene });
    const before = await allLinks(db);
    const f = ownerFixture(db, { deviceId: DEVICE_B });
    const result = await ownerService(f).open({ linkId: original.link_id });
    expect(result.new_link_id).toEqual(expect.any(String));
    expect(result.new_link_id).not.toBe(original.link_id);
    const fresh = await stored(db, result.new_link_id!);
    expect(result.link).toEqual(fresh);
    expect(fresh).toMatchObject({
      app_id: original.app_id,
      user_id: USER_B,
      device_id: DEVICE_B,
      platform: original.platform,
      product_key: original.product_key,
      raw_item_id: original.raw_item_id,
      scene,
      pid_scene: pidScene,
      entry_source: original.entry_source,
      quoted_final_price_fen: original.quoted_final_price_fen,
      quoted_coupon_fen: original.quoted_coupon_fen,
      quoted_coupon_id: original.quoted_coupon_id,
      quoted_at: original.quoted_at,
    });
    expect(result.identitySnapshot).toEqual(fresh.identity_snapshot);
    expect(result.identitySnapshot).toMatchObject({
      user_id: USER_B,
      attr_code: 'demo0002',
      pid_scene: pidScene,
    });
    expect(result.old_final_price_fen).toBe('10000');
    expect(await stored(db, original.link_id)).toEqual(original);
    expect(await allLinks(db)).toHaveLength(before.length + 1);
    expect(f.attrCode).toHaveBeenCalledWith('register-app', USER_B);
    expect(f.getActivePid).toHaveBeenCalledWith({
      appId: 'register-app',
      platform: 'taobao',
      pidScene,
      purpose: 'convert',
    });
  },
);

it.each(['taobao', 'jd', 'pdd'] as const)(
  '[AC-B1-06d#4] BR-ATTR-11：%s 分享者自己打开，新建 detail/self_buy，原分享 link 完整保留',
  async (platform) => {
    const original = await sourceLink(db, { scene: 'share' }, {}, platform);
    const before = await allLinks(db);
    const f = ownerFixture(db, { userId: USER_A });
    const result = await ownerService(f).open({ linkId: original.link_id });
    expect(result.new_link_id).toEqual(expect.any(String));
    expect(result.new_link_id).not.toBe(original.link_id);
    const fresh = await stored(db, result.new_link_id!);
    expect(result.link).toEqual(fresh);
    expect(fresh).toMatchObject({
      app_id: 'register-app',
      user_id: USER_A,
      scene: 'detail',
      pid_scene: 'self_buy',
      platform,
      product_key: original.product_key,
    });
    expect(result.identitySnapshot).toEqual(fresh.identity_snapshot);
    expect(result.identitySnapshot).toMatchObject({
      user_id: USER_A,
      platform,
      pid_scene: 'self_buy',
      pid: 'synthetic-self_buy',
      attr_code: 'demo0001',
    });
    expect(result.old_final_price_fen).toBe('10000');
    expect(await stored(db, original.link_id)).toEqual(original);
    expect(await allLinks(db)).toHaveLength(before.length + 1);
    expect(f.getActivePid).toHaveBeenCalledWith({
      appId: 'register-app',
      platform,
      pidScene: 'self_buy',
      purpose: 'convert',
    });
  },
);

it('[AC-B1-06d#5] BR-ATTR-05③：他人淘礼金降为 detail 自购位，传递限制提示与原比较价', async () => {
  const original = await sourceLink(db, { scene: 'taolijin' });
  const f = ownerFixture(db);
  const result = await ownerService(f).open({ linkId: original.link_id });
  expect(result.new_link_id).toEqual(expect.any(String));
  expect(result.new_link_id).not.toBe(original.link_id);
  const fresh = await stored(db, result.new_link_id!);
  expect(result.link).toEqual(fresh);
  expect(fresh).toMatchObject({
    user_id: USER_B,
    scene: 'detail',
    pid_scene: 'self_buy',
    quoted_final_price_fen: 10000n,
  });
  expect(result.identitySnapshot).toEqual(fresh.identity_snapshot);
  expect(result.identitySnapshot).toMatchObject({
    user_id: USER_B,
    pid_scene: 'self_buy',
    pid: 'synthetic-self_buy',
    attr_code: 'demo0002',
  });
  expect(result.message).toBe('该淘礼金仅限原用户使用');
  expect(result.old_final_price_fen).toBe('10000');
  expect(f.getActivePid.mock.calls.map(([query]) => query.pidScene)).not.toContain('taolijin');
  expect(await stored(db, original.link_id)).toEqual(original);
});

it.each([null, USER_A])(
  '[AC-B1-06d#6] BR-ATTR-05④：非分享 link 的快照用户为 %s，匿名打开仍为 10001',
  async (userId) => {
    const original = await sourceLink(db, { scene: 'search' }, { userId });
    const before = await allLinks(db);
    const service = ownerService(ownerFixture(db, { userId: null, deviceId: DEVICE_A }));
    await expect(service.open({ linkId: original.link_id })).rejects.toMatchObject({ code: 10001 });
    expect(await allLinks(db)).toEqual(before);
  },
);

it.each(['agent', 'taolijin', 'share_ext'] as const)(
  '[AC-B1-06d#7] BR-ATTR-05④：%s 不是分享推广位，匿名不能打开',
  async (scene) => {
    const original = await sourceLink(db, { scene });
    const before = await allLinks(db);
    const service = ownerService(ownerFixture(db, { userId: null }));
    await expect(service.open({ linkId: original.link_id })).rejects.toMatchObject({ code: 10001 });
    expect(await allLinks(db)).toEqual(before);
  },
);

it.each([null, USER_B])(
  '[AC-B1-06d#8] BR-ATTR-05⑤：不存在的 link，当前用户 %s 得到 30144 且不登记',
  async (userId) => {
    const before = await allLinks(db);
    const service = ownerService(ownerFixture(db, { userId }));
    await expect(
      service.open({ linkId: '0199a3b4-5c6d-7000-8000-000000009999' }),
    ).rejects.toMatchObject({ code: 30144 });
    expect(await allLinks(db)).toEqual(before);
  },
);

it.each([
  ['share', null],
  ['share', USER_A],
  ['share', USER_B],
  ['search', null],
  ['search', USER_A],
  ['search', USER_B],
] as const)(
  '[AC-B1-06d#9] BR-ATTR-05⑤：跨 App 的 %s link，当前用户 %s 一律 30144',
  async (scene, userId) => {
    const original = await sourceLink(db, { scene });
    const before = await allLinks(db);
    const service = ownerService(ownerFixture(db, { appId: 'synthetic-other-app', userId }));
    await expect(service.open({ linkId: original.link_id })).rejects.toMatchObject({ code: 30144 });
    expect(await allLinks(db)).toEqual(before);
  },
);

it('[AC-B1-06d#10] BR-ATTR-05：伪造请求身份、App 与 scene 不得覆盖 CallerContext 或存储快照', async () => {
  const original = await sourceLink(db, { scene: 'search' });
  const f = ownerFixture(db);
  const service = ownerService(f);
  const forged = {
    linkId: original.link_id,
    appId: 'synthetic-other-app',
    app_id: 'synthetic-other-app',
    userId: USER_A,
    user_id: USER_A,
    scene: 'share',
    pid_scene: 'share',
    viewer: { appId: 'register-app', userId: USER_A, deviceId: DEVICE_A },
    identity_snapshot: original.identity_snapshot,
    pid: 'synthetic-forged-pid',
    relation_id: 'synthetic-relation',
    subUnionId: 'synthetic-sub',
    custom_parameters: 'synthetic-custom',
    sid: 'synthetic-sid',
  };
  const result = await service.open(forged);
  expect(result.new_link_id).toEqual(expect.any(String));
  expect(result.link).toMatchObject({
    app_id: 'register-app',
    user_id: USER_B,
    scene: 'search',
    pid_scene: 'self_buy',
  });
  expect(result.identitySnapshot).toMatchObject({
    user_id: USER_B,
    pid: 'synthetic-self_buy',
    attr_code: 'demo0002',
  });
  expect(result.link).toEqual(await stored(db, result.new_link_id!));
  expect(await stored(db, original.link_id)).toEqual(original);
});

it('[AC-B1-06d#11] BR-ATTR-05④：未接身份端口时伪造 user_id 也不能绕过登录', async () => {
  const original = await sourceLink(db);
  const f = ownerFixture(db);
  const service = ownerService({
    ...f,
    options: {
      ...f.options,
      callerContext: createGuestCallerContext({ appId: 'register-app', deviceId: DEVICE_A }),
    },
  });
  const forged = { linkId: original.link_id, user_id: USER_A, userId: USER_A };
  const before = await allLinks(db);
  await expect(service.open(forged)).rejects.toMatchObject({ code: 10001 });
  expect(await allLinks(db)).toEqual(before);
});

it.each([1n, 9007199254740993n])(
  '[AC-B1-06d#12] BR-PRICE-12：他人 link 报价 %s 原样成为比较基准，不截断为浮点或改成零',
  async (price) => {
    const original = await sourceLink(db, { scene: 'detail' }, {}, 'jd', price);
    const result = await ownerService(ownerFixture(db)).open({ linkId: original.link_id });
    expect(result.new_link_id).toEqual(expect.any(String));
    expect(result.old_final_price_fen).toBe(price.toString());
    const fresh = await stored(db, result.new_link_id!);
    expect(result.link).toEqual(fresh);
    expect(fresh.quoted_final_price_fen).toBe(price);
    expect(fresh.quoted_at).toEqual(new Date(QUOTED));
    expect(await stored(db, original.link_id)).toEqual(original);
  },
);

it.each([
  ['search', USER_A],
  ['share', null],
] as const)(
  '[AC-B1-06d#13] BR-ATTR-05：过期 %s link 仍可打开，沿用原 id、不续期',
  async (scene, userId) => {
    const original = await sourceLink(db, { scene });
    const f = ownerFixture(db, { userId });
    f.clock.advanceMs(8 * 24 * 60 * 60 * 1000);
    const before = await allLinks(db);
    const result = await ownerService(f).open({ linkId: original.link_id });
    expect(result.link).toEqual(original);
    expect(result.new_link_id).toBeNull();
    expect(result.identitySnapshot).toEqual(original.identity_snapshot);
    expect(await allLinks(db)).toEqual(before);
  },
);

it('[AC-B1-06d#14] BR-ATTR-05③：两位用户同时打开同一他人 link，归属分别隔离且不抢占原 link', async () => {
  const original = await sourceLink(db);
  const serviceB = ownerService(ownerFixture(db, { userId: USER_B }));
  const serviceC = ownerService(ownerFixture(db, { userId: USER_C }));
  const [resultB, resultC] = await Promise.all([
    serviceB.open({ linkId: original.link_id }),
    serviceC.open({ linkId: original.link_id }),
  ]);
  expect(new Set([original.link_id, resultB.new_link_id, resultC.new_link_id]).size).toBe(3);
  for (const [result, userId, attrCode] of [
    [resultB, USER_B, 'demo0002'],
    [resultC, USER_C, 'demo0003'],
  ] as const) {
    expect(result.new_link_id).toEqual(expect.any(String));
    expect(result.link).toEqual(await stored(db, result.new_link_id!));
    expect(result.link.user_id).toBe(userId);
    expect(result.identitySnapshot).toMatchObject({ user_id: userId, attr_code: attrCode });
    expect(result.old_final_price_fen).toBe('10000');
  }
  expect(await stored(db, original.link_id)).toEqual(original);
});

it('[AC-B1-06d#15] BR-ATTR-05①：分享 link 按 snapshot.user_id 归属，不按行上冗余 user_id 替换分享者', async () => {
  const source = await sourceLink(db, { scene: 'share' });
  await db
    .updateTable('links')
    .set({ user_id: USER_B })
    .where('link_id', '=', source.link_id)
    .execute();
  const original = await stored(db, source.link_id);
  const result = await ownerService(ownerFixture(db)).open({ linkId: original.link_id });
  expect(result.new_link_id).toBeNull();
  expect(result.identitySnapshot).toEqual(original.identity_snapshot);
  expect(result.identitySnapshot.user_id).toBe(USER_A);
  expect(await stored(db, original.link_id)).toEqual(original);
});

it('[AC-B1-06d#16] BR-PRICE-12：已有本人 amount_unknown link 的比较价保持 null，不冒充零价', async () => {
  const original = await unknownPriceLink(db);
  const before = await allLinks(db);
  const result = await ownerService(ownerFixture(db, { userId: USER_A })).open({
    linkId: original.link_id,
  });
  expect(result.link).toEqual(original);
  expect(result.old_final_price_fen).toBeNull();
  expect(result.new_link_id).toBeNull();
  expect(await allLinks(db)).toEqual(before);
});

it.each([DEVICE_A, DEVICE_B, null])(
  '[AC-B1-06d#17] BR-ATTR-05②/PRICE-12：游客 link 使用当前登录用户，设备 %s 不限制打开且保留比较基准',
  async (deviceId) => {
    const original = await sourceLink(db, { scene: 'search' }, { userId: null });
    const before = await allLinks(db);
    const f = ownerFixture(db, { userId: USER_B, deviceId });
    const result = await ownerService(f).open({ linkId: original.link_id });
    expect(result.new_link_id).toBeNull();
    expect(result.link.link_id).toBe(original.link_id);
    expect(result.link.user_id).toBe(USER_B);
    expect(result.link.app_id).toBe('register-app');
    expect(result.identitySnapshot.user_id).toBe(USER_B);
    expect(result.identitySnapshot.platform).toBe('taobao');
    expect(result.link).toEqual(await stored(db, result.link.link_id));
    expect(result.old_final_price_fen).toBe('10000');
    expect(await stored(db, original.link_id)).toMatchObject({
      user_id: USER_B,
      quoted_final_price_fen: original.quoted_final_price_fen,
      quoted_coupon_fen: original.quoted_coupon_fen,
      quoted_coupon_id: original.quoted_coupon_id,
      quoted_at: original.quoted_at,
    });
    expect(await allLinks(db)).toHaveLength(before.length);
  },
);

it('[AC-B1-06d#18] BR-ATTR-05②③：游客 link 被 B 认领后，C 打开新建自己的 link，不能改写 B 的归属', async () => {
  const original = await sourceLink(db, { scene: 'search' }, { userId: null });
  const before = await allLinks(db);
  const resultB = await ownerService(ownerFixture(db, { userId: USER_B })).open({
    linkId: original.link_id,
  });
  const claimed = await stored(db, original.link_id);
  expect(resultB.new_link_id).toBeNull();
  expect(resultB.link).toEqual(claimed);
  expect(claimed.user_id).toBe(USER_B);
  expect(resultB.identitySnapshot.user_id).toBe(USER_B);
  expect(await allLinks(db)).toHaveLength(before.length);

  const resultC = await ownerService(ownerFixture(db, { userId: USER_C })).open({
    linkId: original.link_id,
  });
  expect(resultC.new_link_id).toEqual(expect.any(String));
  expect(resultC.new_link_id).not.toBe(original.link_id);
  const fresh = await stored(db, resultC.new_link_id!);
  expect(resultC.link).toEqual(fresh);
  expect(fresh).toMatchObject({
    app_id: original.app_id,
    user_id: USER_C,
    platform: original.platform,
    product_key: original.product_key,
    scene: original.scene,
    pid_scene: original.pid_scene,
    quoted_final_price_fen: original.quoted_final_price_fen,
    quoted_coupon_fen: original.quoted_coupon_fen,
    quoted_coupon_id: original.quoted_coupon_id,
    quoted_at: original.quoted_at,
  });
  expect(resultC.identitySnapshot).toEqual(fresh.identity_snapshot);
  expect(resultC.identitySnapshot).toMatchObject({ user_id: USER_C, attr_code: 'demo0003' });
  expect(resultC.old_final_price_fen).toBe('10000');
  expect(await stored(db, original.link_id)).toEqual(claimed);
  expect(await allLinks(db)).toHaveLength(before.length + 1);
});

it('[AC-B1-06d#19] BR-ATTR-05②③：并发认领游客 link 只成功写入一次，未认领者得到自己的新 link', async () => {
  const original = await sourceLink(db, { scene: 'search' }, { userId: null });
  const before = await allLinks(db);
  // Observe real update results without changing SQL, results or execution order.
  // Zero affected rows is a lost conditional update; either user may win the claim.
  const ownershipUpdates = new WeakSet<object>();
  const affectedRows: bigint[] = [];
  const observedDb = db.withPlugin({
    transformQuery({ node, queryId }) {
      if (
        node.kind === 'UpdateQueryNode' &&
        node.table !== undefined &&
        TableNode.is(node.table) &&
        node.table.table.identifier.name === 'links' &&
        node.updates?.some(
          ({ column }) => ColumnNode.is(column) && column.column.name === 'user_id',
        )
      ) {
        ownershipUpdates.add(queryId);
      }
      return node;
    },
    async transformResult({ queryId, result }) {
      if (ownershipUpdates.has(queryId)) affectedRows.push(result.numAffectedRows ?? -1n);
      return result;
    },
  });
  const serviceB = ownerService(ownerFixture(observedDb, { userId: USER_B }));
  const serviceC = ownerService(ownerFixture(observedDb, { userId: USER_C }));
  const results = await Promise.all([
    serviceB.open({ linkId: original.link_id }),
    serviceC.open({ linkId: original.link_id }),
  ]);
  expect(affectedRows.filter((count) => count !== 0n)).toEqual([1n]);
  expect(results.filter((result) => result.new_link_id === null)).toHaveLength(1);
  const claimed = await stored(db, original.link_id);
  expect([USER_B, USER_C]).toContain(claimed.user_id);
  expect(claimed).toMatchObject({
    quoted_final_price_fen: original.quoted_final_price_fen,
    quoted_coupon_fen: original.quoted_coupon_fen,
    quoted_coupon_id: original.quoted_coupon_id,
    quoted_at: original.quoted_at,
  });
  for (const [result, userId, attrCode] of [
    [results[0], USER_B, 'demo0002'],
    [results[1], USER_C, 'demo0003'],
  ] as const) {
    expect(result.link.user_id).toBe(userId);
    expect(result.identitySnapshot).toMatchObject({ user_id: userId, attr_code: attrCode });
    expect(result.old_final_price_fen).toBe('10000');
    if (userId === claimed.user_id) {
      expect(result.new_link_id).toBeNull();
      expect(result.link).toEqual(claimed);
    } else {
      expect(result.new_link_id).toEqual(expect.any(String));
      expect(result.new_link_id).not.toBe(original.link_id);
      const fresh = await stored(db, result.new_link_id!);
      expect(result.link).toEqual(fresh);
      expect(fresh).toMatchObject({
        app_id: original.app_id,
        user_id: userId,
        scene: original.scene,
        pid_scene: original.pid_scene,
        product_key: original.product_key,
        quoted_final_price_fen: original.quoted_final_price_fen,
        quoted_coupon_fen: original.quoted_coupon_fen,
        quoted_coupon_id: original.quoted_coupon_id,
        quoted_at: original.quoted_at,
      });
      expect(fresh.identity_snapshot).toEqual(result.identitySnapshot);
    }
  }
  expect(await allLinks(db)).toHaveLength(before.length + 1);
});

it('[AC-B1-06d#20] BR-ATTR-05③/PRICE-08：他人拼多多 amount_unknown link 为当前用户新登记，不伪造报价', async () => {
  const original = await unknownPricePddLink(db);
  const before = await allLinks(db);
  const result = await ownerService(ownerFixture(db, { userId: USER_B })).open({
    linkId: original.link_id,
  });
  expect(result.new_link_id).toEqual(expect.any(String));
  expect(result.new_link_id).not.toBe(original.link_id);
  const fresh = await stored(db, result.new_link_id!);
  expect(result.link).toEqual(fresh);
  // links has no rebate_basis column: null product/quote fields represent amount_unknown.
  expect(fresh).toMatchObject({
    app_id: original.app_id,
    user_id: USER_B,
    platform: 'pdd',
    scene: original.scene,
    pid_scene: original.pid_scene,
    entry_source: original.entry_source,
    product_key: null,
    quoted_final_price_fen: null,
    quoted_coupon_fen: null,
    quoted_coupon_id: null,
    quoted_at: null,
  });
  expect(result.identitySnapshot).toEqual(fresh.identity_snapshot);
  expect(result.identitySnapshot).toMatchObject({
    user_id: USER_B,
    platform: 'pdd',
    attr_code: 'demo0002',
  });
  expect(result.old_final_price_fen).toBeNull();
  expect(await stored(db, original.link_id)).toEqual(original);
  expect(await allLinks(db)).toHaveLength(before.length + 1);
});
