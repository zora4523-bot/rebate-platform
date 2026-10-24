// Read-only fund metric of orders (B1-01zzi; BR-FUND-02): open order_sync_pending rows per reason,
// across every app_id. The worker's /metrics reads it through this module's index.ts.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

/** order_sync_pending rows in status open, keyed by reason; a reason without open rows is absent. */
export async function readOrderSyncPendingOpen(
  db: Kysely<DB>,
): Promise<Readonly<Record<string, number>>> {
  void db;
  throw new Error('NotImplemented: readOrderSyncPendingOpen');
}
