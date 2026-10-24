// B2-06e: crash recovery of the query chain (规划/08 BR-WDR-14; 规划/12 §5.4). scan(handle, now)
// looks at every app's withdrawals in PAYING with needs_manual = false that have a kind=transfer
// attempt (any result; T = the earliest one's `at`):
//   manualDue(schedule, T, now) → CAS needs_manual = true (row_version + 1, on attemptsDb: only
//     couli_payout may write it), logger.warn({ withdrawal_id, out_biz_no, point },
//     'payout_needs_manual'), no job; counted in `manual`.
//   otherwise n = the first point with T + queryPointOffsetSeconds(n) > now and
//     queue.send('payout', 'query', { withdrawal_id, execute_seq, app_id, point: n },
//       { trx, singletonKey: `${withdrawal_id}:${execute_seq}:query:${n}`,
//         delaySeconds: min(T + offset(n), T + manual_after) − now })
//     a send that returns null (a queued or active job of that key already exists) is not
//     counted; one that returns an id is counted in `enqueued`.
// Withdrawals in other states, with needs_manual = true or without a transfer attempt are not
// touched. Returns { scanned (the withdrawals examined), enqueued, manual }. The process start and
// the hourly call are wired by B2-06f. payout.enabled / payout.queue_paused do not matter.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { JobQueue } from '../../platform/index.ts';
import { readPayoutChannelConfig } from './judgement.ts';
import { manualDue, nextQueryDueMs, nextQueryPoint, type QuerySchedule } from './query-schedule.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';
import { PAYOUT_QUERY_JOB, PAYOUT_QUEUE, type QueryJobPayload } from '../jobs/transfer-job.ts';
import { markNeedsManual } from './query-manual.ts';

export interface QueryRecoveryLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface QueryRecoveryOptions {
  /** couli_payout handle: withdrawals.needs_manual. */
  readonly attemptsDb: Kysely<DB>;
  /** content's configuration reader (payout.query_schedule), direct PG. */
  readonly config: PayoutConfigPort;
  readonly queue: JobQueue;
  readonly logger: QueryRecoveryLogger;
}

export interface QueryRecoveryResult {
  readonly scanned: number;
  readonly enqueued: number;
  readonly manual: number;
}

export interface QueryRecovery {
  /** `handle`: the business handle the withdrawals are read and the jobs are enqueued with. */
  scan(handle: Kysely<DB>, now: Date): Promise<QueryRecoveryResult>;
}

interface PayingRow {
  readonly id: string;
  readonly app_id: string;
  readonly execute_seq: number;
  readonly row_version: number;
  readonly out_biz_no: string;
  readonly first_transfer_at: Date;
}

export function createQueryRecovery(options: QueryRecoveryOptions): QueryRecovery {
  const { attemptsDb, config, queue, logger } = options;
  const configLogger = {
    warn: (fields: Record<string, unknown>, message?: string) => logger.warn(fields, message ?? ''),
  } as unknown as Pick<Logger, 'warn'>;

  /** PAYING, not needs_manual, with a transfer attempt; T = the earliest transfer attempt's `at`. */
  async function candidates(handle: Kysely<DB>): Promise<PayingRow[]> {
    const rows = await handle
      .withSchema('app')
      .selectFrom('withdrawals as w')
      .innerJoin(
        (eb) =>
          eb
            .selectFrom('payout_attempts as a')
            .select(['a.app_id', 'a.withdrawal_id'])
            .select((inner) => inner.fn.min('a.at').as('first_transfer_at'))
            .where('a.kind', '=', 'transfer')
            .groupBy(['a.app_id', 'a.withdrawal_id'])
            .as('t'),
        (join) => join.onRef('t.app_id', '=', 'w.app_id').onRef('t.withdrawal_id', '=', 'w.id'),
      )
      .select([
        'w.id',
        'w.app_id',
        'w.execute_seq',
        'w.row_version',
        'w.out_biz_no',
        't.first_transfer_at',
      ])
      .where('w.status', '=', 'PAYING')
      .where('w.needs_manual', '=', false)
      .orderBy('w.app_id')
      .orderBy('w.id')
      .execute();
    return rows as PayingRow[];
  }

  return {
    async scan(handle, now) {
      const rows = await candidates(handle);
      const schedules = new Map<string, QuerySchedule>();
      let enqueued = 0;
      let manual = 0;
      for (const row of rows) {
        let schedule = schedules.get(row.app_id);
        if (schedule === undefined) {
          schedule = (await readPayoutChannelConfig(row.app_id, handle, config, configLogger))
            .querySchedule;
          schedules.set(row.app_id, schedule);
        }
        const t = row.first_transfer_at;
        const point = nextQueryPoint(schedule, t, now);
        if (manualDue(schedule, t, now)) {
          const marked = await markNeedsManual(attemptsDb, row, point, now, logger);
          if (marked) manual += 1;
          continue;
        }
        const dueMs = nextQueryDueMs(schedule, t, point);
        const delaySeconds = Math.max(0, Math.ceil((dueMs - now.getTime()) / 1000));
        const payload: QueryJobPayload = {
          withdrawal_id: row.id,
          execute_seq: row.execute_seq,
          app_id: row.app_id,
          point,
        };
        const id = await handle
          .transaction()
          .execute((trx) =>
            queue.send(
              PAYOUT_QUEUE,
              PAYOUT_QUERY_JOB,
              { ...payload },
              { trx, singletonKey: `${row.id}:${row.execute_seq}:query:${point}`, delaySeconds },
            ),
          );
        if (id !== null) {
          enqueued += 1;
          logger.info(
            {
              withdrawal_id: row.id,
              out_biz_no: row.out_biz_no,
              point,
              delay_seconds: delaySeconds,
            },
            'payout_query_recovered',
          );
        }
      }
      const result = { scanned: rows.length, enqueued, manual };
      logger.info(result, 'payout_query_recovery_scan');
      return result;
    },
  };
}
