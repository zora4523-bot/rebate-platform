import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { Clock } from '../../platform/index.ts';

export interface OrderSubject {
  app_id: string;
  user_id: string;
}

export interface OrderFilter {
  scope: Schema<'OrderScope'>;
  status_group?: Schema<'OrderStatusGroup'>;
  display_status?: Schema<'OrderDisplayStatus'>;
  platform?: Schema<'PlatformCode'>;
  q?: string;
  paid_month?: string;
  cursor?: string;
  limit?: number;
}

export interface OrderFigures {
  b_est: bigint | null;
  est_rebate_fen: bigint | null;
  actual_fen: bigint | null;
  clawback_fen: bigint | null;
  has_clawback: boolean;
  part_clawed_at: string | null;
  viewer_share_held: boolean;
  expected_credit_period: string | null;
  credit_overdue: boolean;
  appeal_pending: boolean;
}

export interface OrderFiguresReader {
  forOrders(
    subject: OrderSubject,
    orderIds: readonly string[],
  ): Promise<ReadonlyMap<string, OrderFigures>>;
}

export interface OrderLinkReader {
  productKeys(
    appId: string,
    linkIds: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>>;
}

export interface OrderQueryDeps {
  db: Kysely<DB>;
  clock: Clock;
  config: ContentReader;
  figures?: OrderFiguresReader;
  links: OrderLinkReader;
}

/** Shared, already projected read surface for HTTP and B3-08; also the Nest provider token. */
export class OrderQueries {
  list(subject: OrderSubject, filter: OrderFilter): Promise<Schema<'OrderListData'>> {
    void subject;
    void filter;
    throw new Error('NotImplemented: OrderQueries.list');
  }

  /** Missing, invisible and outside the retention window all return null. */
  get(subject: OrderSubject, orderId: string): Promise<Schema<'OrderDetail'> | null> {
    void subject;
    void orderId;
    throw new Error('NotImplemented: OrderQueries.get');
  }
}

export function createOrderQueries(deps: OrderQueryDeps): OrderQueries {
  void deps;
  throw new Error('NotImplemented: createOrderQueries');
}

/** TODO(规划/11 §4.5): 未接线时金额与结算期未知 — blocked on settlement / ledger / commission 读端口 */
export function createUnknownOrderFigures(): OrderFiguresReader {
  throw new Error('NotImplemented: createUnknownOrderFigures');
}
