// B1-09l: the console's hold / unhold use cases (POST /admin/v1/orders/{order_id}/hold and
// /unhold; contract adminHoldOrder / adminUnholdOrder, permission order.hold, no step-up;
// BR-FUND-06 细则「后台 hold / unhold」, BR-FUND-01 R11). This file gives the application service
// only; B1-10m mounts both routes on the admin entry (http/admin/order-actions.controller.ts) over
// settlement's real rebate.adminHold / adminUnhold, which app.module injects.
// One transaction per request:
//   ① first statement the sub-order advisory lock (order-lock.ts), then SELECT … FOR UPDATE reread;
//   ② judgement over the reread (domain/admin-hold.ts): R11 start state, same state, UNMAPPED_STATUS
//      pending record still open (order_sync_pending status=open, K-7), row_version → 20902 order;
//   ③ settlement writes hold / hold_reason / row_version through B1-09c's port (missing port →
//      ORDERS_RIGHTS_PORT_UNAVAILABLE); orders never writes those columns itself; any refusal of
//      the port (not_applicable, same_state, cas_conflict) rolls back and answers 20902 order;
//   ④ only after the port answered applied: audit order_hold / order_unhold bound to the same
//      transaction, target `orders:<order_id>` (the shape B1-10i's order-hold-audits reads).
// The answer is the order detail as it is now (B1-10i's read, after the commit).
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { AuditPort, Clock } from '../../platform/index.ts';
import { isUuid } from '../domain/admin-claim-view.ts';
import {
  checkHoldBody,
  checkUnholdBody,
  decideAdminHold,
  type AdminHoldBodyCheck,
  type AdminHoldMode,
} from '../domain/admin-hold.ts';
import {
  hasOpenUnmappedPending,
  readOrderLockTarget,
  rereadOrderForUpdate,
} from '../infra/admin-hold-store.ts';
import { createAdminOrderReads } from '../infra/admin-order-reads.ts';
import { lockOrderKey } from '../infra/order-lock.ts';
import { AdminOrders, type AdminOrderPorts } from './admin-orders.ts';
import {
  adminHoldOrder,
  adminUnholdOrder,
  type AdminHoldInput,
  type OrderRightsPorts,
} from './rights-ports.ts';

export interface AdminHoldActor {
  readonly appId: string;
  readonly adminId: string;
  /** admin_users.is_super as the admin guard read it (a super admin holds both reason sources). */
  readonly isSuper: boolean;
  readonly ip: string | null;
}

export interface AdminHoldCommand {
  readonly orderId: string;
  /** Runtime input: missing, or a value outside RISK / CS, is refused with 20001 here. */
  readonly reason_code?: string | undefined;
  readonly note: string;
  readonly expected_row_version: number;
}

export interface AdminHoldDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  /** admin: the permission keys the account holds in the app (assembled by app.module). */
  readonly permissions: (appId: string, adminId: string) => Promise<readonly string[]>;
  /** B1-09c: settlement's rebate.adminHold / adminUnhold. */
  readonly ports?: OrderRightsPorts | undefined;
  /** B1-10i's detail ports, for the answer. */
  readonly details: AdminOrderPorts;
}

export type AdminHoldOutcome =
  | { readonly code: 0; readonly data: Schema<'AdminOrderDetail'> }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | { readonly code: 20902; readonly data: { readonly resource: 'order' } };

const CONFLICT = { code: 20902, data: { resource: 'order' } } as const;
const AUDIT_ACTION: Record<AdminHoldMode, string> = {
  hold: 'order_hold',
  unhold: 'order_unhold',
};

function fieldsError(fields: readonly string[]): AdminHoldOutcome {
  return { code: 20001, data: { fields } };
}

/** Thrown inside the transaction to roll it back; answered 20902 order outside. */
class HoldConflict extends Error {
  constructor() {
    super('orders: admin hold conflict');
    this.name = 'HoldConflict';
  }
}

/** Thrown when the order vanished between the pre-read and the reread (answered like unknown). */
class HoldOrderMissing extends Error {
  constructor() {
    super('orders: admin hold order missing');
    this.name = 'HoldOrderMissing';
  }
}

/** Operational failures (port, audit, database) propagate and roll the transaction back. */
export async function holdOrder(
  deps: AdminHoldDeps,
  actor: AdminHoldActor,
  command: AdminHoldCommand,
): Promise<AdminHoldOutcome> {
  return run('hold', deps, actor, command);
}

export async function unholdOrder(
  deps: AdminHoldDeps,
  actor: AdminHoldActor,
  command: AdminHoldCommand,
): Promise<AdminHoldOutcome> {
  return run('unhold', deps, actor, command);
}

async function checkBody(
  mode: AdminHoldMode,
  deps: AdminHoldDeps,
  actor: AdminHoldActor,
  command: AdminHoldCommand,
): Promise<AdminHoldBodyCheck> {
  const body = { reason_code: command.reason_code, note: command.note };
  if (mode === 'unhold') return checkUnholdBody(body);
  const permissions = await deps.permissions(actor.appId, actor.adminId);
  return checkHoldBody({ isSuper: actor.isSuper, permissions }, body);
}

async function run(
  mode: AdminHoldMode,
  deps: AdminHoldDeps,
  actor: AdminHoldActor,
  command: AdminHoldCommand,
): Promise<AdminHoldOutcome> {
  // A non-UUID order_id names no order: answered before the database (never cast there).
  if (!isUuid(command.orderId)) return fieldsError(['order_id']);
  const checked = await checkBody(mode, deps, actor, command);
  if (!checked.ok) return fieldsError(checked.fields);
  const orderId = command.orderId.toLowerCase();
  const target = await readOrderLockTarget(deps.db, actor.appId, orderId);
  if (target === undefined) return fieldsError(['order_id']);

  try {
    await deps.db.transaction().execute(async (trx) => {
      await lockOrderKey(trx, target.platform, target.sub_order_id);
      const before = await rereadOrderForUpdate(trx, actor.appId, orderId);
      if (before === undefined) throw new HoldOrderMissing();
      const pendingOpen =
        mode === 'unhold' && before.hold && before.hold_reason === 'UNMAPPED_STATUS'
          ? await hasOpenUnmappedPending(trx, actor.appId, target)
          : false;
      if (decideAdminHold(mode, before, command.expected_row_version, pendingOpen) !== 'proceed') {
        throw new HoldConflict();
      }
      const input: AdminHoldInput = {
        before,
        expected_row_version: command.expected_row_version,
        reason_code: checked.reasonCode,
        reason: checked.note,
        actor: actor.adminId,
        ip: actor.ip,
        now: deps.clock.now(),
      };
      const result =
        mode === 'hold'
          ? await adminHoldOrder(trx, deps.ports, input)
          : await adminUnholdOrder(trx, deps.ports, input);
      // Whatever the port may have done before refusing is rolled back with the transaction.
      if (result.kind !== 'applied') throw new HoldConflict();
      // Taken only now: no audit writer exists for a refused or failed request.
      await deps.auditOn(trx).append({
        appId: actor.appId,
        actor: actor.adminId,
        action: AUDIT_ACTION[mode],
        target: `orders:${before.order_id}`,
        before: snapshotBefore(before),
        after: {
          hold: mode === 'hold',
          hold_reason: mode === 'hold' ? checked.reasonCode : null,
          reason_code: checked.reasonCode,
          note: checked.note,
        },
        ip: actor.ip,
      });
    });
  } catch (error) {
    if (error instanceof HoldConflict) return CONFLICT;
    if (error instanceof HoldOrderMissing) return fieldsError(['order_id']);
    throw error;
  }

  const details = new AdminOrders({ ...deps.details, reads: createAdminOrderReads(deps.db) });
  return { code: 0, data: await details.detail(actor.appId, orderId, undefined) };
}

function snapshotBefore(order: Selectable<DB['orders']>): {
  hold: boolean;
  hold_reason: string | null;
} {
  return { hold: order.hold, hold_reason: order.hold_reason };
}
