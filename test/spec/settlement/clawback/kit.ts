// Shared harness of the B2-04s rule tests (post-credit clawback, R8 / R9 / R9b).
// Every order is first credited by the real B2-04m credit service (WAITING → CREDITED), so the
// clawback starts from real CREDIT / FORFEIT vouchers, balances, booked pair and obligations.
// Expected amounts are written by hand in the tests (or derived in the property body from the
// BR-CALC-02 / BR-CALC-04 / BR-CALC-09 formulas), never by calling the planner.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { addFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import { getOrderNets, type OrderNets } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  lockOrderKey,
  type OrderStatusSource,
  type OrderUpdateChange,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createClawbackOrder,
  type ClawbackCommand,
  type ClawbackDependencies,
  type ClawbackOrder,
  type ClawbackResult,
} from '../../../../apps/api/src/modules/settlement/clawback/index.ts';
import type { CreditRole } from '../../../../apps/api/src/modules/settlement/credit/index.ts';
import {
  bounded,
  harness as creditHarness,
  receivable,
  type OrderSpec,
  type SeededOrder,
} from '../credit/kit.ts';

export {
  NOW,
  TIMEOUT,
  baseOf,
  bounded,
  databaseFixture,
  deferred,
  receivable,
  shareOf,
  tracing,
  waitBlocked,
} from '../credit/kit.ts';
export type { OrderSpec, PersonSpec, SeededOrder, UserState } from '../credit/kit.ts';

export const DIFF_SWITCH = 'settle.estimate_change_diff.enabled';

export interface RunOptions {
  /** Executor of the transaction (another pool, a traced or a faulty one). */
  readonly via?: Kysely<DB>;
  /** Called with the backend pid before the clawback starts (lock / statement timeouts set). */
  readonly onPid?: (pid: number) => void;
}

/** What the simulated orders sync update writes before it calls onUpdated (same transaction). */
export interface SyncSpec {
  readonly event: OrderStatusSource['event'];
  readonly rule?: string | null;
  /** New platform_status (default: unchanged, e.g. P7 / P8 keep SETTLED). */
  readonly platformStatus?: string;
  /** New est_commission_fen (default unchanged); a different value bumps commission_version. */
  readonly estAfter?: bigint;
}

export interface SyncOutcome {
  readonly result: ClawbackResult;
  readonly change: OrderUpdateChange;
  readonly source: OrderStatusSource;
  /** orders.row_version written by the simulated sync update (the P{…} rights_event_id). */
  readonly rowVersion: number;
  readonly commissionVersion: number;
}

export interface CommandSpec {
  readonly cause: ClawbackCommand['cause'];
  readonly ref: ClawbackCommand['ref'];
  readonly newCommissionFen?: bigint | null;
  readonly rightsDeductFen?: bigint | null;
}

export interface RightsSpec {
  readonly type?: 'RIGHTS' | 'PUNISH' | 'INVALID_AFTER_SETTLE' | 'REFUND_AFTER_SETTLE';
  readonly status?: 'PROCESSING' | 'WAIT_COMMISSION' | 'SUCCEEDED' | 'FAILED';
  readonly deductionFen?: bigint | null;
}

export interface CandidateSpec {
  /** null: a platform-level candidate row (user_id and role null). */
  readonly role: CreditRole | null;
  readonly diffFen?: bigint;
  readonly status?: 'pending' | 'voided_stale_seq';
}

export async function harness(db: Kysely<DB>) {
  const h = await creditHarness(db);
  const appId = h.appId;

  const logs: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write(line: string) {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );

  const configValues = new Map<string, unknown>();
  const configGet = vi.fn<ClawbackDependencies['config']['get']>(async (_appId, key) =>
    configValues.get(key),
  );
  // Test double of the orders-owned order_sync_pending writer: a plain insert on the same
  // transaction (one open row per (app, platform, sub_order_id, reason), like orders' upsert).
  const openPending = vi.fn<ClawbackDependencies['pending']['open']>(async (trx, input) => {
    await trx
      .insertInto('order_sync_pending')
      .values({
        app_id: input.appId,
        platform: input.platform,
        sub_order_id: input.subOrderId,
        order_id: input.orderId,
        reason: input.reason,
        raw_status: null,
        raw_payload_id: null,
        detail: input.detail,
        detected_at: h.clock.now(),
        status: 'open',
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  });

  const transactions: Transaction<DB>[] = [];
  let service: ClawbackOrder | undefined;

  /** Builds the clawback service on the credit harness' spies (gate, ledger, snapshot, events). */
  function boot(): ClawbackOrder {
    if (service !== undefined) return service;
    h.boot();
    service = createClawbackOrder({
      clock: h.clock,
      logger,
      ledger: { openUserAccount: h.openUserAccount, lockBalances: h.lockBalances, post: h.post },
      gate: { lockUsers: h.lockUsers, readStates: h.readStates },
      readSnapshot: h.readSnapshot,
      appendBeneficiaryEvent: h.appendBeneficiaryEvent,
      pending: { open: openPending },
      config: { get: configGet },
      events: { publish: h.publish },
    });
    return service;
  }

  /** Seeds a WAITING order and credits it with the real B2-04m service (R5). */
  async function credited(spec: OrderSpec = {}): Promise<SeededOrder> {
    const o = await h.order(spec);
    expect(await h.credit(o)).toMatchObject({ outcome: 'credited' });
    return o;
  }

  function command(o: SeededOrder, spec: CommandSpec): ClawbackCommand {
    return {
      appId,
      orderId: o.orderId,
      cause: spec.cause,
      ref: spec.ref,
      newCommissionFen: spec.newCommissionFen ?? null,
      rightsDeductFen: spec.rightsDeductFen ?? null,
    };
  }

  /** One apply() in its own transaction on `via` (default: the shared pool). */
  async function apply(
    o: SeededOrder,
    spec: CommandSpec,
    options: RunOptions = {},
  ): Promise<ClawbackResult> {
    const clawback = boot();
    const request = command(o, spec);
    const onPid = options.onPid;
    return (options.via ?? db).transaction().execute(async (trx) => {
      transactions.push(trx);
      if (onPid !== undefined) onPid(await bounded(trx));
      return clawback.apply(trx, request);
    });
  }

  /** Delivers one onUpdated call (no orders write of its own: a redelivery of `change`). */
  async function deliver(
    change: OrderUpdateChange,
    source: OrderStatusSource,
    options: RunOptions = {},
  ): Promise<ClawbackResult> {
    const clawback = boot();
    return (options.via ?? db).transaction().execute(async (trx) => {
      transactions.push(trx);
      return clawback.onUpdated(trx, change, source);
    });
  }

  /**
   * Simulates the orders sync step on one transaction: order_key lock, the orders column update
   * (platform_status, est_commission_fen, commission_version + 1 when the estimate changed,
   * row_version + 1), then rebate.onUpdated with the change and the status source.
   */
  async function sync(o: SeededOrder, spec: SyncSpec): Promise<SyncOutcome> {
    const clawback = boot();
    return db.transaction().execute(async (trx) => {
      transactions.push(trx);
      await lockOrderKey(trx, o.platform, o.subOrderId);
      const before = await trx
        .selectFrom('orders')
        .selectAll()
        .where('app_id', '=', appId)
        .where('order_id', '=', o.orderId)
        .executeTakeFirstOrThrow();
      const estAfter = spec.estAfter ?? before.est_commission_fen;
      const estChanged = estAfter !== before.est_commission_fen;
      const to = spec.platformStatus ?? before.platform_status;
      const rowVersion = before.row_version + 1;
      const commissionVersion = estChanged
        ? before.commission_version + 1
        : before.commission_version;
      if (estChanged) {
        await addSnapshotVersion(trx, o, before.commission_version, commissionVersion);
      }
      await trx
        .updateTable('orders')
        .set({
          platform_status: to,
          est_commission_fen: estAfter,
          commission_version: commissionVersion,
          row_version: rowVersion,
          updated_at: h.clock.now(),
        })
        .where('app_id', '=', appId)
        .where('order_id', '=', o.orderId)
        .execute();
      const change: OrderUpdateChange = {
        app_id: appId,
        order_id: o.orderId,
        attr_at: before.attr_at,
        from_status: before.platform_status,
        to_status: to,
        rule: spec.rule ?? null,
        received_at: before.received_at,
        est_before: before.est_commission_fen,
        est_after: estAfter,
        settle_commission_fen: before.settle_commission_fen,
        attributed_now: false,
      };
      const source: OrderStatusSource = { event: spec.event, raw_status: 'synthetic' };
      const result = await clawback.onUpdated(trx, change, source);
      return { result, change, source, rowVersion, commissionVersion };
    });
  }

  // ---- seeding ---------------------------------------------------------------------------------
  async function rights(o: SeededOrder, spec: RightsSpec = {}): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto('order_rights')
      .values({
        id,
        app_id: appId,
        order_id: o.orderId,
        source: 'API',
        type: spec.type ?? 'RIGHTS',
        status: spec.status ?? 'SUCCEEDED',
        amount_fen: null,
        deduction_commission_fen: spec.deductionFen ?? null,
        occurred_at: h.clock.now(),
        platform_rights_no: `rights-${id}`,
      })
      .execute();
    return id;
  }

  async function candidate(o: SeededOrder, spec: CandidateSpec): Promise<string> {
    const batchId = randomUUID();
    await db
      .insertInto('settle_adjust_batches')
      .values({ batch_id: batchId, app_id: appId, confirmed_by: null, confirmed_at: null })
      .execute();
    const id = randomUUID();
    const stale = spec.status === 'voided_stale_seq';
    await db
      .insertInto('settle_adjustments')
      .values({
        id,
        app_id: appId,
        batch_id: batchId,
        order_id: o.orderId,
        user_id: spec.role === null ? null : o.user(spec.role),
        role: spec.role,
        commission_version: 1,
        settle_seq: o.seq,
        diff_fen: spec.diffFen ?? 7n,
        reason: null,
        status: spec.status ?? 'pending',
        approver: null,
        decided_at: stale ? new Date('2032-07-01T10:00:00+08:00') : null,
      })
      .execute();
    return id;
  }

  /** Moves `amount` of the user's available into frozen (a synthetic withdrawal freeze). */
  async function freeze(userId: string, amount: bigint): Promise<void> {
    await db.transaction().execute(async (trx) => {
      const [balance] = await h.ledger.lockBalances(trx, { appId, userIds: [userId] });
      if (balance === undefined) throw new Error('clawback harness: user has no account');
      await h.ledger.post(trx, {
        appId,
        uniqKey: `WDR:test:${randomUUID()}`,
        bizType: 'WITHDRAW',
        bizId: randomUUID(),
        operator: 'system',
        memo: null,
        orderKey: null,
        beneficiaryUserId: null,
        role: null,
        voucherKind: 'WITHDRAW_FREEZE',
        entries: [
          {
            account: { ownerType: 'user', accountId: balance.account_id },
            sub_account: 'available',
            amount_fen: amount,
            ledger_type: 'WITHDRAW_FREEZE',
            sub_type: null,
            income_type: null,
          },
          {
            account: { ownerType: 'user', accountId: balance.account_id },
            sub_account: 'frozen',
            amount_fen: -amount,
            ledger_type: 'WITHDRAW_FREEZE',
            sub_type: null,
            income_type: null,
          },
        ],
      });
    });
  }

  async function markDeleting(userId: string): Promise<void> {
    await db
      .updateTable('users')
      .set({ status: 'deleting' })
      .where('app_id', '=', appId)
      .where('id', '=', userId)
      .execute();
  }

  /**
   * commission's side of a new commission_version: the snapshot's redundant totals and amounts
   * copied under the new version (commission readCommissionSnapshot reads the greatest version;
   * the immutable terms — ratios, reserve_bp — stay in commission_splits).
   */
  async function addSnapshotVersion(
    executor: Kysely<DB>,
    o: SeededOrder,
    from: number,
    to: number,
  ): Promise<void> {
    const totals = await executor
      .selectFrom('commission_split_totals')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .where('commission_version', '=', from)
      .executeTakeFirstOrThrow();
    await executor
      .insertInto('commission_split_totals')
      .values({ ...totals, commission_version: to })
      .execute();
    const amounts = await executor
      .selectFrom('commission_split_amounts')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .where('commission_version', '=', from)
      .execute();
    if (amounts.length > 0) {
      await executor
        .insertInto('commission_split_amounts')
        .values(amounts.map((a) => ({ ...a, commission_version: to })))
        .execute();
    }
  }

  /** Simulates orders (and commission) moving the order to commission_version `to`. */
  async function bumpCommissionVersion(o: SeededOrder, to: number): Promise<void> {
    const { commission_version: from } = await h.read(o);
    await addSnapshotVersion(db, o, from, to);
    await db
      .updateTable('orders')
      .set({ commission_version: to })
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .execute();
  }

  // ---- reads -------------------------------------------------------------------------------------
  async function frozenOf(userId: string): Promise<bigint> {
    const [row] = await h.ledger.getBalances(db, { appId, userIds: [userId] });
    if (row === undefined) throw new Error('clawback harness: user has no account');
    return row.frozen_fen;
  }

  function nets(o: SeededOrder): Promise<OrderNets> {
    return db.transaction().execute((trx) => getOrderNets(trx, { appId, orderKey: o.orderKey }));
  }

  /** The beneficiary net of (user, role) on the order (0 when the key has no voucher). */
  async function netOf(o: SeededOrder, role: CreditRole): Promise<bigint> {
    const userId = o.user(role);
    const found = (await nets(o)).beneficiaries.find(
      (b) => b.beneficiary_user_id === userId && b.role === role,
    );
    return found?.net_fen ?? 0n;
  }

  async function orderVoucherKeys(o: SeededOrder): Promise<string[]> {
    return (await h.voucherKeys()).filter((k) => k.startsWith(`${o.orderKey}:`));
  }

  /** The CLAWBACK vouchers of the order (keys containing ':CLAWBACK:'). */
  async function clawbackKeys(o: SeededOrder): Promise<string[]> {
    return (await orderVoucherKeys(o)).filter((k) => k.includes(':CLAWBACK:'));
  }

  /** Σ of one subject's signed entries over the order's vouchers (debit positive). */
  async function orderSubjectNet(o: SeededOrder, subject: string): Promise<bigint> {
    return (await h.lines())
      .filter((l) => l.uniq_key.startsWith(`${o.orderKey}:`) && l.subject === subject)
      .reduce((sum, l) => addFen(sum, l.amount_fen), 0n);
  }

  /** ledger_type / sub_type pairs of a voucher's entries, deduplicated. */
  async function voucherTypes(uniqKey: string): Promise<string[]> {
    const pairs = (await h.lines())
      .filter((l) => l.uniq_key === uniqKey)
      .map((l) => `${l.ledger_type}|${l.sub_type ?? ''}`);
    return [...new Set(pairs)].sort();
  }

  async function voucher(uniqKey: string) {
    const found = (await h.vouchers()).find((v) => v.uniq_key === uniqKey);
    if (found === undefined) throw new Error(`clawback harness: no voucher ${uniqKey}`);
    return found;
  }

  /** Rebate history rows written after the credit (R5) row. */
  async function rebateHistoryAfterCredit(o: SeededOrder) {
    return (await h.history(o)).filter(
      (r) => r.field === 'rebate' && r.event !== 'SETTLE_BATCH_CREDIT',
    );
  }

  function rightsRow(id: string) {
    return db
      .selectFrom('order_rights')
      .selectAll()
      .where('app_id', '=', appId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  function pendingRows(o: SeededOrder) {
    return db
      .selectFrom('order_sync_pending')
      .selectAll()
      .where('app_id', '=', appId)
      .where('sub_order_id', '=', o.subOrderId)
      .execute();
  }

  function reconDiffs() {
    return db
      .selectFrom('recon_diffs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  function candidates(o: SeededOrder) {
    return db
      .selectFrom('settle_adjustments')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .orderBy('id')
      .execute();
  }

  async function orderObligations(o: SeededOrder) {
    return (await h.obligations()).filter((r) => r.order_id === o.orderId);
  }

  /** The order row's rebate-owned columns that a clawback may change. */
  async function rebateColumns(o: SeededOrder) {
    const row = await h.read(o);
    return {
      rebate_status: row.rebate_status,
      booked_base_fen: row.booked_base_fen,
      booked_n_fen: row.booked_n_fen,
      reason: row.reason,
      diff_reason_code: row.diff_reason_code,
      rights_pending: row.rights_pending,
      hold: row.hold,
    };
  }

  return {
    ...h,
    creditBoot: h.boot,
    logs,
    creditLogs: h.logs,
    configValues,
    configGet,
    openPending,
    transactions,
    boot,
    credited,
    command,
    apply,
    deliver,
    sync,
    rights,
    candidate,
    freeze,
    markDeleting,
    bumpCommissionVersion,
    frozenOf,
    nets,
    netOf,
    orderVoucherKeys,
    clawbackKeys,
    orderSubjectNet,
    voucherTypes,
    voucher,
    rebateHistoryAfterCredit,
    rightsRow,
    pendingRows,
    reconDiffs,
    candidates,
    orderObligations,
    rebateColumns,
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;

export const clawbackKey = (o: SeededOrder, role: CreditRole, eventId: string) =>
  `${o.orderKey}:${o.user(role)}:${role}:CLAWBACK:${eventId}`;
export const platformClawbackKey = (o: SeededOrder, eventId: string) =>
  `${o.orderKey}:PLATFORM:CLAWBACK:${eventId}`;

/** A user CLAWBACK voucher: debit USER_BALANCE.available, credit UNION_RECEIVABLE. */
export function userClawbackLines(o: SeededOrder, role: CreditRole, amount: bigint): string[] {
  return [
    `USER_BALANCE|${o.user(role)}|${String(amount)}`,
    `${receivable(o)}|platform|${String(-amount)}`,
  ].sort();
}

/** A deleted beneficiary's CLAWBACK voucher: debit BAD_DEBT, credit UNION_RECEIVABLE. */
export function badDebtLines(o: SeededOrder, amount: bigint): string[] {
  return [
    `BAD_DEBT|platform|${String(amount)}`,
    `${receivable(o)}|platform|${String(-amount)}`,
  ].sort();
}

/** Platform difference > 0: debit COMMISSION_REVENUE, credit UNION_RECEIVABLE. */
export function platformDecreaseLines(o: SeededOrder, amount: bigint): string[] {
  return [
    `COMMISSION_REVENUE|platform|${String(amount)}`,
    `${receivable(o)}|platform|${String(-amount)}`,
  ].sort();
}

/** Platform difference < 0: debit UNION_RECEIVABLE, credit COMMISSION_REVENUE. */
export function platformIncreaseLines(o: SeededOrder, amount: bigint): string[] {
  return [
    `${receivable(o)}|platform|${String(amount)}`,
    `COMMISSION_REVENUE|platform|${String(-amount)}`,
  ].sort();
}
