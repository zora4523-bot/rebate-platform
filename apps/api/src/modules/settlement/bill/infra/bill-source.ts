// B2-04zd (D10-443): the production readSource of the bill job (BR-FUND-04 ③ ④).
// Read only, on the job's transaction: the app / platform's orders with every order_settlements row,
// plus settlement rows without an order (order = null). Scope, cut-off and the greatest seq stay
// with the bill job; nothing the job has to judge is filtered out here.
// unionAuthoritative comes only from ledger's recon diff conclusion port (never from a closed status).
//
// settlement reads orders / order_keys / order_settlements on the caller's transaction, as the
// credit store does (credit-store.ts). UNATTRIBUTED orders are not one of the bill's six results
// (@couli/domain settlement/bill); they and their settlement rows are left out here, not passed on
// as orphans (the order exists on our side).
import type { DB } from '@couli/db';
import { orderKey, type OrderRebateState } from '@couli/domain';
import type { Kysely } from 'kysely';
import type {
  BillJobDependencies,
  BillSourceOrder,
  BillSourceRow,
  BillSourceSettlement,
} from '../job.ts';

/** Structurally ledger's readUnionAuthoritativeOrderKeys. */
export interface BillSourceDependencies {
  readUnionAuthoritative(
    db: Kysely<DB>,
    selection: { readonly appId: string; readonly orderKeys: readonly string[] },
  ): Promise<ReadonlySet<string>>;
}

type BillRebateStatus = BillSourceOrder['rebateStatus'];

const BILL_REBATE_STATUSES: ReadonlySet<string> = new Set<
  Exclude<OrderRebateState, 'UNATTRIBUTED'>
>(['ESTIMATED', 'WAITING', 'CREDITED', 'VOID', 'CLAWED_BACK']);

function billRebateStatus(value: string): BillRebateStatus {
  if (!BILL_REBATE_STATUSES.has(value)) {
    throw new Error('settlement bill source: unknown rebate_status');
  }
  return value as BillRebateStatus;
}

function settlementSource(value: string): BillSourceSettlement['source'] {
  if (value !== 'API' && value !== 'STATEMENT') {
    throw new Error('settlement bill source: unknown order_settlements source');
  }
  return value;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createBillSourceReader(
  dependencies: BillSourceDependencies,
): BillJobDependencies['readSource'] {
  return async (trx, input) => {
    const app = trx.withSchema('app');
    const orders = await app
      .selectFrom('orders')
      .select([
        'order_id',
        'platform',
        'sub_order_id',
        'rebate_status',
        'settle_period',
        'hold',
        'rights_pending',
        'commission_version',
      ])
      .where('app_id', '=', input.appId)
      .where('platform', '=', input.platform)
      .execute();
    const settlements = await app
      .selectFrom('order_settlements as s')
      .innerJoin('order_keys as k', (join) =>
        join.onRef('k.app_id', '=', 's.app_id').onRef('k.order_id', '=', 's.order_id'),
      )
      .select([
        's.order_id',
        'k.platform',
        'k.sub_order_id',
        's.seq',
        's.source',
        's.created_at',
        's.settled_at',
        's.settle_commission_fen',
      ])
      .where('s.app_id', '=', input.appId)
      .where('k.platform', '=', input.platform)
      .orderBy('s.order_id')
      .orderBy('s.seq')
      .execute();

    const unattributed = new Set<string>();
    const facts = new Map<string, { key: string; row: (typeof orders)[number] }>();
    for (const row of orders) {
      if (row.rebate_status === 'UNATTRIBUTED') {
        unattributed.add(row.order_id);
        continue;
      }
      facts.set(row.order_id, { key: orderKey(row.platform, row.sub_order_id), row });
    }

    const byOrder = new Map<string, { key: string; settlements: BillSourceSettlement[] }>();
    for (const [orderId, fact] of facts) byOrder.set(orderId, { key: fact.key, settlements: [] });
    for (const s of settlements) {
      if (unattributed.has(s.order_id)) continue;
      let entry = byOrder.get(s.order_id);
      if (entry === undefined) {
        entry = { key: orderKey(s.platform, s.sub_order_id), settlements: [] };
        byOrder.set(s.order_id, entry);
      }
      entry.settlements.push({
        seq: s.seq,
        source: settlementSource(s.source),
        createdAt: s.created_at,
        settledAt: s.settled_at,
        commissionFen: s.settle_commission_fen,
      });
    }

    const orderKeys = [...facts.values()].map((fact) => fact.key).sort(compareText);
    const authoritative =
      orderKeys.length === 0
        ? new Set<string>()
        : await dependencies.readUnionAuthoritative(trx, { appId: input.appId, orderKeys });

    const rows: BillSourceRow[] = [];
    for (const [orderId, entry] of byOrder) {
      const fact = facts.get(orderId);
      rows.push({
        orderKey: entry.key,
        order:
          fact === undefined
            ? null
            : {
                orderId,
                rebateStatus: billRebateStatus(fact.row.rebate_status),
                settlePeriod: fact.row.settle_period,
                hold: fact.row.hold,
                rightsPending: fact.row.rights_pending,
                commissionVersion: fact.row.commission_version,
                unionAuthoritative: authoritative.has(entry.key),
              },
        settlements: entry.settlements,
      });
    }
    return rows.sort((a, b) => compareText(a.orderKey, b.orderKey));
  };
}
