// Shared harness of the B2-04l rule tests: settlement's rights command (orders' rights.record) and
// R11 admin hold / unhold (orders' rebate.adminHold / adminUnhold). Built on the B2-04s clawback
// harness, so CREDITED orders are credited by the real B2-04m service and clawed back by the real
// B2-04s orchestrator; R6 / R7 before credit go through the real B2-04j rebate port. Every call
// runs the way orders runs it: one transaction, lockOrderKey first, the order re-read FOR UPDATE,
// then the port. Expected amounts are written by hand in the tests.
import type { DB } from '@couli/db';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { vi } from 'vitest';
import {
  lockOrderKey,
  type AdminHoldInput,
  type AdminHoldResult,
  type RebateAdminCommandPort,
  type RightsCommandPort,
  type RightsRecordInput,
  type RightsRecordResult,
} from '../../../../apps/api/src/modules/orders/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createRebatePort,
  type RebateDependencies,
  type RebatePort,
} from '../../../../apps/api/src/modules/settlement/rebate/application/rebate.ts';
import {
  createRebateAdminCommandPort,
  createRightsCommandPort,
} from '../../../../apps/api/src/modules/settlement/rights/index.ts';
import { harness as clawbackHarness, type SeededOrder } from '../clawback/kit.ts';

export {
  NOW,
  TIMEOUT,
  badDebtLines,
  clawbackKey,
  databaseFixture,
  platformClawbackKey,
  platformDecreaseLines,
  receivable,
  userClawbackLines,
} from '../clawback/kit.ts';
export type { OrderSpec, SeededOrder } from '../clawback/kit.ts';

/** occurred_at of the platform's rights record (differs from the injected NOW). */
export const OCCURRED_AT = '2032-07-20T09:00:00+08:00';
export const RIGHTS_NO = 'rights-n1';
export const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
export const NOTE = 'synthetic note';

export type OrderRow = Selectable<DB['orders']>;
export type HoldMode = 'hold' | 'unhold';

export interface RecordSpec {
  readonly source?: RightsRecordInput['source'];
  readonly type?: RightsRecordInput['type'];
  readonly status?: RightsRecordInput['status'];
  readonly amountFen?: bigint | null;
  readonly deductionFen?: bigint | null;
  /** platform_rights_no; default RIGHTS_NO, null allowed. */
  readonly rightsNo?: string | null;
  readonly occurredAt?: Date;
}

export interface CallOptions {
  /** Executor of the transaction (default: the shared pool). */
  readonly via?: Kysely<DB>;
  /** Runs on the same transaction after the port answered (e.g. throws to roll it back). */
  readonly after?: (trx: Transaction<DB>) => Promise<void>;
}

export interface HoldSpec extends CallOptions {
  readonly reasonCode?: AdminHoldInput['reason_code'];
  /** expected_row_version from the re-read row (default: its row_version). */
  readonly expected?: (before: OrderRow) => number;
}

export async function harness(db: Kysely<DB>) {
  const h = await clawbackHarness(db);
  const appId = h.appId;

  const rightsLogs: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { level: 'info', entry: 'test', appEnv: 'test' },
    {
      write(line: string) {
        rightsLogs.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );

  // B2-04j rebate port with test doubles at its commission boundary (valuation and estimate
  // refresh belong to commission; the system hold audit is not exercised here).
  const estimateBases = vi.fn<RebateDependencies['estimates']['bases']>(async () => ({
    before: 850n,
    after: 850n,
  }));
  const estimateRefresh = vi.fn<RebateDependencies['estimates']['refresh']>(async () => undefined);
  const systemAudit = vi.fn<RebateDependencies['audit']['append']>(async () => undefined);
  const rebate: RebatePort = createRebatePort({
    clock: h.clock,
    logger,
    events: { publish: h.publish },
    config: { get: h.configGet },
    estimates: { bases: estimateBases, refresh: estimateRefresh },
    audit: { append: systemAudit },
  });

  let recordInstance: RightsCommandPort | undefined;
  let adminInstance: RebateAdminCommandPort | undefined;

  /** settlement's rights command, built on the clawback harness' service and spies. */
  function recordPort(): RightsCommandPort {
    if (recordInstance !== undefined) return recordInstance;
    const clawback = h.boot();
    recordInstance = createRightsCommandPort({
      clock: h.clock,
      logger,
      events: { publish: h.publish },
      clawback,
      rebate,
    });
    return recordInstance;
  }

  function adminPort(): RebateAdminCommandPort {
    if (adminInstance !== undefined) return adminInstance;
    adminInstance = createRebateAdminCommandPort({ clock: h.clock, logger });
    return adminInstance;
  }

  /** lockOrderKey first, then the order re-read FOR UPDATE (what orders hands the ports). */
  async function readLocked(trx: Transaction<DB>, o: SeededOrder): Promise<OrderRow> {
    await lockOrderKey(trx, o.platform, o.subOrderId);
    return trx
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .where('attr_at', '=', o.attrAt)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }

  function recordInput(o: SeededOrder, before: OrderRow, spec: RecordSpec): RightsRecordInput {
    return {
      before,
      order_id: o.orderId,
      source: spec.source ?? 'IMPORT',
      type: spec.type ?? 'RIGHTS',
      status: spec.status ?? 'SUCCEEDED',
      amount_fen: spec.amountFen ?? null,
      deduction_commission_fen: spec.deductionFen ?? null,
      occurred_at: spec.occurredAt ?? new Date(OCCURRED_AT),
      platform_rights_no: spec.rightsNo === undefined ? RIGHTS_NO : spec.rightsNo,
      now: h.clock.now(),
    };
  }

  /** One rights.record in its own transaction. */
  async function record(
    o: SeededOrder,
    spec: RecordSpec = {},
    options: CallOptions = {},
  ): Promise<RightsRecordResult> {
    return (options.via ?? db).transaction().execute(async (trx) => {
      const before = await readLocked(trx, o);
      const result = await recordPort().record(trx, recordInput(o, before, spec));
      if (options.after !== undefined) await options.after(trx);
      return result;
    });
  }

  /** One rebate.adminHold / adminUnhold in its own transaction. */
  async function hold(
    mode: HoldMode,
    o: SeededOrder,
    spec: HoldSpec = {},
  ): Promise<AdminHoldResult> {
    return (spec.via ?? db).transaction().execute(async (trx) => {
      const before = await readLocked(trx, o);
      const input: AdminHoldInput = {
        before,
        expected_row_version:
          spec.expected === undefined ? before.row_version : spec.expected(before),
        reason_code: spec.reasonCode ?? 'RISK',
        reason: NOTE,
        actor: ADMIN_ID,
        ip: '192.0.2.10',
        now: h.clock.now(),
      };
      const port = adminPort();
      const result =
        mode === 'hold' ? await port.adminHold(trx, input) : await port.adminUnhold(trx, input);
      if (spec.after !== undefined) await spec.after(trx);
      return result;
    });
  }

  // ---- reads -------------------------------------------------------------------------------------
  function rightsRows(o: SeededOrder) {
    return db
      .selectFrom('order_rights')
      .selectAll()
      .where('app_id', '=', appId)
      .where('order_id', '=', o.orderId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  /** The order's only order_rights row (fails the test when there is not exactly one). */
  async function onlyRights(o: SeededOrder) {
    const rows = await rightsRows(o);
    if (rows.length !== 1) {
      throw new Error(`rights harness: ${String(rows.length)} order_rights rows, expected one`);
    }
    return rows[0]!;
  }

  function audits() {
    return db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute();
  }

  /** Names of the events published after `from` (h.publish call index). */
  function publishedSince(from: number): string[] {
    return h.publish.mock.calls.slice(from).map(([, event]) => event.name);
  }

  /** Everything a rights or hold call may write for this app, for before / after comparisons. */
  async function everything() {
    return {
      ...(await h.state()),
      rights: await db
        .selectFrom('order_rights')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('id')
        .execute(),
      pending: await db
        .selectFrom('order_sync_pending')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('id')
        .execute(),
      audits: await audits(),
    };
  }

  return {
    ...h,
    rightsLogs,
    estimateBases,
    estimateRefresh,
    rebate,
    recordPort,
    adminPort,
    record,
    hold,
    rightsRows,
    onlyRights,
    audits,
    publishedSince,
    everything,
  };
}

export type Harness = Awaited<ReturnType<typeof harness>>;
