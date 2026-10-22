// 合成归一订单与历史记录；数据库生命周期只在 *.int.test.ts 管理。
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { UnionAdapter, UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import {
  level,
  user as beneficiaryUser,
  BEFORE,
  PAID,
  AFTER,
} from '../../commission/resolver/kit.ts';
import { seedVersion, version } from '../../commission/snapshot/fixtures.ts';
import { capture, order } from '../attribution/kit.ts';
import { job } from '../sync/kit.ts';
import { account, at, built, pid, START, user } from '../wiring/db-kit.ts';
import { contextOf, runtime } from '../wiring/context-kit.ts';

export { seedVersion, version, PAID };

async function relation(
  db: Kysely<DB>,
  appId: string,
  owner: string,
  parent: string,
  when: Date,
  from: string | null,
) {
  await db
    .insertInto('relation_change_logs')
    .values({
      app_id: appId,
      user_id: owner,
      from_parent_id: from,
      to_parent_id: parent,
      source: 'admin',
      operator: 'synthetic-test',
      reason: 'synthetic relation change',
      at: when,
      created_at: when,
    })
    .execute();
}

export async function fixture(db: Kysely<DB>, directStatus = 'normal') {
  const a = await account(db);
  const owner = await user(db, a.app_id, { level: 'L3' });
  const direct = await beneficiaryUser(db, a.app_id, directStatus);
  const laterParent = await beneficiaryUser(db, a.app_id);
  await pid(db, a);
  await level(db, a.app_id, owner.id, 'L1', BEFORE);
  await level(db, a.app_id, direct, 'L2', BEFORE);
  await level(db, a.app_id, laterParent, 'L3', BEFORE);
  await level(db, a.app_id, owner.id, 'L3', AFTER, 'L1');
  await level(db, a.app_id, direct, 'L3', AFTER, 'L2');
  await relation(db, a.app_id, owner.id, direct, BEFORE, null);
  await relation(db, a.app_id, owner.id, laterParent, AFTER, direct);
  const incoming = order({
    sub_order_id: randomUUID(),
    raw_status: '0',
    paid_at: PAID,
    modified_at: at('2026-10-20T03:00:00.000Z'),
    service_fee_fen: 31n,
  });
  const f = await built(() => contextOf('worker', true, db));
  try {
    const r = await runtime(f.context);
    const clock = f.context.get(f.platform.CLOCK, { strict: false }) as FixedClock;
    clock.set('2026-10-22T03:00:00.000Z');
    // 仅替换归一适配器与演示账号凭据查询；快照及受益人解析均由生产装配提供。
    vi.spyOn(r.access, 'queryableAccount').mockResolvedValue(a.id);
    const listOrders = vi.fn<UnionAdapter['listOrders']>();
    vi.spyOn(r.registry, 'get').mockReturnValue({ listOrders });
    const handlers = f.queue.register.mock.calls.filter(([name]) => name === 'order-sync');
    expect(handlers).toHaveLength(1);
    const handler = handlers[0]![1];
    let windowStart = START;
    async function process(value: UnionOrder = incoming) {
      listOrders.mockResolvedValue({ items: [value], nextCursor: null });
      const windowEnd = clock.now().toISOString();
      const result = await capture(() =>
        handler(
          job({
            app_id: a.app_id,
            platform: 'pdd',
            union_account_id: a.id,
            query_kind: 'increment',
            scene: '-',
            window_start: windowStart,
            window_end: windowEnd,
          }),
        ),
      );
      expect(result).toMatchObject({ ok: true });
      windowStart = windowEnd;
    }
    async function retry() {
      const result = await capture(() =>
        handler({
          id: randomUUID(),
          queue: 'order-sync',
          name: 'snapshot-retry',
          payload: { app_id: a.app_id },
          attempt: 1,
        }),
      );
      expect(result).toMatchObject({ ok: true });
    }
    return {
      ...f,
      r,
      clock,
      incoming,
      process,
      retry,
      appId: a.app_id,
      owner: owner.id,
      direct,
      laterParent,
      orders: () => db.selectFrom('orders').selectAll().where('app_id', '=', a.app_id).execute(),
      splits: () =>
        db.selectFrom('commission_splits').selectAll().where('app_id', '=', a.app_id).execute(),
      pending: () =>
        db.selectFrom('order_sync_pending').selectAll().where('app_id', '=', a.app_id).execute(),
    };
  } catch (error) {
    await f.context.close();
    throw error;
  }
}

export async function expectSnapshot(
  f: Awaited<ReturnType<typeof fixture>>,
  directStatus = 'active',
) {
  const rows = await f.splits();
  expect(rows).toHaveLength(1);
  const orders = await f.orders();
  expect(orders).toHaveLength(1);
  expect(orders[0]).toMatchObject({ user_id: f.owner });
  expect(rows[0]).toMatchObject({
    app_id: f.appId,
    order_id: orders[0]!.order_id,
    paid_at: PAID,
    paid_at_source: 'platform',
    created_at: f.clock.now(),
  });
  expect(rows[0]!.beneficiaries).toEqual([
    expect.objectContaining({
      user_id: f.owner,
      role: 'share',
      level: 'L1',
      initial_status: 'active',
    }),
    expect.objectContaining({
      user_id: f.direct,
      role: 'direct',
      level: 'L2',
      initial_status: directStatus,
      forfeit_reason: directStatus === 'forfeited' ? 'deleted' : null,
    }),
  ]);
  return rows;
}
