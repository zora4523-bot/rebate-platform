// B2-02s (FU-B202R-DONE-MARK): the durable completion record of the daily ledger check (08
// BR-FUND-19 每日 01:00 +08:00 对会计日 D−1 运行; task brief §9.2). When the `daily` handler of
// (app, D) has run to the end (the runner and the B2-02p execution step), it writes one row of
// app.processed_events — consumer 'ledger.daily_check_done', event_id dailyCheckDoneEventId(app, D),
// INSERT … ON CONFLICT DO NOTHING — on the same transaction that enqueues D+1. A run that throws
// before that writes nothing (the transaction rolls back). The run store's stateOf reports an
// (app, D) with that row as 'done' even when the queue holds only failed / dead-lettered jobs of
// its key (an attempt judged failed after expireInSeconds although its work had finished), so the
// heal neither re-sends nor alerts a finished day.
import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import { chinaDayRange } from '@couli/domain';
import type { Transaction } from 'kysely';
import { LedgerError } from './errors.ts';

/** The processed_events consumer of the completion record of (app, D). */
export type DailyCheckDoneConsumer = 'ledger.daily_check_done';

export const DAILY_CHECK_DONE_CONSUMER: DailyCheckDoneConsumer = 'ledger.daily_check_done';

/**
 * Fixed namespace of the completion records' event ids (RFC 4122 name-based, version 5); not the
 * overdue alert claim's namespace, so the two consumers' ids of one (app, D) differ as well.
 */
const DONE_NAMESPACE = '8b5e2f14-0c7a-5d39-a6e1-4f92c3b70d58';

/** A non-empty app_id and a strict, existing YYYY-MM-DD; anything else is INVALID_INPUT. */
export function validDailyCheckKey(appId: string, accountingDate: string): void {
  if (typeof appId !== 'string' || appId === '') {
    throw new LedgerError('INVALID_INPUT', 'app_id must be a non-empty string');
  }
  try {
    chinaDayRange(accountingDate);
  } catch (error) {
    throw new LedgerError(
      'INVALID_INPUT',
      `invalid accounting date ${JSON.stringify(accountingDate)}`,
      { cause: error },
    );
  }
}

/** RFC 4122 version 5 uuid of `name` in `namespace`. */
export function uuidV5(namespace: string, name: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The event_id (a uuid) of the completion record of (app, D): derived from app_id and D only, the
 * same in every process and after a restart; different for every other (app, D).
 */
export function dailyCheckDoneEventId(appId: string, accountingDate: string): string {
  validDailyCheckKey(appId, accountingDate);
  // JSON keeps the pair unambiguous whatever characters app_id holds.
  return uuidV5(DONE_NAMESPACE, JSON.stringify([appId, accountingDate]));
}

/**
 * Writes the completion record of (app, D) on `trx` (the transaction that enqueues D+1); an
 * existing record (a re-delivered finished run) is kept as it is. `at` is the injected Clock's now.
 */
export async function recordDailyCheckDone(
  trx: Transaction<DB>,
  appId: string,
  accountingDate: string,
  at: Date,
): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('processed_events')
    .values({
      consumer: DAILY_CHECK_DONE_CONSUMER,
      event_id: dailyCheckDoneEventId(appId, accountingDate),
      created_at: at,
    })
    .onConflict((oc) => oc.columns(['consumer', 'event_id']).doNothing())
    .execute();
}
