// B1-09m：归因流水线黑名单步按规则启停判定（08 BR-ID-36 细则「规则清单的启停」、BR-ATTR-26；D10-536 (b)、D10-537）。
// 规则码只有 BLACKLIST_HIT，不分维度；规则状态只经 risk 的名单端口读，按配置项的缓存周期生效，不追溯。
// 流水线、更新步、名单行与 risk 端口都是真实的；settlement 的 R6 由 kit 的假实现代表（kit.ts 文件头）。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { hitView, publishedOf, seedChannel, seedSuffix } from '../blacklist/kit.ts';
import { AFTER_CREDIT, PARENT_HIT, PARENT_MISS, PRECREDIT } from '../blacklist/plan-kit.ts';
import { INSERTED, TTL_MS, UPDATED, freshOrder, setRule, sharePorts, storedOrder } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 180_000);

const STORED = [...PRECREDIT, 'CREDITED'] as const;

it.each([
  ['渠道名单', 'channel', false],
  ['尾号名单（作废开关开）', 'order_no_suffix', true],
  ['尾号名单（作废开关关，本应进人工复核）', 'order_no_suffix', false],
] as const)(
  '[AC-B1-09m#1][BR-ID-36][BR-ATTR-26] 首次入库，规则停用：%s命中不判定，不写 risk_hits、不作废、不进人工复核；启用并过缓存周期后下一条子订单才判定，已入库的不追溯',
  async (_label, dimension, suffixOn) => {
    const parent = dimension === 'channel' ? PARENT_MISS : PARENT_HIT;
    const f = await freshOrder(db, { parent_order_id: parent }, { suffixOn });
    await (dimension === 'channel' ? seedChannel(db, f) : seedSuffix(db, f));
    await f.setRule('disabled');
    expect(await f.run()).toMatchObject(INSERTED);
    const during = await f.read();
    expect(during.orders).toHaveLength(1);
    expect(during.orders[0]).toMatchObject({
      sub_order_id: f.incoming.sub_order_id,
      rebate_status: 'UNATTRIBUTED',
      reason: null,
      user_id: f.userId,
      buy_type: 'share',
    });
    expect(f.match).toHaveBeenCalledTimes(1);
    await f.expectNothingDecided();
    expect(await f.ruleRows()).toEqual([{ status: 'disabled', version: 1 }]);

    await f.setRule('enabled');
    f.clock.advanceMs(TTL_MS);
    const subOrderId = randomUUID();
    expect(await f.run({ ...f.incoming, sub_order_id: subOrderId })).toMatchObject(INSERTED);
    const after = await f.read();
    expect(after.orders).toHaveLength(2);
    const earlier = after.orders.find((row) => row.sub_order_id === f.incoming.sub_order_id);
    const later = after.orders.find((row) => row.sub_order_id === subOrderId);
    expect(earlier).toMatchObject({ rebate_status: 'UNATTRIBUTED', reason: null });
    const voids = dimension === 'channel' || suffixOn;
    expect(later).toMatchObject(
      voids
        ? { rebate_status: 'VOID', reason: 'BLACKLIST' }
        : { rebate_status: 'UNATTRIBUTED', reason: null },
    );
    expect(after.hits.map(hitView)).toEqual([
      f.expectedHit(voids ? 'void_commission' : 'manual_review', later!.order_id, dimension),
    ]);
    expect(f.onBlacklistHit).toHaveBeenCalledTimes(voids ? 1 : 0);
    f.expectOneReadPerJudgement(2);
  },
);

it.each(STORED)(
  '[AC-B1-09m#2][BR-ID-36][BR-ATTR-26] 存量订单，规则停用：下一次同步更新不判定，不作废、不发 order.blacklist_hit_after_credit，状态迁移照常；启用并过缓存周期后再次同步才判定（已入账同样）：%s',
  async (status) => {
    const f = await storedOrder(db, status);
    await seedChannel(db, f);
    await f.setRule('disabled');
    expect(await f.update()).toMatchObject(UPDATED);
    expect(f.match).toHaveBeenCalledTimes(1);
    expect(f.onUpdated).toHaveBeenCalledTimes(1);
    await f.expectNothingDecided();
    expect((await f.read()).orders[0]).toMatchObject({ rebate_status: status, reason: null });

    await f.setRule('enabled');
    f.clock.advanceMs(TTL_MS);
    expect(await f.update()).toMatchObject(UPDATED);
    const voids = status !== 'CREDITED';
    const after = await f.read();
    expect(after.hits.map(hitView)).toEqual([
      f.expectedHit(voids ? 'void_commission' : 'manual_review', f.before.order_id),
    ]);
    expect(after.orders[0]).toMatchObject(
      voids
        ? { rebate_status: 'VOID', reason: 'BLACKLIST' }
        : { rebate_status: 'CREDITED', reason: null },
    );
    expect(f.onBlacklistHit).toHaveBeenCalledTimes(voids ? 1 : 0);
    expect(publishedOf(f, AFTER_CREDIT)).toHaveLength(voids ? 0 : 1);
    expect(f.onUpdated).toHaveBeenCalledTimes(2);
    f.expectOneReadPerJudgement(2);
  },
);

it.each([
  ['状态 enabled', 'enabled'],
  ['状态 active（写者惰性登记）', 'active'],
  ['没有规则行', null],
] as const)(
  '[AC-B1-09m#3][BR-ID-36][BR-ATTR-26] 规则生效时行为不变：作废并写 void_commission 命中，已有规则行不被改写，没有规则行时惰性登记 active：%s',
  async (_label, status) => {
    const f = await freshOrder(db);
    await seedChannel(db, f);
    if (status !== null) await f.setRule(status);
    expect(await f.run()).toMatchObject(INSERTED);
    const after = await f.read();
    const row = after.orders[0]!;
    expect(row).toMatchObject({ rebate_status: 'VOID', reason: 'BLACKLIST' });
    expect(after.hits.map(hitView)).toEqual([f.expectedHit('void_commission', row.order_id)]);
    expect(f.onBlacklistHit).toHaveBeenCalledTimes(1);
    expect(publishedOf(f, AFTER_CREDIT)).toEqual([]);
    expect(await f.ruleRows()).toEqual([{ status: status ?? 'active', version: 1 }]);
    f.expectOneReadPerJudgement(1);
  },
);

it('[AC-B1-09m#4][BR-ID-36][BR-ATTR-26] 渠道与尾号同时命中：一次判定只读一次规则状态，两条命中都写', async () => {
  const f = await freshOrder(db, { parent_order_id: PARENT_HIT }, { suffixOn: true });
  await seedChannel(db, f);
  await seedSuffix(db, f);
  expect(await f.run()).toMatchObject(INSERTED);
  const after = await f.read();
  const row = after.orders[0]!;
  expect(row).toMatchObject({ rebate_status: 'VOID', reason: 'BLACKLIST' });
  expect(after.hits).toHaveLength(2);
  expect(after.hits.map(hitView)).toEqual(
    expect.arrayContaining([
      f.expectedHit('void_commission', row.order_id, 'channel'),
      f.expectedHit('void_commission', row.order_id, 'order_no_suffix'),
    ]),
  );
  expect(f.onBlacklistHit).toHaveBeenCalledTimes(1);
  f.expectOneReadPerJudgement(1);
});

it('[AC-B1-09m#5][BR-ID-36][BR-ATTR-26] 停用按缓存周期生效：周期内的判定仍按启用，满周期后不判定，已写的命中不动', async () => {
  const f = await storedOrder(db, 'CREDITED');
  await seedChannel(db, f);
  await f.setRule('enabled');
  expect(await f.ruleInForce()).toBe(true);
  await f.setRule('disabled');
  f.clock.advanceMs(TTL_MS - 1);
  expect(await f.update()).toMatchObject(UPDATED);
  const judged = await f.read();
  expect(judged.hits.map(hitView)).toEqual([f.expectedHit('manual_review', f.before.order_id)]);
  expect(publishedOf(f, AFTER_CREDIT)).toHaveLength(1);

  f.clock.advanceMs(1);
  expect(await f.update()).toMatchObject(UPDATED);
  expect((await f.read()).hits).toEqual(judged.hits);
  expect(publishedOf(f, AFTER_CREDIT)).toHaveLength(1);
  f.expectOneReadPerJudgement(2);
});

it('[AC-B1-09m#6][BR-ID-36][BR-ATTR-26] 启用按缓存周期生效：周期内仍不判定，满周期后的下一次同步才判定', async () => {
  const f = await storedOrder(db, 'ESTIMATED');
  await seedChannel(db, f);
  await f.setRule('disabled');
  expect(await f.ruleInForce()).toBe(false);
  await f.setRule('enabled');
  f.clock.advanceMs(TTL_MS - 1);
  expect(await f.update()).toMatchObject(UPDATED);
  await f.expectNothingDecided();

  f.clock.advanceMs(1);
  expect(await f.update()).toMatchObject(UPDATED);
  const after = await f.read();
  expect(after.orders[0]).toMatchObject({ rebate_status: 'VOID', reason: 'BLACKLIST' });
  expect(after.hits.map(hitView)).toEqual([f.expectedHit('void_commission', f.before.order_id)]);
  f.expectOneReadPerJudgement(2);
});

it.each([
  ['未入账作废的命中', 'ESTIMATED', 'void_commission'],
  ['已入账待复核的命中', 'CREDITED', 'manual_review'],
] as const)(
  '[AC-B1-09m#7][BR-ID-36][BR-ATTR-26] 已写的命中在停用后不变，不撤销处置、不追溯（被作废的用户仍有命中可申诉）：%s',
  async (_label, status, action) => {
    const f = await storedOrder(db, status);
    await seedChannel(db, f);
    await f.setRule('enabled');
    expect(await f.update()).toMatchObject(UPDATED);
    const written = await f.read();
    expect(written.hits.map(hitView)).toEqual([f.expectedHit(action, f.before.order_id)]);
    const published = publishedOf(f, AFTER_CREDIT).length;

    await f.setRule('disabled');
    f.clock.advanceMs(TTL_MS);
    expect(await f.update()).toMatchObject(UPDATED);
    const after = await f.read();
    expect(after.hits).toEqual(written.hits);
    expect(after.orders[0]).toMatchObject({
      rebate_status: written.orders[0]!.rebate_status,
      reason: written.orders[0]!.reason,
    });
    expect(publishedOf(f, AFTER_CREDIT)).toHaveLength(published);
    expect(f.recordHit).toHaveBeenCalledTimes(1);
    f.expectOneReadPerJudgement(2);
  },
);

it.each([
  ['停用的 App 先判定', true],
  ['启用的 App 先判定', false],
] as const)(
  '[AC-B1-09m#8][BR-ID-36] 跨 App：同一读口与缓存下，一个 App 停用不影响另一个，两边都有真实规则行与名单行：%s',
  async (_label, disabledFirst) => {
    const on = await storedOrder(db, 'ESTIMATED');
    const off = await storedOrder(db, 'ESTIMATED');
    sharePorts(on, off);
    await seedChannel(db, on);
    await seedChannel(db, off);
    await on.setRule('enabled');
    await off.setRule('disabled');
    for (const f of disabledFirst ? [off, on] : [on, off]) {
      expect(await f.update()).toMatchObject(UPDATED);
    }
    expect(on.reads).toContainEqual(off.ruleKey);

    await off.expectNothingDecided();
    expect((await off.read()).orders[0]).toMatchObject({
      rebate_status: 'ESTIMATED',
      reason: null,
    });
    const after = await on.read();
    expect(after.orders[0]).toMatchObject({ rebate_status: 'VOID', reason: 'BLACKLIST' });
    expect(after.hits.map(hitView)).toEqual([
      on.expectedHit('void_commission', on.before.order_id),
    ]);
    on.expectOneReadPerJudgement(1);
  },
);

it('[AC-B1-09m#9][BR-ID-36] 启停按规则：同 App 别的规则停用（BLACKLIST_PHONE）不影响订单黑名单判定', async () => {
  const f = await freshOrder(db);
  await seedChannel(db, f);
  await setRule(db, f.ctx.app_id, 'BLACKLIST_PHONE', 'disabled', f.clock.now());
  expect(await f.run()).toMatchObject(INSERTED);
  const after = await f.read();
  const row = after.orders[0]!;
  expect(row).toMatchObject({ rebate_status: 'VOID', reason: 'BLACKLIST' });
  expect(after.hits.map(hitView)).toEqual([f.expectedHit('void_commission', row.order_id)]);
  f.expectOneReadPerJudgement(1);
});
