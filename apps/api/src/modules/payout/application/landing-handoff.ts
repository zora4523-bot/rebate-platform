// B2-06fz (D10-326 option C; 规划/02 §5.3 P→A): the payout process's side of a landing. The process
// connects as couli_payout (no grant on the ledger or users tables), so a success / fail result is
// only recorded on the attempt row and handed to the worker as one `payout-landing` job on the
// same couli_payout transaction (jobs/landing-job.ts lands W5 / W6 as couli_app). Before the hand-
// off the withdrawal is re-read on that transaction (D10-332 ①): status still PAYING, the same
// execute_seq and row_version as the job read first, needs_manual still false — otherwise the
// attempt stays recorded, logger.warn('payout_landing_skipped') and no job is sent (W10 ends the
// withdrawal). A payer-side result is W9 in the payout process and never handed over (D10-332 ②).
// The response JSON of a success / fail attempt carries what the worker needs: raw, kind, status
// (the channel's status before query_status_map), channel_order_id, paid_at (the channel's time)
// and received_at (the Clock when the result came back; paid_at falls back to it, D10-332 ③).
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { JobQueue } from '../../platform/index.ts';
import type { ChannelRaw, QueryResult, TransferResult } from '../domain/channel-result.ts';

export const PAYOUT_LANDING_QUEUE = 'payout-landing';
export const PAYOUT_LANDING_JOB = 'land';

/** What the payout process enqueues for an attempt whose result is success or fail. */
export interface LandingJobPayload {
  readonly app_id: string;
  readonly withdrawal_id: string;
  readonly execute_seq: number;
  readonly attempt_id: string;
}

export interface HandoffRow {
  readonly id: string;
  readonly app_id: string;
  readonly out_biz_no: string;
  readonly execute_seq: number;
  readonly row_version: number;
}

export interface HandoffLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/** The `response` JSON of a settled attempt (success / fail / unknown / payer_side). */
export function recordedResponse(
  result: (QueryResult | TransferResult) & { readonly raw: ChannelRaw },
  receivedAt: Date,
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    raw: result.raw,
    kind: result.kind,
    received_at: receivedAt.toISOString(),
  };
  if (result.status !== undefined) response['status'] = result.status;
  if (result.channelOrderId !== undefined) response['channel_order_id'] = result.channelOrderId;
  if (result.paidAt !== undefined) response['paid_at'] = result.paidAt;
  return response;
}

export interface HandoffInput {
  readonly trx: Transaction<DB>;
  readonly queue: JobQueue;
  readonly row: HandoffRow;
  readonly attemptId: string;
  readonly logger: HandoffLogger;
}

/**
 * Re-reads the withdrawal on the couli_payout transaction and, when it is unchanged since the job
 * read it (PAYING, same execute_seq and row_version, needs_manual false), sends the landing job on
 * that transaction. Returns whether the job was sent.
 */
export async function handoffLanding(input: HandoffInput): Promise<boolean> {
  const { trx, queue, row, attemptId, logger } = input;
  const current = await trx
    .withSchema('app')
    .selectFrom('withdrawals')
    .select(['status', 'execute_seq', 'row_version', 'needs_manual'])
    .where('app_id', '=', row.app_id)
    .where('id', '=', row.id)
    .executeTakeFirst();
  const unchanged =
    current !== undefined &&
    current.status === 'PAYING' &&
    current.execute_seq === row.execute_seq &&
    current.row_version === row.row_version &&
    current.needs_manual === false;
  if (!unchanged) {
    logger.warn(
      {
        withdrawal_id: row.id,
        out_biz_no: row.out_biz_no,
        attempt_id: attemptId,
        status: current?.status ?? null,
        execute_seq: current?.execute_seq ?? null,
        row_version: current?.row_version ?? null,
        needs_manual: current?.needs_manual ?? null,
      },
      'payout_landing_skipped',
    );
    return false;
  }
  const payload: LandingJobPayload = {
    app_id: row.app_id,
    withdrawal_id: row.id,
    execute_seq: row.execute_seq,
    attempt_id: attemptId,
  };
  await queue.send(
    PAYOUT_LANDING_QUEUE,
    PAYOUT_LANDING_JOB,
    { ...payload },
    { trx, singletonKey: `${row.id}:${row.execute_seq}:land:${attemptId}` },
  );
  logger.info(
    { withdrawal_id: row.id, out_biz_no: row.out_biz_no, attempt_id: attemptId },
    'payout_landing_queued',
  );
  return true;
}

/** Type guard for the handoff: couli_payout handles only. */
export type AttemptsHandle = Kysely<DB>;
