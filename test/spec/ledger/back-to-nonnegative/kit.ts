import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import { vi } from 'vitest';
import {
  createLedger,
  type BalanceRecoveredHook,
  type BalanceRecoveredInput,
  type PostingVoucher,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { INSTANT, voucher } from '../posting/kit.ts';

export {
  TIMEOUT,
  account,
  entry,
  post,
  snapshot,
  bounded,
  waitBlocked,
  open,
  close,
  type Harness,
} from '../posting/kit.ts';

// Transactional sentinel only: no event bus, queue, payout implementation or withdrawal writes.
// The existing INSERT-only fixture table lets us observe commit/rollback without schema changes.
export function markerName(appId: string, accountId: string): string {
  return `test:B2-04ka:${appId}:${accountId}`;
}

export async function mark(trx: Transaction<DB>, input: BalanceRecoveredInput): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('processed_events')
    .values({
      consumer: markerName(input.appId, input.accountId),
      event_id: input.voucherId,
      created_at: new FixedClock(INSTANT).now(),
    })
    .execute();
}

export async function markers(db: Kysely<DB>, appId: string, accountId: string) {
  return db
    .withSchema('app')
    .selectFrom('processed_events')
    .selectAll()
    .where('consumer', '=', markerName(appId, accountId))
    .orderBy('event_id')
    .execute();
}

export function context(appId = `recovered-${randomUUID()}`) {
  const clock = new FixedClock(INSTANT);
  const onRecovered = vi.fn<BalanceRecoveredHook['onRecovered']>(mark);
  // Factory invocation belongs inside it: the red phase fails with NotImplemented per case.
  const ledger = createLedger({ clock, balanceRecoveredHook: { onRecovered } });
  return { clock, ledger, onRecovered, appId };
}

/** Positive debit reduces USER_BALANCE; negative debit credits it. */
export function change(
  appId: string,
  accountId: string,
  debit: bigint,
  type = 'CLAWBACK',
  extra: Partial<PostingVoucher> = {},
): PostingVoucher {
  const v = voucher(appId, accountId, debit, extra);
  return { ...v, entries: v.entries.map((e) => ({ ...e, ledger_type: type })) };
}
