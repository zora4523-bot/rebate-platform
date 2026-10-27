// Orders' read port for the withdrawal risk-flag snapshot (task B2-11a; 08 BR-WDR-29 ④⑤⑥). On the
// caller's handle (the W1 transaction included): plain SELECTs, no row locks, no writes, no
// logging. The window bounds are the caller's (closed at both ends).
// - selfOrders: the member's attributed buy_type=self sub-orders with paid_at in the window, one
//   row per sub-order however many order_rights rows it has; the union's synced values
//   est_commission_fen (联盟预估佣金) and pay_amount_fen (计佣金额) as stored, null when absent.
// - receivedOrders: of the given sub-orders, those with received_at in the window and rebate_status
//   WAITING or CREDITED, with what the caller needs to price the member's share.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

const INVALID_REBATE_STATUSES: readonly string[] = ['VOID', 'CLAWED_BACK'];
const RECEIVED_REBATE_STATUSES: readonly string[] = ['WAITING', 'CREDITED'];

export interface WithdrawRiskSelfOrder {
  readonly order_id: string;
  /** rebate_status ∈ {VOID, CLAWED_BACK} or a SUCCEEDED order_rights row. */
  readonly invalid: boolean;
  readonly est_commission_fen: bigint | null;
  readonly pay_amount_fen: bigint | null;
}

export interface WithdrawRiskReceivedOrder {
  readonly order_id: string;
  readonly platform: string;
  readonly sub_order_id: string;
  readonly rebate_status: 'WAITING' | 'CREDITED';
  readonly commission_version: number;
}

export interface WithdrawRiskOrderReader {
  selfOrders(
    handle: Kysely<DB>,
    input: { appId: string; userId: string; from: Date; to: Date },
  ): Promise<readonly WithdrawRiskSelfOrder[]>;
  receivedOrders(
    handle: Kysely<DB>,
    input: { appId: string; orderIds: readonly string[]; from: Date; to: Date },
  ): Promise<readonly WithdrawRiskReceivedOrder[]>;
}

export function createWithdrawRiskOrderReader(): WithdrawRiskOrderReader {
  return {
    async selfOrders(handle, input) {
      const rows = await handle
        .withSchema('app')
        .selectFrom('orders as o')
        .select((eb) => [
          'o.order_id',
          'o.rebate_status',
          'o.est_commission_fen',
          'o.pay_amount_fen',
          eb
            .exists(
              eb
                .selectFrom('order_rights as r')
                .select(sql<number>`1`.as('one'))
                .whereRef('r.app_id', '=', 'o.app_id')
                .whereRef('r.order_id', '=', 'o.order_id')
                .where('r.status', '=', 'SUCCEEDED'),
            )
            .as('rights_succeeded'),
        ])
        .where('o.app_id', '=', input.appId)
        .where('o.user_id', '=', input.userId)
        .where('o.buy_type', '=', 'self')
        .where('o.rebate_status', '<>', 'UNATTRIBUTED')
        .where('o.paid_at', '>=', input.from)
        .where('o.paid_at', '<=', input.to)
        .orderBy('o.paid_at')
        .orderBy('o.order_id')
        .execute();
      return rows.map((row) => ({
        order_id: row.order_id,
        invalid:
          INVALID_REBATE_STATUSES.includes(row.rebate_status) || row.rights_succeeded === true,
        est_commission_fen: row.est_commission_fen,
        pay_amount_fen: row.pay_amount_fen,
      }));
    },
    async receivedOrders(handle, input) {
      if (input.orderIds.length === 0) return [];
      const rows = await handle
        .withSchema('app')
        .selectFrom('orders')
        .select(['order_id', 'platform', 'sub_order_id', 'rebate_status', 'commission_version'])
        .where('app_id', '=', input.appId)
        .where('order_id', 'in', [...input.orderIds])
        .where('received_at', '>=', input.from)
        .where('received_at', '<=', input.to)
        .where('rebate_status', 'in', [...RECEIVED_REBATE_STATUSES])
        .orderBy('order_id')
        .execute();
      return rows.map((row) => ({
        ...row,
        rebate_status: row.rebate_status === 'CREDITED' ? 'CREDITED' : 'WAITING',
      }));
    },
  };
}
