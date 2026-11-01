// B1-09p skeleton (BR-ID-36, D10-558): which of a user's orders have a processing order appeal,
// read only. Rule tests: test/spec/orders/figures/**.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface OrderAppealReader {
  /** The given orders of the app with a processing order appeal of the user. */
  pendingOrderIds(
    appId: string,
    userId: string,
    orderIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
}

export function createOrderAppealReader(db: Kysely<DB>): OrderAppealReader {
  void db;
  throw new Error('NotImplemented: createOrderAppealReader');
}
