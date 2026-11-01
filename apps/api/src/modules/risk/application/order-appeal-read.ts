// B1-09p (BR-ID-36, D10-558): which of a user's orders have a processing order appeal. appeal_pending
// is derived here and nowhere stored on the order. SELECT only, on the handle it is given.
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
  return {
    async pendingOrderIds(appId, userId, orderIds) {
      if (orderIds.length === 0) return new Set();
      const rows = await db
        .withSchema('app')
        .selectFrom('appeals')
        .select('target_id')
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .where('target_type', '=', 'order')
        .where('status', '=', 'processing')
        .where('target_id', 'in', [...orderIds])
        .execute();
      return new Set(rows.map((row) => row.target_id));
    },
  };
}
