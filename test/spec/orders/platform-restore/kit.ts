// Shared harness of the B1-08zc rule tests (08 BR-FUND-22: a VOID / CLAWED_BACK sub-order restored
// by the platform). The order is first imported by the B1-08h pipeline (attribution/kit.ts fixture);
// what settlement did afterwards — rebate_status, orders.reason, the rebate history rows (the last
// one entering the current rebate status), the settled commission an invalid-after-settle sync left —
// is written directly here and stands for settlement. The update step under test gets the
// platform-restore port backed by the real ledger registerReconDiffOnce (the way app.module wires
// it), wrapped in a spy; the settlement port and the event bus are fakes.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { orderKey } from '@couli/domain';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { registerReconDiffOnce } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  createOrderPipeline,
  createOrderUpdateStep,
  type OrderUpdateDeps,
  type PlatformRestoreDiffPort,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { UnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { at, capture, fixture, RECEIVED, SETTLED } from '../attribution/kit.ts';

export { at, capture, RECEIVED, SETTLED } from '../attribution/kit.ts';

/** The alert field of the one warn line a new platform_restore diff logs (编排 9.2 第 5 条). */
export const RESTORE_ALERT = 'platform_restore';

export type RebateStatus =
  'UNATTRIBUTED' | 'ESTIMATED' | 'WAITING' | 'CREDITED' | 'VOID' | 'CLAWED_BACK';

/** One order_status_history row with field='rebate', as settlement (or an admin restore) wrote it. */
export interface RebateStep {
  readonly from: string | null;
  readonly event: string;
  readonly to: string;
  readonly source?: 'sync' | 'admin' | 'system';
}

/** What a later report changes against the previous one. */
export type Report = Partial<UnionOrder>;

/** Platform state of the first import (synthetic codes of attribution/kit.ts). */
export type ImportedAs = 'paid' | 'received' | 'settled' | 'invalid' | 'invalid_received';

export interface RestoreSpec {
  readonly rebate: RebateStatus;
  /** orders.reason as settlement left it. */
  readonly reason: string | null;
  /** Rebate history rows before the entering one (oldest first). */
  readonly prior?: readonly RebateStep[];
  /** The rebate history row entering `rebate` (written last); null: no such row. */
  readonly entry: RebateStep | null;
  readonly imported: ImportedAs;
  /** est_commission_fen of the imported report (default 789, settled 1234). */
  readonly est?: bigint | null;
  /** settle_commission_fen left on the row (and carried by later reports); default null. */
  readonly settle?: bigint | null;
}

export interface ScenarioOptions {
  /** false: the update step gets no platform-restore port (old wiring / tests). */
  readonly port?: boolean;
}

function importedReport(spec: RestoreSpec) {
  const settledEst = spec.est === undefined ? 1234n : spec.est;
  const est = spec.est === undefined ? 789n : spec.est;
  const settle = spec.settle ?? null;
  switch (spec.imported) {
    case 'paid':
      return { raw_status: 'paid', est_commission_fen: est, commission_fen: est ?? 0n };
    case 'received':
      return {
        raw_status: 'received',
        received_at: at(RECEIVED),
        est_commission_fen: est,
        commission_fen: est ?? 0n,
      };
    case 'settled':
      return {
        raw_status: 'settled',
        received_at: at(RECEIVED),
        settled_at: at(SETTLED),
        est_commission_fen: settledEst,
        commission_fen: settledEst ?? 0n,
        settle_commission_fen: settle,
      };
    case 'invalid':
      return { raw_status: 'invalid', est_commission_fen: est, commission_fen: est ?? 0n };
    case 'invalid_received':
      // Refunded after receipt (P6 from RECEIVED): the receipt time stays on the row.
      return {
        raw_status: 'invalid',
        received_at: at(RECEIVED),
        est_commission_fen: est,
        commission_fen: est ?? 0n,
      };
  }
}

export async function scenario(db: Kysely<DB>, spec: RestoreSpec, options: ScenarioOptions = {}) {
  const f = await fixture(db, importedReport(spec));
  const appId = f.ctx.app_id;
  const imported = await createOrderPipeline(f.deps).process(f.incoming, f.ctx);
  expect(imported.kind).toBe('inserted');

  // —— settlement's earlier work, written directly ——
  await db
    .updateTable('orders')
    .set({
      rebate_status: spec.rebate,
      reason: spec.reason,
      ...(spec.settle === undefined ? {} : { settle_commission_fen: spec.settle }),
    })
    .where('app_id', '=', appId)
    .execute();
  const original = await readOrder(db, appId);
  for (const step of spec.prior ?? []) await addRebateStep(db, original, step, f.clock.now());
  const entryId =
    spec.entry === null ? null : await addRebateStep(db, original, spec.entry, f.clock.now());

  f.clock.advanceMs(60_000);
  f.onImported.mockClear();
  f.logger.info.mockClear();
  f.logger.warn.mockClear();
  f.logger.error.mockClear();

  const onUpdated = vi.fn<OrderUpdateDeps['rebate']['onUpdated']>().mockResolvedValue(undefined);
  const onUnmappedStatus = vi
    .fn<OrderUpdateDeps['rebate']['onUnmappedStatus']>()
    .mockResolvedValue(undefined);
  const publish = vi
    .fn<OrderUpdateDeps['events']['publish']>()
    .mockResolvedValue({ eventId: randomUUID(), duplicate: false });
  /** The port as app.module wires it: ledger registerReconDiffOnce on the caller's transaction. */
  const realRegister: PlatformRestoreDiffPort['register'] = async (trx, input) => {
    const registration = await registerReconDiffOnce(trx, input, { clock: f.clock });
    return { inserted: registration.inserted, id: registration.row.id };
  };
  const register = vi.fn<PlatformRestoreDiffPort['register']>(realRegister);
  const deps: OrderUpdateDeps = {
    clock: f.clock,
    users: f.deps.users,
    bindings: f.deps.bindings,
    statusMaps: f.deps.statusMaps,
    rebate: { onUpdated, onUnmappedStatus },
    events: { publish },
    logger: f.logger,
    ...(options.port === false ? {} : { platformRestore: { register } }),
  };
  // The factory must succeed before any expectation about process() is installed.
  const made = await capture(() => createOrderUpdateStep(deps));
  expect(made).toMatchObject({ ok: true });
  if (!made.ok) throw made.error;
  const pipeline = createOrderPipeline({ ...f.deps, updateStep: made.value });
  const rebateBefore = await readRebateHistory(db, original);

  let last: UnionOrder = f.incoming;
  let payload = 200;
  /** One later report: the previous one with `change` applied, a minute later on our clock. */
  const sync = (change: Report = {}) => {
    f.clock.advanceMs(60_000);
    const platformClock = new FixedClock(f.clock.now().toISOString());
    platformClock.advanceMs(-11_000);
    payload += 1;
    last = {
      ...last,
      ...change,
      modified_at: platformClock.now(),
      raw_payload_id: String(payload),
    };
    const incoming = last;
    return capture(() => pipeline.process(incoming, f.ctx));
  };

  return {
    ...f,
    original,
    entryId,
    key: orderKey(f.incoming.platform, f.incoming.sub_order_id as string),
    rebateBefore,
    onUpdated,
    onUnmappedStatus,
    publish,
    register,
    realRegister,
    updateDeps: deps,
    sync,
    /** Moves our clock to `iso` (later than now). */
    setClock(iso: string) {
      f.clock.advanceMs(at(iso).getTime() - f.clock.now().getTime());
    },
    /** A later rebate history row (an admin restore and a new void, standing for settlement). */
    addRebateStep: (step: RebateStep) => addRebateStep(db, original, step, f.clock.now()),
    setRebate: (rebate: RebateStatus, reason: string | null) =>
      db
        .updateTable('orders')
        .set({ rebate_status: rebate, reason })
        .where('app_id', '=', appId)
        .execute(),
    order: () => readOrder(db, appId),
    rebateHistory: () => readRebateHistory(db, original),
    diffs: () =>
      db
        .selectFrom('recon_diffs')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('created_at')
        .orderBy('id')
        .execute(),
    history: () =>
      db
        .selectFrom('order_status_history')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('id')
        .execute(),
    /** Warn lines carrying alert = platform_restore. */
    restoreWarns: () =>
      f.logger.warn.mock.calls.filter(
        (args) => (args[0] as Record<string, unknown> | undefined)?.alert === RESTORE_ALERT,
      ),
  };
}
export type Scenario = Awaited<ReturnType<typeof scenario>>;

async function readOrder(db: Kysely<DB>, appId: string) {
  const row = await db
    .selectFrom('orders')
    .selectAll()
    .where('app_id', '=', appId)
    .executeTakeFirst();
  expect(row).toBeDefined();
  if (!row) throw new Error('fixture order missing');
  return row;
}

function readRebateHistory(db: Kysely<DB>, order: { app_id: string; order_id: string }) {
  return db
    .selectFrom('order_status_history')
    .selectAll()
    .where('app_id', '=', order.app_id)
    .where('order_id', '=', order.order_id)
    .where('field', '=', 'rebate')
    .orderBy('id')
    .execute();
}

async function addRebateStep(
  db: Kysely<DB>,
  order: { app_id: string; order_id: string },
  step: RebateStep,
  now: Date,
): Promise<bigint> {
  const row = await db
    .insertInto('order_status_history')
    .values({
      app_id: order.app_id,
      order_id: order.order_id,
      field: 'rebate',
      from_status: step.from,
      event: step.event,
      to_status: step.to,
      source: step.source ?? 'sync',
      at: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The entry row id of a scenario that has one. */
export function entryOf(f: Scenario): bigint {
  expect(f.entryId).not.toBeNull();
  if (f.entryId === null) throw new Error('scenario has no entering rebate row');
  return f.entryId;
}

/** The ref_id / dedupe_key of 编排 9.2 第 3 条, written out by hand. */
export function expectedKeys(f: Scenario, entryId: bigint = entryOf(f)) {
  return {
    refId: `${f.key}#RESTORE#${entryId.toString(10)}`,
    dedupeKey: `platform_restore:${f.key}:${entryId.toString(10)}`,
  };
}

/** BR-FUND-22「不得因平台数据自动复活」：rebate_status、reason 不变，orders 不写返利历史。 */
export async function expectNotRevived(f: Scenario, rebate: RebateStatus, reason: string | null) {
  const row = await f.order();
  expect(row.rebate_status).toBe(rebate);
  expect(row.reason).toBe(reason);
  expect(await f.rebateHistory()).toEqual(f.rebateBefore);
}

/** No diff, no port call, no platform_restore warn. */
export async function expectNoRestore(f: Scenario) {
  expect(f.register).not.toHaveBeenCalled();
  expect(await f.diffs()).toEqual([]);
  expect(f.restoreWarns()).toEqual([]);
}

/** Logs are flat and carry neither the sub-order number nor the buyer parameters (orders AGENTS 10). */
export function expectSafeLogs(f: Scenario) {
  const logs = [
    ...f.logger.info.mock.calls,
    ...f.logger.warn.mock.calls,
    ...f.logger.error.mock.calls,
  ];
  for (const args of logs) {
    const fields = args[0] as Record<string, unknown>;
    expect(Object.values(fields).every((v) => v === null || typeof v !== 'object')).toBe(true);
    const text = JSON.stringify(args, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString(10) : v,
    );
    expect(text).not.toContain(f.incoming.sub_order_id);
    expect(text).not.toContain('abcd1234');
  }
}

/** The P9 warn B1-08i already logs stays (update-step: alert P1, rule P9, invalid_recovered). */
export function expectP9Warn(f: Scenario) {
  expect(f.logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ rule: 'P9', outcome: 'invalid_recovered', app_id: f.ctx.app_id }),
    expect.any(String),
  );
}
