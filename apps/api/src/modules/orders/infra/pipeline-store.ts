// B1-08h：归因流水线主事务的读写（只写 orders 模块自己的表；一律 .withSchema('app')）。所有函数都
// 在调用方已取得子订单 advisory 锁的事务里运行（infra/order-lock.ts）。
import type { DB } from '@couli/db';
import { sql, type Insertable, type Selectable, type Transaction } from 'kysely';

type Trx = Transaction<DB>;

export interface OrderKeyRow {
  readonly order_id: string;
  readonly app_id: string;
  readonly attr_at: Date;
}

/** order_keys 是全局唯一键 (platform, sub_order_id)；不按 app 过滤，app 冲突由调用方判定。 */
export async function readOrderKey(
  trx: Trx,
  platform: string,
  subOrderId: string,
): Promise<OrderKeyRow | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('order_keys')
    .select(['order_id', 'app_id', 'attr_at'])
    .where('platform', '=', platform)
    .where('sub_order_id', '=', subOrderId)
    .executeTakeFirst();
}

/** Reads the orders row of an existing key (attr_at in the predicate prunes partitions). */
export async function readOrder(
  trx: Trx,
  key: OrderKeyRow,
): Promise<Selectable<DB['orders']> | undefined> {
  return trx
    .withSchema('app')
    .selectFrom('orders')
    .selectAll()
    .where('order_id', '=', key.order_id)
    .where('attr_at', '=', key.attr_at)
    .where('app_id', '=', key.app_id)
    .executeTakeFirst();
}

export interface DropInput {
  readonly app_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly reason: string;
  /** Accounting date YYYY-MM-DD (+08:00). */
  readonly date: string;
}

/**
 * BR-ATTR-02 丢弃计数：drop_keys 已有同键时不计；第一次写入时 drops(app, platform, date, reason)
 * 原子 +1。返回是否第一次写入。
 */
export async function recordDrop(trx: Trx, input: DropInput): Promise<boolean> {
  const app = trx.withSchema('app');
  const inserted = await app
    .insertInto('order_sync_drop_keys')
    .values({
      app_id: input.app_id,
      platform: input.platform,
      sub_order_id: input.sub_order_id,
      reason: input.reason,
    })
    .onConflict((oc) => oc.columns(['app_id', 'platform', 'sub_order_id', 'reason']).doNothing())
    .executeTakeFirst();
  if ((inserted.numInsertedOrUpdatedRows ?? 0n) === 0n) return false;
  await app
    .insertInto('order_sync_drops')
    .values({
      app_id: input.app_id,
      platform: input.platform,
      date: input.date,
      reason: input.reason,
      count: 1n,
    })
    .onConflict((oc) =>
      oc
        .columns(['app_id', 'platform', 'date', 'reason'])
        .doUpdateSet({ count: sql<bigint>`order_sync_drops.count + 1` }),
    )
    .execute();
  return true;
}

export type SyncCounter = 'attr_param_invalid' | 'attr_binding_miss' | 'order_sync_no_mtime';

/** order_sync_counters(app, platform, date, counter) 原子 +1。 */
export async function bumpCounter(
  trx: Trx,
  input: { app_id: string; platform: string; date: string; counter: SyncCounter },
): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('order_sync_counters')
    .values({ ...input, count: 1n })
    .onConflict((oc) =>
      oc
        .columns(['app_id', 'platform', 'date', 'counter'])
        .doUpdateSet({ count: sql<bigint>`order_sync_counters.count + 1` }),
    )
    .execute();
}

export interface PendingInput {
  readonly app_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly order_id: string | null;
  readonly reason: 'UNMAPPED_STATUS' | 'ILLEGAL_TRANSITION' | 'NO_RECEIVED_AT';
  readonly raw_status: string | null;
  readonly raw_payload_id: bigint | null;
  readonly detected_at: Date;
}

/** 待处理记录：同键 open 记录已存在时只更新 detected_at（order_sync_pending_open_key）。 */
export async function upsertPending(trx: Trx, input: PendingInput): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('order_sync_pending')
    .values({ ...input, status: 'open' })
    .onConflict((oc) =>
      oc
        .columns(['app_id', 'platform', 'sub_order_id', 'reason'])
        .where('status', '=', sql.lit('open'))
        .doUpdateSet((eb) => ({ detected_at: eb.ref('excluded.detected_at') })),
    )
    .execute();
}

export interface HistoryInput {
  readonly from_status: string | null;
  readonly event: string;
  readonly to_status: string;
}

/**
 * 新子订单：先插 order_keys 拿到 order_id，再写分区表 orders（不写 rebate_status，库默认
 * UNATTRIBUTED，settlement 是唯一写者），然后按顺序写 history。
 */
export async function insertImportedOrder(
  trx: Trx,
  key: { platform: string; sub_order_id: string; order_id: string; app_id: string; attr_at: Date },
  order: Omit<Insertable<DB['orders']>, 'rebate_status'>,
  history: readonly HistoryInput[],
  at: Date,
): Promise<void> {
  const app = trx.withSchema('app');
  await app.insertInto('order_keys').values(key).execute();
  await app.insertInto('orders').values(order).execute();
  for (const step of history) {
    await app
      .insertInto('order_status_history')
      .values({
        app_id: key.app_id,
        order_id: key.order_id,
        field: 'platform',
        from_status: step.from_status,
        event: step.event,
        to_status: step.to_status,
        source: 'sync',
        at,
      })
      .execute();
  }
}
