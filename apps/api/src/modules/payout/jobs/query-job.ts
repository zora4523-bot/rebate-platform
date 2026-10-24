// B2-06e: the query job of the payout process (规划/08 BR-WDR-14, BR-WDR-15, BR-WDR-17, BR-WDR-28;
// state machine W5 / W6). createQueryJob(options) is the handler of queue `payout`, job name
// `query`, payload QueryJobPayload { withdrawal_id, execute_seq, app_id, point } (B2-06d enqueues
// point 0; B2-06f registers the handler). Strict order:
//   ① read the withdrawal (app_id and id of the payload, row lock FOR NO KEY UPDATE). Missing,
//      status ≠ PAYING or execute_seq ≠ the payload's → resolve; nothing written, no query.
//   ② needs_manual = true → resolve: automatic queries have stopped (W10's "query now" is B2-09).
//   ③ T = `at` of the withdrawal's earliest kind=transfer attempt; none → warn and resolve.
//   ④ manualDue(schedule, T, now) → CAS needs_manual = true (row_version + 1, status and amounts
//      unchanged), logger.warn({ withdrawal_id, out_biz_no, point }, 'payout_needs_manual'), no
//      query, no job. needs_manual is granted to couli_payout only (db/schema.sql).
//   ⑤ otherwise channels[payout_channel].query(out_biz_no) at most 3 times, sleep(10 000) between
//      two tries (injected port; default the platform timers); each try writes one kind=query
//      payout_attempts row on attemptsDb (request { out_biz_no, point, try } with try 1, 2, 3,
//      the raw response, resp_code, resp_sub_code, result, latency_ms). success / fail stop the
//      tries. Timeouts, network errors, "order does not exist", processing and statuses outside
//      payout.query_status_map are unknown (the channel judges with the lists).
//   ⑥ success → W5 as in transfer-job.ts (CHANNEL_SUCCESS → PAID_API, channel_order_id, paid_at
//      the channel's time else Clock.now, WITHDRAW:SUCCESS:CASH_<channel> `wd:{id}:PAID`, event);
//      fail → W6 (CHANNEL_FAIL → FAILED, fail_code = sub_code, WITHDRAW:RETURN, event); 3 times
//      unknown → stays PAYING and, on one transaction, the next point:
//        queue.send('payout', 'query', { …, point: n + 1 }, { trx,
//          singletonKey: `${withdrawal_id}:${execute_seq}:query:${n + 1}`,
//          delaySeconds: max(0, T + queryPointOffsetSeconds(n + 1) − now) })
//      A CAS that hits nothing (row_version moved) only warns. A query never pauses the queue.
// No transaction or lock is held across a channel call or a sleep (the ① read ends before ⑤).
// payout.enabled = off and payout.queue_paused = true do not stop queries (BR-WDR-17). Logs carry
// withdrawal_id, out_biz_no, point, code, sub_code only — never the payee's account or name.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Ledger } from '../../ledger/index.ts';
import type { Clock, EventBus, JobHandler, JobQueue } from '../../platform/index.ts';
import type { WithdrawApplyOptions } from '../application/withdraw-apply.ts';
import type { PayoutConfigPort } from '../application/withdraw-rules.ts';
import type { PayoutChannel, PayoutChannelName } from '../infra/channels/payout-channel.ts';

export type { QueryJobPayload } from './transfer-job.ts';

/** The alert line when T + manual_after is reached (BR-WDR-14). */
export type QueryAlertMessage = 'payout_needs_manual';

/** Waits `ms` milliseconds (the gap between two tries of one point). */
export type QuerySleep = (ms: number) => Promise<void>;

export interface QueryJobLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface QueryJobOptions {
  /** Business handle: withdrawals, ledger, config, events and same-transaction jobs. */
  readonly db: Kysely<DB>;
  /** couli_payout handle: payout_attempts and withdrawals.needs_manual. */
  readonly attemptsDb: Kysely<DB>;
  readonly clock: Clock;
  /** content's configuration reader (payout.query_schedule, payout.query_status_map), direct PG. */
  readonly config: PayoutConfigPort;
  readonly ledger: Ledger;
  /** identity's users row lock (module lock order: users → balances). */
  readonly lockUsersForUpdate: WithdrawApplyOptions['lockUsersForUpdate'];
  readonly queue: JobQueue;
  readonly eventBus: EventBus;
  /** One adapter per opened channel (B2-06b); FakeChannel outside prod. */
  readonly channels: Readonly<Partial<Record<PayoutChannelName, PayoutChannel>>>;
  /** Default: the platform timers. */
  readonly sleep?: QuerySleep;
  readonly logger: QueryJobLogger;
}

export function createQueryJob(options: QueryJobOptions): JobHandler {
  void options;
  throw new Error('NotImplemented: createQueryJob');
}
