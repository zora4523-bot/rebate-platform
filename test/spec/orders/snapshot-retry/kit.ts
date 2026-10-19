import type { DB } from '@couli/db';
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
  const deps: SnapshotRetryDeps = {
    db,
    clock: f.clock,
    snapshots: port,
    logger: f.logger,
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
  let revision = 0n;
  return {
    ...f,
    current,
    port,
    retryDeps: deps,
    publish,
    onUpdated,
    job,
    alerts: () =>
      f.logger.error.mock.calls
        .map(([fields]) => fields as Record<string, unknown>)
        .filter((fields) => fields.event === ALERT),
    process: (incoming: UnionOrder = f.incoming) => pipeline().process(incoming, f.ctx),
    next: (): UnionOrder => {
      f.clock.advanceMs(1000);
      revision++;
      return {
        ...f.incoming,
        modified_at: f.clock.now(),
        paid_fen: (f.incoming.paid_fen ?? 0n) + revision,
      };
    },
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

export async function setupScan(
  db: Kysely<DB>,
  patch: Partial<UnionOrder> & { platform?: RegisteredPlatform } = {},
) {
  return setup(db, {
    platform: 'jd',
    attr_params: {
      relation_id: null,
      sub_union_id: 'n_abcd1234',
      custom_parameters: null,
    },
    service_fee_fen: null,
    ...patch,
  });
}

export async function succeed(f: Fixture, db: Kysely<DB>) {
  const port = await realPort(db, f);
  // 共用旧夹具只预置拼多多规则；在本任务内为扫描平台补齐同版本的规则和预留。
  if (f.incoming.platform !== 'pdd') {
    await db
      .withSchema('app')
      .insertInto('commission_rules')
      .values({
        ...port.version.rules[0]!,
        app_id: f.ctx.app_id,
        rule_version_id: port.version.rule_version_id,
        platform: f.incoming.platform,
      })
      .execute();
    await db
      .withSchema('app')
      .insertInto('commission_rule_reserves')
      .values({
        app_id: f.ctx.app_id,
        rule_version_id: port.version.rule_version_id,
        platform: f.incoming.platform,
        reserve_bp: 1000,
      })
      .execute();
  }
  f.port.create.mockImplementation(port.create);
  return port;
}
