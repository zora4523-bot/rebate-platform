import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { setup, succeed, splits, capture, HOUR, MANUAL } from './kit.ts';

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

it('[AC-B1-08t#9] 定时扫描严格超过一小时才补偿，使用注入时钟并按 App 隔离', async () => {
  const f = await setup(db);
  const other = await setup(db);
  const beforeOther = await other.pending();
  await succeed(f, db);
  f.clock.advanceMs(HOUR - 1);
  await f.scan();
  expect(f.port.create).not.toHaveBeenCalled();
  f.clock.advanceMs(1);
  await f.scan();
  expect(f.port.create).not.toHaveBeenCalled();
  f.clock.advanceMs(1);
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect((await f.pending())[0]).toMatchObject({ status: 'resolved', resolved_at: f.clock.now() });
  expect(await other.pending()).toEqual(beforeOther);
  expect(await splits(db, other.ctx.app_id)).toEqual([]);
  expect(f.readInput.mock.calls[0]?.[0]).toBe(f.port.create.mock.calls[0]?.[0]);
  expect(f.port.create.mock.calls[0]?.[1]).toMatchObject({
    paidAt: f.current.paid_at,
    ownerUserId: f.userId,
    appId: f.ctx.app_id,
  });
});

it('[AC-B1-08t#10] 多条到期待处理按订单去重，重复投递和已处置记录不再调用', async () => {
  const f = await setup(db);
  await f.addPending({});
  await f.addPending({ reason: 'SERVICE_FEE_RATE_MISSING', status: 'dismissed' });
  await f.addPending({ reason: 'NO_RECEIVED_AT', detail: null });
  await succeed(f, db);
  f.clock.advanceMs(HOUR + 1);
  const before = await f.pending();
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(1);
  const after = await f.pending();
  expect(
    after
      .filter((p) => ['RULE_VERSION_PLATFORM_MISSING', 'AMOUNT_PARSE_FAILED'].includes(p.reason))
      .map((p) => p.status),
  ).toEqual(['resolved', 'resolved']);
  for (const row of before.filter(
    (p) => !['RULE_VERSION_PLATFORM_MISSING', 'AMOUNT_PARSE_FAILED'].includes(p.reason),
  )) {
    expect(after.find((p) => p.id === row.id)).toEqual(row);
  }
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(1);
});

it.each(['unattributed', 'DEPOSIT_PAID', 'INVALID', 'VOID', 'CLAWED_BACK'] as const)(
  '[AC-B1-08t#11] 定时扫描锁内重读资格，%s 不调用快照端口也不处置',
  async (state) => {
    const f = await setup(db);
    await db
      .updateTable('orders')
      .set(
        state === 'unattributed'
          ? { user_id: null }
          : state === 'VOID' || state === 'CLAWED_BACK'
            ? { rebate_status: state }
            : { platform_status: state },
      )
      .where('app_id', '=', f.ctx.app_id)
      .execute();
    f.clock.advanceMs(HOUR + 1);
    const before = await f.pending();
    await f.scan();
    expect(f.port.create).not.toHaveBeenCalled();
    expect(await f.pending()).toEqual(before);
  },
);

it('[AC-B1-08t#12] 刷新 detected_at 不延后未处置时长；超过24小时仍 pending 才告警转人工', async () => {
  const f = await setup(db);
  const first = (await f.pending())[0]!;
  f.clock.advanceMs(24 * HOUR);
  await db
    .updateTable('order_sync_pending')
    .set({ detected_at: f.clock.now() })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect(f.alerts()).toEqual([]);
  expect((await f.pending())[0]).toMatchObject({ status: 'open', created_at: first.created_at });
  f.clock.advanceMs(1);
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(2);
  const alerts = f.alerts();
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ app_id: f.ctx.app_id, order_id: f.current.order_id });
  expect((await f.pending())[0]).toMatchObject({
    id: first.id,
    status: 'open',
    resolved_at: null,
    resolution_note: MANUAL,
    created_at: first.created_at,
  });
  const payload = JSON.stringify(alerts[0]);
  expect(payload).not.toContain(f.incoming.sub_order_id);
  expect(payload).not.toContain(f.userId);
  // 已交人工的行不反复告警、不再自动调用；流水线与扫描一致。
  await f.scan();
  await f.process();
  expect(f.port.create).toHaveBeenCalledTimes(2);
  expect(f.alerts()).toHaveLength(1);
});

it('[AC-B1-08t#13] 超过24小时本次成功则处置成功，不发失败告警', async () => {
  const f = await setup(db);
  await succeed(f, db);
  f.clock.advanceMs(24 * HOUR + 1);
  await f.scan();
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect((await f.pending())[0]).toMatchObject({ status: 'resolved', resolved_at: f.clock.now() });
  expect(f.alerts()).toEqual([]);
});

it('[AC-B1-08t#14] 告警只包含平铺定位字段，不输出买家身份或完整子订单号', async () => {
  const f = await setup(db);
  f.clock.advanceMs(24 * HOUR + 1);
  await f.scan();
  expect((await f.pending())[0]?.resolution_note).toBe(MANUAL);
  expect(f.alerts()).toHaveLength(1);
  for (const fields of f.alerts()) {
    expect(
      Object.values(fields).every((value) => value === null || typeof value !== 'object'),
    ).toBe(true);
    expect(JSON.stringify(fields)).not.toContain(f.userId);
    expect(JSON.stringify(fields)).not.toContain(f.incoming.sub_order_id);
    expect(fields).not.toHaveProperty('custom_parameters');
  }
});

it('[AC-B1-08t#15] 端口写快照后抛错不提交半成品，失败后释放锁并可恢复', async () => {
  const f = await setup(db);
  const port = await succeed(f, db);
  const failure = new Error('synthetic snapshot failure after insert');
  f.port.create.mockImplementationOnce(async (trx, input) => {
    await port.create(trx, input);
    throw failure;
  });
  f.clock.advanceMs(HOUR + 1);
  const before = await f.pending();
  await capture(() => f.scan());
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect(await splits(db, f.ctx.app_id)).toEqual([]);
  expect(await f.pending()).toEqual(before);
  await f.scan();
  expect(await splits(db, f.ctx.app_id)).toHaveLength(1);
  expect((await f.pending())[0]?.status).toBe('resolved');
});

it.each(['two-scans', 'scan-and-pipeline'] as const)(
  '[AC-B1-08t#16] %s 使用同一订单锁，成功后等待方重读且不再调用',
  async (mode) => {
    const f = await setup(db);
    const port = await succeed(f, db);
    f.clock.advanceMs(HOUR + 1);
    const results = await Promise.all([
      capture(() => f.scan()),
      capture(async () => {
        if (mode === 'two-scans') await f.scan();
        else await f.process();
      }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(port.create).toHaveBeenCalledTimes(1);
    expect(await splits(db, f.ctx.app_id)).toHaveLength(1);
    expect((await f.pending())[0]?.status).toBe('resolved');
  },
);

it('[AC-B1-08t#17] 金额资料仍不完整时保留 pending，不能以0元生成；超时仍须转人工', async () => {
  const f = await setup(db, { est_commission_fen: null });
  f.clock.advanceMs(HOUR + 1);
  await f.scan();
  expect(f.port.create).not.toHaveBeenCalled();
  expect((await f.pending())[0]).toMatchObject({ reason: 'AMOUNT_PARSE_FAILED', status: 'open' });
  f.clock.advanceMs(24 * HOUR);
  await f.scan();
  expect(f.port.create).not.toHaveBeenCalled();
  expect((await f.pending())[0]?.resolution_note).toBe(MANUAL);
  expect(f.alerts()).toHaveLength(1);
});

it('[AC-B1-08t#18] 扫描不能以缺快照或同名非快照解析错误为补偿信号', async () => {
  const f = await setup(db);
  await db
    .updateTable('order_sync_pending')
    .set({ reason: 'AMOUNT_PARSE_FAILED', detail: 'union normalization failed' })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  f.clock.advanceMs(HOUR + 1);
  const before = await f.pending();
  await f.scan();
  expect(f.port.create).not.toHaveBeenCalled();
  expect(await f.pending()).toEqual(before);
  expect(await splits(db, f.ctx.app_id)).toEqual([]);
});

it('[AC-B1-08t#19] 超时后端口抛错也转人工，不能无限重试或提交端口写到一半的快照', async () => {
  const f = await setup(db);
  const port = await succeed(f, db);
  f.port.create.mockImplementation(async (trx, input) => {
    await port.create(trx, input);
    throw new Error('synthetic persistent snapshot exception');
  });
  f.clock.advanceMs(24 * HOUR + 1);
  await capture(() => f.scan());
  expect(f.port.create).toHaveBeenCalledTimes(1);
  expect(await splits(db, f.ctx.app_id)).toEqual([]);
  expect((await f.pending())[0]).toMatchObject({
    status: 'open',
    resolved_at: null,
    resolution_note: MANUAL,
  });
  expect(f.alerts()).toHaveLength(1);
});
