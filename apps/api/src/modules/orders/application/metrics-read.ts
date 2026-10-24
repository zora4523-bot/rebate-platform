// Read-only fund metric of orders (B1-01zzi; BR-FUND-02): open order_sync_pending rows per reason,
// across every app_id. The worker's /metrics reads it through this module's index.ts.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

interface PendingRow {
  readonly reason?: unknown;
  readonly open?: unknown;
}

/** A count column read leniently: a missing or unparsable value is 0. */
function countOf(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** order_sync_pending rows in status open, keyed by reason; a reason without open rows is absent. */
export async function readOrderSyncPendingOpen(
  db: Kysely<DB>,
): Promise<Readonly<Record<string, number>>> {
  const result = await sql<PendingRow>`
    SELECT reason, count(*)::integer AS open
    FROM app.order_sync_pending
    WHERE status = 'open'
    GROUP BY reason
    ORDER BY reason
  `.execute(db);
  const out: Record<string, number> = {};
  for (const row of result.rows) {
    // A row without a reason names no series.
    if (typeof row.reason !== 'string') continue;
    out[row.reason] = countOf(row.open);
  }
  return out;
}
