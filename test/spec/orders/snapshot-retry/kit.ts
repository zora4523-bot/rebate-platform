import type { DB } from '@couli/db';
import type { OrderPlatformState } from '@couli/domain';
import type { Insertable, Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import {
  createOrderPipeline,
  createOrderUpdateStep,
  type OrderUpdateDeps,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type { ReceivedJob } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  handleSnapshotRetry,
  type SnapshotRetryDeps,
} from '../../../../apps/api/src/modules/orders/jobs/snapshot-retry.ts';
import type {
  RegisteredPlatform,
  UnionOrder,
} from '../../../../apps/api/src/modules/union/index.ts';
import { fresh, fakePort, runFresh } from '../commission-snapshot/db-kit.ts';
import { realPort } from '../commission-snapshot/real-kit.ts';
export { capture } from '../attribution/kit.ts';
export { splits } from '../commission-snapshot/real-kit.ts';

export const HOUR = 3_600_000;
export const MANUAL = 'snapshot_retry_manual';
export const ALERT = 'order.snapshot_retry_exhausted';

export async function setup(
  db: Kysely<DB>,
  patch: Partial<UnionOrder> & { platform?: RegisteredPlatform } = {},
) {
  const f = await fresh(db, patch);
  const port = fakePort();
  port.create.mockResolvedValue({ kind: 'pending', reason: 'missing platform rule' });
  expect(await runFresh(f, port)).toMatchObject({ ok: true });
  const saved = await f.read();
  const current = saved.orders[0]!;
  // created_at 的数据库默认时钟不受 FixedClock 控制；显式给出首次发现时间。
  await db
    .withSchema('app')
    .updateTable('order_sync_pending')
    .set({ created_at: f.clock.now() })
    .where('app_id', '=', f.ctx.app_id)
    .execute();
  const publish = vi
    .fn<OrderUpdateDeps['events']['publish']>()
    .mockResolvedValue({ eventId: 'synthetic-event', duplicate: false });
  const onUpdated = vi.fn<OrderUpdateDeps['rebate']['onUpdated']>().mockResolvedValue(undefined);
  const onUnmappedStatus = vi
    .fn<OrderUpdateDeps['rebate']['onUnmappedStatus']>()
    .mockResolvedValue(undefined);
  const readInput = vi.fn<SnapshotRetryDeps['readInput']>(async (_trx, row) => ({
    before: {
      user_id: row.user_id,
      platform_status: row.platform_status as OrderPlatformState,
      rebate_status: row.rebate_status,
    },
    after: {
      user_id: row.user_id,
      platform_status: row.platform_status as OrderPlatformState,
      rebate_status_before: row.rebate_status,
    },
    order: {
      app_id: row.app_id,
      order_id: row.order_id,
      platform: f.incoming.platform,
      buy_type: row.buy_type as 'self' | 'share',
      activity_type: row.activity_type,
      is_presale: row.is_presale,
      paid_at: row.paid_at,
      deposit_paid_at: row.deposit_paid_at,
      est_commission_fen: row.est_commission_fen,
      settle_commission_fen: row.settle_commission_fen,
      subsidy_commission_fen: row.subsidy_commission_fen,
    },
    incoming: {
      modified_at: row.platform_modified_at,
      service_fee_fen: f.incoming.service_fee_fen ?? null,
    },
    pidScene: 'share',
    movedToPaidNow: false,
    firstPaidAt: saved.history.find((h) => h.to_status === 'PAID')?.at ?? null,
    now: f.clock.now(),
  }));
  const deps: SnapshotRetryDeps = {
    db,
    clock: f.clock,
    snapshots: port,
    logger: f.logger,
    readInput,
  };
  const pipeline = () =>
    createOrderPipeline({
      ...f.deps,
      snapshots: port,
      events: { publish },
      updateStep: createOrderUpdateStep({
        ...f.deps,
        snapshots: port,
        events: { publish },
        rebate: { onUpdated, onUnmappedStatus },
      }),
    });
  const job: ReceivedJob = {
    id: 'synthetic-snapshot-retry',
    queue: 'order-sync',
    name: 'snapshot-retry',
    payload: { app_id: f.ctx.app_id },
    attempt: 1,
  };
  port.create.mockClear();
  return {
    ...f,
    current,
    port,
    retryDeps: deps,
    publish,
    readInput,
    onUpdated,
    job,
    alerts: () =>
      [...f.logger.warn.mock.calls, ...f.logger.error.mock.calls]
        .map(([fields]) => fields as Record<string, unknown>)
        .filter((fields) => fields.event === ALERT),
    process: (incoming: UnionOrder = f.incoming) => pipeline().process(incoming, f.ctx),
    scan: () => handleSnapshotRetry(job, deps),
    pending: () =>
      db
        .withSchema('app')
        .selectFrom('order_sync_pending')
        .selectAll()
        .where('app_id', '=', f.ctx.app_id)
        .orderBy('id')
        .execute(),
    addPending: (patch: Partial<Insertable<DB['order_sync_pending']>>) =>
      db
        .withSchema('app')
        .insertInto('order_sync_pending')
        .values({
          app_id: f.ctx.app_id,
          order_id: current.order_id,
          platform: f.incoming.platform,
          sub_order_id: f.incoming.sub_order_id!,
          reason: 'AMOUNT_PARSE_FAILED',
          detail: 'commission_snapshot AMOUNT_PARSE_FAILED',
          status: 'open',
          detected_at: f.clock.now(),
          created_at: f.clock.now(),
          ...patch,
        })
        .execute(),
  };
}

export type Fixture = Awaited<ReturnType<typeof setup>>;

export async function succeed(f: Fixture, db: Kysely<DB>) {
  const port = await realPort(db, f);
  f.port.create.mockImplementation(port.create);
  return port;
}
