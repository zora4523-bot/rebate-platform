// B1-09l: the console's hold / unhold use cases (POST /admin/v1/orders/{order_id}/hold and
// /unhold; contract adminHoldOrder / adminUnholdOrder, permission order.hold, no step-up;
// BR-FUND-06 细则「后台 hold / unhold」, BR-FUND-01 R11). Both routes stay planned and unmounted
// (J-1): settlement's rebate.adminHold / adminUnhold has no real implementation yet; mounting is
// B1-09n. This file gives the application service only.
// One transaction per request:
//   ① first statement the sub-order advisory lock (order-lock.ts), then SELECT … FOR UPDATE reread;
//   ② judgement over the reread (domain/admin-hold.ts): R11 start state, same state, UNMAPPED_STATUS
//      pending record still open (order_sync_pending status=open, K-7), row_version → 20902 order;
//   ③ settlement writes hold / hold_reason / row_version through B1-09c's port (missing port →
//      ORDERS_RIGHTS_PORT_UNAVAILABLE); orders never writes those columns itself;
//   ④ audit order_hold / order_unhold bound to the same transaction, target `orders:<order_id>`.
// The answer is the order detail as it is now (B1-10i's read).
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { AuditPort, Clock } from '../../platform/index.ts';
import type { AdminOrderPorts } from './admin-orders.ts';
import type { OrderRightsPorts } from './rights-ports.ts';

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

/** Operational failures (port, audit, database) propagate and roll the transaction back. */
export async function holdOrder(
  deps: AdminHoldDeps,
  actor: AdminHoldActor,
  command: AdminHoldCommand,
): Promise<AdminHoldOutcome> {
  void deps;
  void actor;
  void command;
  throw new Error('NotImplemented: holdOrder');
}

export async function unholdOrder(
  deps: AdminHoldDeps,
  actor: AdminHoldActor,
  command: AdminHoldCommand,
): Promise<AdminHoldOutcome> {
  void deps;
  void actor;
  void command;
  throw new Error('NotImplemented: unholdOrder');
}
