// 范围：BR-CALC-02/10/13 的快照读取；不测试快照生成、用户状态判定或账务写入。
// 调用方从 orders 取得当前 commission_version 后传入，commission 不跨模块读订单表。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { appendVersion, AT, commission, EARLIER, event, fixture, rows, seed } from './fixtures.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
let readonlyDb: Kysely<DB>;

beforeAll(async () => {
  // globalSetup 经 TEST_PG_ADMIN_URL 建模板；此处只使用一次性测试库的业务角色。
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonlyDb = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
}, 60_000);

afterAll(async () => {
  try {
    if (readonlyDb) await destroyDb(readonlyDb);
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 60_000);

it('[AC-B2-04i#1] BR-CALC-02/10 经公开出口读 v1 的整数分、预留与全部不可变受益人', async () => {
  const f = fixture();
  await seed(db, f);
  const result = await db
    .transaction()
    .execute((trx) => commission.readCommissionSnapshot(trx, f.input));
  expect(result).toEqual({
    appId: f.input.appId,
    orderId: f.input.orderId,
    ruleVersionId: f.ruleVersionId,
    commissionVersion: 1,
    baseFen: 850n,
    reserveBp: 1500,
    beneficiaries: expect.arrayContaining(f.people),
    forfeitedEvents: [],
  });
  expect(result?.beneficiaries).toHaveLength(3);
});

it('[AC-B2-04i#2] BR-CALC-02/10 取最大版本，调用方期望版本不一致时报错', async () => {
  const f = fixture();
  await seed(db, f);
  // BR-CALC-10 细则：读取时取最大版本；期望版本必须与其一致（decision 39）。
  // 最大版本先写且时间更早，不能用写入顺序或 created_at 代替版本号。
  await appendVersion(db, f, 3, 2550n, 3000n, [1275n, 255n, 127n], 1657n, EARLIER);
  await appendVersion(db, f, 2, 1700n, 2000n, [850n, 170n, 85n], 1105n, AT);
  const result = await db
    .transaction()
    .execute((trx) => commission.readCommissionSnapshot(trx, { ...f.input, commissionVersion: 3 }));
  expect(result).toMatchObject({
    commissionVersion: 3,
    baseFen: 2550n,
    reserveBp: 1500,
    ruleVersionId: f.ruleVersionId,
  });
  expect(result?.beneficiaries).toEqual(expect.arrayContaining(f.people));
  expect(result?.beneficiaries).toHaveLength(3);
  await db.transaction().execute(async (trx) => {
    // 即使旧版本存在也必须拒绝，不能按调用方传值返回旧金额。
    await expect(
      commission.readCommissionSnapshot(trx, { ...f.input, commissionVersion: 2 }),
    ).rejects.toThrow();
  });
});

it('[AC-B2-04i#3] BR-CALC-10 无快照返回 null，重复读取不补建快照', async () => {
  const f = fixture();
  await db
    .withSchema('app')
    .insertInto('order_keys')
    .values({
      app_id: f.input.appId,
      order_id: f.input.orderId,
      platform: 'taobao',
      sub_order_id: `synthetic-${f.input.orderId}`,
      attr_at: AT,
    })
    .execute();
  await db.transaction().execute(async (trx) => {
    expect(await commission.readCommissionSnapshot(trx, f.input)).toBeNull();
    expect(
      await commission.readCommissionSnapshot(trx, { ...f.input, orderId: randomUUID() }),
    ).toBeNull();
  });
  expect(await rows(db, f)).toEqual({ splits: [], totals: [], amounts: [], events: [] });
});

it('[AC-B2-04i#4] BR-CALC-02/10 指定版本缺失时拒绝，不回退旧金额或按零处理', async () => {
  const f = fixture();
  await seed(db, f);
  await db.transaction().execute(async (trx) => {
    // 先要求有效读取成功，避免 NotImplemented 被负向断言误当通过。
    expect((await commission.readCommissionSnapshot(trx, f.input))?.baseFen).toBe(850n);
    await expect(
      commission.readCommissionSnapshot(trx, { ...f.input, commissionVersion: 2 }),
    ).rejects.toThrow();
    expect((await commission.readCommissionSnapshot(trx, f.input))?.baseFen).toBe(850n);
  });
});

it('[AC-B2-04i#5] BR-CALC-10/13 按 app 与子订单隔离快照、版本和同一受益人的事件', async () => {
  const f = fixture();
  const sibling = fixture();
  sibling.input = { ...sibling.input, appId: f.input.appId };
  // 同 app 的已发布规则版本生效时间必须唯一，避免夹具先于读取断言失败。
  sibling.ruleEffectiveFrom = new Date('2026-10-18T01:00:00Z');
  sibling.people[0] = { ...sibling.people[0]!, role: 'share', ratioBp: 4000 };
  sibling.people[1] = { ...f.people[1]!, ratioBp: 1200 };
  sibling.people[2] = { ...sibling.people[2]!, ratioBp: 600 };
  const otherApp = fixture();
  otherApp.people[0] = { ...otherApp.people[0]!, role: 'share', ratioBp: 3000 };
  otherApp.people[1] = { ...otherApp.people[1]!, ratioBp: 1500 };
  otherApp.people[2] = { ...f.people[2]!, ratioBp: 700 };
  await seed(db, f);
  // 对照订单的 B、预留、受益人/角色/比例、ruleVersionId 均不同；
  // 保留各一个相同 userId + role，仍能识别跨订单、跨 app 混入的事件。
  // sibling: N=2000、预留 2000bp → B=1600；份额 640+192+96=928。
  await seed(db, sibling, [640n, 192n, 96n], 928n, 672n, {
    rawNFen: 2000n,
    baseFen: 1600n,
    reserveBp: 2000,
    reserveFen: 400n,
  });
  // otherApp: N=3000、预留 3000bp → B=2100；份额 630+315+147=1092。
  await seed(db, otherApp, [630n, 315n, 147n], 1092n, 1008n, {
    rawNFen: 3000n,
    baseFen: 2100n,
    reserveBp: 3000,
    reserveFen: 900n,
  });
  await appendVersion(db, sibling, 2, 2400n, 3000n, [960n, 288n, 144n], 1392n, AT);
  await event(db, sibling, sibling.people[1]!, 'forfeited', 'banned', AT);
  await event(db, otherApp, otherApp.people[2]!, 'forfeited', 'minor', AT);
  await db.transaction().execute(async (trx) => {
    const result = await commission.readCommissionSnapshot(trx, f.input);
    expect(result).toEqual({
      appId: f.input.appId,
      orderId: f.input.orderId,
      ruleVersionId: f.ruleVersionId,
      commissionVersion: 1,
      baseFen: 850n,
      reserveBp: 1500,
      beneficiaries: expect.arrayContaining(f.people),
      forfeitedEvents: [],
    });
    expect(result?.beneficiaries).toHaveLength(3);
    expect(
      await commission.readCommissionSnapshot(trx, { ...f.input, appId: otherApp.input.appId }),
    ).toBeNull();
    expect(
      await commission.readCommissionSnapshot(trx, { ...otherApp.input, appId: f.input.appId }),
    ).toBeNull();
  });
});

it('[AC-B2-04i#14] BR-CALC-02/10 同 app 同版本的两单在同一事务内分别读取自己的 B 与受益人', async () => {
  const f = fixture();
  const sibling = fixture();
  sibling.input = { ...sibling.input, appId: f.input.appId };
  // 同 app 已发布规则的生效时间不同，避免夹具撞唯一约束。
  sibling.ruleEffectiveFrom = new Date('2026-10-18T01:00:00Z');
  sibling.people[0] = { ...sibling.people[0]!, role: 'share', ratioBp: 4000 };
  sibling.people[1] = { ...sibling.people[1]!, ratioBp: 1200 };
  sibling.people[2] = { ...sibling.people[2]!, ratioBp: 600 };
  await seed(db, f);
  await seed(db, sibling, [640n, 192n, 96n], 928n, 672n, {
    rawNFen: 2000n,
    baseFen: 1600n,
    reserveBp: 2000,
    reserveFen: 400n,
  });
  // 两单当前最大版本均为 2：B 分别为 2000×85%=1700、3000×80%=2400。
  await appendVersion(db, f, 2, 1700n, 2000n, [850n, 170n, 85n], 1105n, AT);
  await appendVersion(db, sibling, 2, 2400n, 3000n, [960n, 288n, 144n], 1392n, AT);
  await db.transaction().execute(async (trx) => {
    // 分别读取两单：若金额查询漏 order_id 而返回同一行，至少一单的 B 断言失败。
    const first = await commission.readCommissionSnapshot(trx, {
      ...f.input,
      commissionVersion: 2,
    });
    const second = await commission.readCommissionSnapshot(trx, {
      ...sibling.input,
      commissionVersion: 2,
    });
    expect(first).toEqual({
      appId: f.input.appId,
      orderId: f.input.orderId,
      ruleVersionId: f.ruleVersionId,
      commissionVersion: 2,
      baseFen: 1700n,
      reserveBp: 1500,
      beneficiaries: expect.arrayContaining(f.people),
      forfeitedEvents: [],
    });
    expect(first?.beneficiaries).toHaveLength(3);
    expect(second).toEqual({
      appId: sibling.input.appId,
      orderId: sibling.input.orderId,
      ruleVersionId: sibling.ruleVersionId,
      commissionVersion: 2,
      baseFen: 2400n,
      reserveBp: 2000,
      beneficiaries: expect.arrayContaining(sibling.people),
      forfeitedEvents: [],
    });
    expect(second?.beneficiaries).toHaveLength(3);
  });
});

it('[AC-B2-04i#6] BR-CALC-13 返回所有没收事件及原因，不混入 active/held，不按时间错排', async () => {
  const f = fixture();
  await seed(db, f);
  await event(db, f, f.people[1]!, 'held', 'frozen', EARLIER);
  await event(db, f, f.people[2]!, 'held', 'appealing', EARLIER);
  const banned = await event(db, f, f.people[1]!, 'forfeited', 'banned', AT);
  const minor = await event(db, f, f.people[2]!, 'forfeited', 'minor', EARLIER);
  const deleted = await event(db, f, f.people[0]!, 'forfeited', 'deleted', AT);
  await appendVersion(db, f, 2, 1700n, 2000n, [850n, 170n, 85n], 1105n, AT);
  const result = await db
    .transaction()
    .execute((trx) => commission.readCommissionSnapshot(trx, { ...f.input, commissionVersion: 2 }));
  expect(result?.forfeitedEvents).toEqual([banned, minor, deleted]);
  // 事件叠加不覆盖快照比例，不移除受益人，也不把直推比例转给间推。
  expect(result?.beneficiaries).toEqual(expect.arrayContaining(f.people));
  expect(result?.beneficiaries).toHaveLength(3);
});

it('[AC-B2-04i#7] BR-CALC-13 按 user_id 与 role 区分同一人的份额，held 不等于没收', async () => {
  const f = fixture();
  f.people[1] = { ...f.people[1]!, userId: f.people[0]!.userId };
  await seed(db, f);
  const forfeited = await event(db, f, f.people[1]!, 'forfeited', 'minor', AT);
  await event(db, f, f.people[2]!, 'held', 'appealing', AT);
  const result = await db
    .transaction()
    .execute((trx) => commission.readCommissionSnapshot(trx, f.input));
  expect(result?.forfeitedEvents).toEqual([forfeited]);
  expect(result?.beneficiaries).toEqual(expect.arrayContaining(f.people));
  expect(result?.beneficiaries).toHaveLength(3);
});

it('[AC-B2-04i#8] BR-CALC-10 调用方未提交的快照、追加版本与事件都可见，回滚仍归调用方', async () => {
  const f = fixture();
  const rollback = new Error('caller rollback');
  await expect(
    db.transaction().execute(async (trx) => {
      await seed(trx, f);
      expect((await commission.readCommissionSnapshot(trx, f.input))?.baseFen).toBe(850n);
      await appendVersion(trx, f, 2, 1700n, 2000n, [850n, 170n, 85n], 1105n, AT);
      const forfeited = await event(trx, f, f.people[1]!, 'forfeited', 'banned', AT);
      const result = await commission.readCommissionSnapshot(trx, {
        ...f.input,
        commissionVersion: 2,
      });
      expect(result).toMatchObject({ baseFen: 1700n, forfeitedEvents: [forfeited] });
      // 第二个连接仍不可见；实现不能私自提交调用方事务。
      expect(await rows(db, f)).toEqual({ splits: [], totals: [], amounts: [], events: [] });
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await rows(db, f)).toEqual({ splits: [], totals: [], amounts: [], events: [] });
});

it('[AC-B2-04i#9] BR-CALC-10/13 只读角色与 READ ONLY 事务可执行，重复读不改四张表', async () => {
  const f = fixture();
  await seed(db, f);
  const forfeited = await event(db, f, f.people[1]!, 'forfeited', 'deleted', AT);
  const before = await rows(db, f);
  await readonlyDb.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    const first = await commission.readCommissionSnapshot(trx, f.input);
    expect(first).toMatchObject({ baseFen: 850n, forfeitedEvents: [forfeited] });
    expect(await commission.readCommissionSnapshot(trx, f.input)).toEqual(first);
    expect(await rows(trx, f)).toEqual(before);
  });
  expect(await rows(db, f)).toEqual(before);
});

it('[AC-B2-04i#10] BR-CALC-02 当前版本 B=0 仍有快照与比例，不用初始金额替代', async () => {
  const f = fixture();
  await seed(db, f);
  await appendVersion(db, f, 2, 0n, 0n, [0n, 0n, 0n], 0n, AT);
  const result = await db
    .transaction()
    .execute((trx) => commission.readCommissionSnapshot(trx, { ...f.input, commissionVersion: 2 }));
  expect(result).toMatchObject({ commissionVersion: 2, baseFen: 0n, reserveBp: 1500 });
  expect(result?.beneficiaries).toEqual(expect.arrayContaining(f.people));
  expect(result?.beneficiaries).toHaveLength(3);
});

it('[AC-B2-04i#11] BR-CALC-02 bigint 金额超过安全整数仍逐分准确', async () => {
  const f = fixture();
  await seed(db, f);
  await appendVersion(
    db,
    f,
    2,
    10000000000000001n,
    11764705882352943n,
    [5000000000000000n, 1000000000000000n, 500000000000000n],
    6500000000000000n,
    AT,
  );
  const result = await db
    .transaction()
    .execute((trx) => commission.readCommissionSnapshot(trx, { ...f.input, commissionVersion: 2 }));
  expect(result?.baseFen).toBe(10000000000000001n);
  expect(typeof result?.baseFen).toBe('bigint');
});

it('[AC-B2-04i#12] BR-CALC-10/13 分享角色与初始没收原样保留，不重新判定用户状态', async () => {
  const f = fixture();
  f.people[0] = { ...f.people[0]!, role: 'share' };
  f.people[1] = { ...f.people[1]!, initialStatus: 'forfeited', forfeitReason: 'deleted' };
  await seed(db, f, [425n, 0n, 42n], 467n, 383n);
  const stored = await rows(db, f);
  const initialEvent = stored.events.find((e) => e.status === 'forfeited')!;
  const result = await db
    .transaction()
    .execute((trx) => commission.readCommissionSnapshot(trx, f.input));
  expect(result?.beneficiaries).toEqual(expect.arrayContaining(f.people));
  expect(result?.beneficiaries).toHaveLength(3);
  expect(result?.forfeitedEvents).toEqual([
    {
      eventSeq: initialEvent.event_seq,
      userId: f.people[1]!.userId,
      role: 'direct',
      reason: 'deleted',
    },
  ]);
});

it('[AC-B2-04i#13] BR-CALC-10 请求仅同 app 对照订单拥有的版本时报错', async () => {
  const f = fixture();
  const sibling = fixture();
  sibling.input = { ...sibling.input, appId: f.input.appId };
  // 同 app 的已发布规则版本生效时间必须唯一，避免夹具先于读取断言失败。
  sibling.ruleEffectiveFrom = new Date('2026-10-18T01:00:00Z');
  sibling.people[0] = { ...sibling.people[0]!, role: 'share', ratioBp: 4000 };
  sibling.people[1] = { ...sibling.people[1]!, ratioBp: 1200 };
  sibling.people[2] = { ...sibling.people[2]!, ratioBp: 600 };
  await seed(db, f);
  await seed(db, sibling, [640n, 192n, 96n], 928n, 672n, {
    rawNFen: 2000n,
    baseFen: 1600n,
    reserveBp: 2000,
    reserveFen: 400n,
  });
  await appendVersion(db, sibling, 2, 2400n, 3000n, [960n, 288n, 144n], 1392n, AT);
  await db.transaction().execute(async (trx) => {
    // 有效读取先成功，避免把骨架抛错误当成负向用例通过。
    expect((await commission.readCommissionSnapshot(trx, f.input))?.baseFen).toBe(850n);
    await expect(
      commission.readCommissionSnapshot(trx, { ...f.input, commissionVersion: 2 }),
    ).rejects.toThrow();
    expect(
      (await commission.readCommissionSnapshot(trx, { ...sibling.input, commissionVersion: 2 }))
        ?.baseFen,
    ).toBe(2400n);
  });
});
