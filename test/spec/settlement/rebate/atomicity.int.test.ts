import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { SettlementModule } from '../../../../apps/api/src/modules/settlement/index.ts';
import { fixture, at, NOW, RECEIVED, capture, noMoney, expectCas } from './kit.ts';

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
}, 30_000);

it.each(['ESTIMATED', 'WAITING'])(
  '[AC-B2-04j#26] UNMAPPED_STATUS 默认打开：%s 系统 hold 与审计同事务',
  async (state) => {
    const f = await fixture(db, { rebate_status: state, rights_pending: true });
    await f.unmapped();
    expect(await f.read()).toMatchObject({
      rebate_status: state,
      platform_status: 'PAID',
      hold: true,
      hold_reason: 'UNMAPPED_STATUS',
      rights_pending: true,
      row_version: f.initial.row_version + 1,
    });
    expect(f.get).toHaveBeenCalledWith(f.appId, 'order_sync.unmapped_status_hold.enabled');
    expect(f.audit).toHaveBeenCalledExactlyOnceWith(f.transactions[0], {
      ...f.ref,
      actor: 'system:risk',
      reason: 'UNMAPPED_STATUS',
      before: { hold: false, holdReason: null },
      after: { hold: true, holdReason: 'UNMAPPED_STATUS' },
      at: at(NOW),
    });
    expect(await f.events()).toEqual([expect.objectContaining({ name: 'test.hold_audit' })]);
    expectCas(f);
    await noMoney(db, f);
  },
);

it('[AC-B2-04j#27] UNMAPPED_STATUS 开关 off 只告警，打开后才 hold', async () => {
  const f = await fixture(db, { rebate_status: 'ESTIMATED' });
  f.configValues.set('order_sync.unmapped_status_hold.enabled', false);
  await f.unmapped();
  expect(await f.read()).toEqual(f.initial);
  expect(f.audit).not.toHaveBeenCalled();
  expect(f.logs.some((log) => Number(log['level']) >= 40)).toBe(true);
  f.configValues.set('order_sync.unmapped_status_hold.enabled', true);
  await f.unmapped();
  expect(await f.read()).toMatchObject({ hold: true, hold_reason: 'UNMAPPED_STATUS' });
  expect(f.audit).toHaveBeenCalledTimes(1);
});

it.each(['UNATTRIBUTED', 'CREDITED', 'VOID', 'CLAWED_BACK'])(
  '[AC-B2-04j#28] %s 不允许系统 hold，以数据库现态为准',
  async (state) => {
    const f = await fixture(db, { rebate_status: state });
    // Deliberately stale port metadata cannot authorize a hold after CREDITED/VOID.
    await f.unmapped('ESTIMATED');
    expect(await f.read()).toEqual(f.initial);
    expect(f.audit).not.toHaveBeenCalled();
    expect(f.logs.length).toBeGreaterThan(0);
    await noMoney(db, f);
  },
);

it('[AC-B2-04j#29] 过期 UNATTRIBUTED 提示不能漏掉库内 WAITING 的系统 hold', async () => {
  const f = await fixture(db, { rebate_status: 'WAITING' });
  await f.unmapped('UNATTRIBUTED');
  expect(await f.read()).toMatchObject({ hold: true, hold_reason: 'UNMAPPED_STATUS' });
  expect(f.audit).toHaveBeenCalledTimes(1);
});

it.each(['RISK', 'CS', 'UNMAPPED_STATUS'])(
  '[AC-B2-04j#30] 已 hold 原因 %s 不被重复系统 hold 覆盖，也不自动解除',
  async (reason) => {
    const f = await fixture(db, { rebate_status: 'ESTIMATED', hold: true, hold_reason: reason });
    await f.unmapped();
    await f.unmapped();
    await f.update();
    expect(await f.read()).toEqual(f.initial);
    expect(f.audit).not.toHaveBeenCalled();
    await noMoney(db, f);
  },
);

it('[AC-B2-04j#31] 系统审计写后抛错，hold、版本与审计标记全部回滚', async () => {
  const f = await fixture(db, { rebate_status: 'WAITING' });
  const write = f.audit.getMockImplementation()!;
  const failure = new Error('synthetic audit failure');
  f.audit.mockImplementation(async (trx, input) => {
    await write(trx, input);
    throw failure;
  });
  expect(await capture(() => f.unmapped())).toEqual({ ok: false, error: failure });
  expect(f.audit).toHaveBeenCalledTimes(1);
  expect(await f.read()).toEqual(f.initial);
  expect(await f.history()).toEqual([]);
  expect(await f.events()).toEqual([]);
  f.audit.mockImplementation(write);
  await f.unmapped();
  expect(await f.read()).toMatchObject({ hold: true });
  expect(await f.events()).toHaveLength(1);
});

it('[AC-B2-04j#32] order.invalidated 入队写后失败，状态、原因、历史与事件一起回滚', async () => {
  const f = await fixture(db, { rebate_status: 'ESTIMATED' });
  const write = f.publish.getMockImplementation()!;
  const failure = new Error('synthetic enqueue failure');
  f.publish.mockImplementation(async (trx, event) => {
    await write(trx, event);
    throw failure;
  });
  expect(
    await capture(() => f.run((trx, api) => api.apply(trx, f.command, 'RIGHTS_FULL'))),
  ).toEqual({ ok: false, error: failure });
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(await f.read()).toEqual(f.initial);
  expect(await f.history()).toEqual([]);
  expect(await f.events()).toEqual([]);
  f.publish.mockImplementation(write);
  await f.run((trx, api) => api.apply(trx, f.command, 'RIGHTS_FULL'));
  expect(await f.read()).toMatchObject({ rebate_status: 'VOID', reason: 'RIGHTS' });
  expect(await f.events()).toHaveLength(1);
  await noMoney(db, f);
});

it('[AC-B2-04j#33] 下游失败回滚 R2→R4 与调用者写入，返利端口不私开事务', async () => {
  const f = await fixture(db, { platform_status: 'RECEIVED', received_at: at(RECEIVED) });
  const failure = new Error('synthetic caller failure');
  const observed: string[] = [];
  expect(
    await capture(() =>
      f.run(async (trx, api) => {
        await trx
          .updateTable('orders')
          .set({ title: 'same transaction marker' })
          .where('app_id', '=', f.appId)
          .execute();
        await api.onImported(trx, f.imported);
        const row = await trx
          .selectFrom('orders')
          .select('rebate_status')
          .where('app_id', '=', f.appId)
          .executeTakeFirstOrThrow();
        observed.push(row.rebate_status);
        throw failure;
      }),
    ),
  ).toEqual({ ok: false, error: failure });
  expect(observed).toEqual(['WAITING']);
  expect(await f.read()).toEqual(f.initial);
  expect(await f.history()).toEqual([]);
  expect(f.refresh).toHaveBeenCalledWith(f.transactions[0], f.ref);
});

it('[AC-B2-04j#34] R7 预估重算失败连带回滚调用者佣金与退款更新', async () => {
  const f = await fixture(db, { rebate_status: 'WAITING' });
  const failure = new Error('synthetic estimate failure');
  f.refresh.mockRejectedValue(failure);
  expect(
    await capture(() =>
      f.run(async (trx, api) => {
        await trx
          .updateTable('orders')
          .set({ est_commission_fen: 800n, refunded_quantity: 1, commission_version: 2 })
          .where('app_id', '=', f.appId)
          .execute();
        await api.apply(trx, f.command, 'PARTIAL_REFUND');
      }),
    ),
  ).toEqual({ ok: false, error: failure });
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(await f.read()).toEqual(f.initial);
  expect(await f.history()).toEqual([]);
});

it('[AC-B2-04j#35] 同订单两连接在 order_key 锁下重放 R4，只迁移一次', async () => {
  const f = await fixture(db, {
    rebate_status: 'ESTIMATED',
    platform_status: 'RECEIVED',
    received_at: at(RECEIVED),
  });
  const origin = { event: 'PLATFORM_RECEIVED' as const, raw_status: 'synthetic' };
  await Promise.all([
    f.update({ from_status: 'PAID' }, origin),
    f.update({ from_status: 'PAID' }, origin),
  ]);
  expect(await f.read()).toMatchObject({
    rebate_status: 'WAITING',
    settle_period: '2027-01',
    row_version: 1,
  });
  expect(await f.history()).toEqual([expect.objectContaining({ to_status: 'WAITING' })]);
  expect(f.transactions).toHaveLength(2);
  expect(f.transactions[0]).not.toBe(f.transactions[1]);
  await noMoney(db, f);
});

it('[AC-B2-04j#36] 两连接重复系统 hold 只有一个审计和一次版本递增', async () => {
  const f = await fixture(db, { rebate_status: 'ESTIMATED' });
  await Promise.all([f.unmapped(), f.unmapped()]);
  expect(await f.read()).toMatchObject({
    hold: true,
    hold_reason: 'UNMAPPED_STATUS',
    row_version: 1,
  });
  expect(f.audit).toHaveBeenCalledTimes(1);
  expect(await f.events()).toHaveLength(1);
});

it('[AC-B2-04j#37] 第一次 CAS 零行必须重读再迁移，不能把零行当成功', async () => {
  let suppressed = false;
  // Fault injection changes the first UPDATE's WHERE to false: PostgreSQL really returns
  // zero affected rows. No fake result counts and no privileged triggers required.
  const conflictDb = db.withPlugin({
    transformQuery(args) {
      if (args.node.kind === 'UpdateQueryNode' && !suppressed) {
        suppressed = true;
        return {
          ...args.node,
          where: { kind: 'WhereNode', where: sql<boolean>`false`.toOperationNode() },
        };
      }
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  const f = await fixture(conflictDb, {
    rebate_status: 'ESTIMATED',
    platform_status: 'RECEIVED',
    received_at: at(RECEIVED),
  });
  await f.update({ from_status: 'PAID' }, { event: 'PLATFORM_RECEIVED', raw_status: 'synthetic' });
  expect(suppressed).toBe(true);
  expect(await f.read()).toMatchObject({ rebate_status: 'WAITING', row_version: 1 });
  expect(await f.history()).toHaveLength(1);
  const updateIndexes = f.queries.flatMap((q, i) => (/^update /i.test(q.sql) ? [i] : []));
  expect(updateIndexes.length).toBeGreaterThanOrEqual(2);
  expect(
    f.queries
      .slice(updateIndexes[0]! + 1, updateIndexes[1]!)
      .some((q) => /^select /i.test(q.sql) && q.sql.includes('"orders"')),
  ).toBe(true);
});

it('[AC-B2-04j#38] 错误 app_id 不得修改另一个 App 的同 order_id', async () => {
  const f = await fixture(db, { rebate_status: 'ESTIMATED' });
  const other = await fixture(db, { rebate_status: 'ESTIMATED' });
  const result = await capture(() =>
    f.run((trx, api) => api.apply(trx, { ...f.command, appId: other.appId }, 'BLACKLIST_HIT')),
  );
  expect(result.ok).toBe(false);
  expect(await f.read()).toEqual(f.initial);
  expect(await other.read()).toEqual(other.initial);
  expect(await f.history()).toEqual([]);
  expect(await other.history()).toEqual([]);
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.refresh).not.toHaveBeenCalled();
});

it('[AC-B2-04j#39] 错误分区时间不能命中相同订单，也不能发失效事件', async () => {
  const f = await fixture(db, { rebate_status: 'ESTIMATED' });
  const result = await capture(() =>
    f.run((trx, api) =>
      api.apply(trx, { ...f.command, attrAt: at('2026-11-15T04:00:00Z') }, 'PLATFORM_INVALID'),
    ),
  );
  expect(result.ok).toBe(false);
  expect(await f.read()).toEqual(f.initial);
  expect(await f.history()).toEqual([]);
  expect(f.publish).not.toHaveBeenCalled();
});

it('[AC-B2-04j#40] 独立 settlement 模块可声明，生产 orders 接线留给后续任务', async () => {
  const f = await fixture(db);
  const module = SettlementModule.register(f.deps);
  expect(module.module).toBe(SettlementModule);
  expect(module.providers?.length).toBeGreaterThan(0);
  expect(module.exports?.length).toBeGreaterThan(0);
});
