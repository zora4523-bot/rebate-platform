import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { vi } from 'vitest';
import {
  createOrderPipeline,
  createOrderUpdateStep,
  type OrderPipelineDeps,
  type OrderUpdateDeps,
} from '../../../../apps/api/src/modules/orders/index.ts';
import type {
  CreateCommissionSnapshotInput,
  CreateCommissionSnapshotResult,
} from '../../../../apps/api/src/modules/commission/application/snapshot.ts';
import type {
  RegisteredPlatform,
  UnionOrder,
} from '../../../../apps/api/src/modules/union/index.ts';
import { capture, fixture, snapshot, traceQueries } from '../attribution/kit.ts';
import { scenario } from '../platform-status/kit.ts';
export { at, capture, snapshot, RECEIVED, SETTLED } from '../attribution/kit.ts';
export { scenario } from '../platform-status/kit.ts';

// Structural extension keeps existing implementations untouched in the test phase.
export interface SnapshotPort {
  create(
    trx: Transaction<DB>,
    input: CreateCommissionSnapshotInput,
  ): Promise<CreateCommissionSnapshotResult>;
}

export function fakePort(kind: 'created' | 'existing' = 'created') {
  const create = vi.fn<SnapshotPort['create']>(async (_trx, input) => ({
    kind,
    split: {
      app_id: input.appId,
      order_id: input.orderId,
      rule_version_id: '00000000-0000-4000-8000-000000000001',
      order_type: input.orderType,
      activity_type: input.activityType,
      rebate_mode: null,
      paid_at: input.paidAt,
      paid_at_source: input.paidAtSource,
      raw_n_fen: input.nBaseFen,
      subsidy_commission_fen: input.subsidyCommissionFen,
      reserve_bp: 0,
      reserve_fen: 0n,
      tlj_deduct_fen: 0n,
      base_fen: 0n,
      platform_retain_fen: 0n,
      beneficiaries: [],
      created_at: input.paidAt,
    },
  }));
  return { create };
}

export async function fresh(
  db: Kysely<DB>,
  patch: Partial<UnionOrder> & { platform?: RegisteredPlatform } = {},
) {
  const traced = traceQueries(db);
  const f = await fixture(traced.db, { service_fee_fen: 31n, ...patch });
  traced.queries.length = 0;
  return { ...f, queries: traced.queries, read: () => snapshot(db, f.ctx.app_id) };
}

export function runFresh(
  f: Awaited<ReturnType<typeof fresh>>,
  snapshots?: SnapshotPort,
  extra: Partial<OrderPipelineDeps> = {},
) {
  const deps = { ...f.deps, ...(snapshots ? { snapshots } : {}), ...extra };
  return capture(() => createOrderPipeline(deps).process(f.incoming, f.ctx));
}

export function runUpdate(
  f: Awaited<ReturnType<typeof scenario>>,
  snapshots: SnapshotPort | undefined,
  incoming: UnionOrder = f.next(),
  extra: Partial<OrderUpdateDeps> = {},
) {
  return capture(() => {
    const deps = {
      ...f.updateDeps,
      pids: f.deps.pids,
      ...(snapshots ? { snapshots } : {}),
      ...extra,
    };
    return createOrderPipeline({ ...f.deps, updateStep: createOrderUpdateStep(deps) }).process(
      incoming,
      f.ctx,
    );
  });
}

export function untouchedAmounts(row: Awaited<ReturnType<typeof snapshot>>['orders'][number]) {
  return {
    n_total_fen: row.n_total_fen,
    pre_base_deduct_fen: row.pre_base_deduct_fen,
    base_fen: row.base_fen,
    platform_est_profit_fen: row.platform_est_profit_fen,
    initial_est_fen: row.initial_est_fen,
    booked_base_fen: row.booked_base_fen,
    booked_n_fen: row.booked_n_fen,
    commission_version: row.commission_version,
    rebate_status: row.rebate_status,
    paid_at: row.paid_at,
  };
}
