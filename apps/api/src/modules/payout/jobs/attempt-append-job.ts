// B2-07e (D10-428): the payout process's handler of queue `payout-attempt-append` (couli_payout,
// concurrency 1). W11 (application/withdrawal-proven-success.ts) queues one job on its own
// transaction; this handler appends the attempt record of that W11 (规划/08 BR-WDR-08 W11: kind
// query, result success, the bill line as its evidence):
//   idempotent on (withdrawal_id, recon_diff_id): a kind=query, result=success row whose request
//   has source 'w11' and the same recon_diff_id already there → done; else one INSERT (request
//   { source: 'w11', recon_diff_id, bill_date, operator }, response the bill line's summary,
//   resp_code 'BILL_LINE', result 'success'). Existing rows are never changed.
//   A failure is thrown for the queue's retry; the last attempt logs logger.error with the alert
//   payout_attempt_append_failed. Logs carry ids only.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { Clock, JobHandler, ReceivedJob } from '../../platform/index.ts';
import type { AttemptAppendPayload } from '../application/withdrawal-proven-success.ts';

/** The payout process's queue of the W11 attempt records (platform/queue catalog and plan). */
export type PayoutAttemptAppendQueue = 'payout-attempt-append';

/** The alert of an attempt record that could not be appended after the last retry. */
export type PayoutAttemptAppendAlert = 'payout_attempt_append_failed';

export const PAYOUT_ATTEMPT_APPEND_ALERT: PayoutAttemptAppendAlert = 'payout_attempt_append_failed';
/** The source every W11 attempt record carries in its request (the idempotency key's marker). */
const SOURCE = 'w11';
const RESP_CODE = 'BILL_LINE';

export interface AttemptAppendLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface AttemptAppendJobOptions {
  /** couli_payout: the only role that may insert payout_attempts. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: AttemptAppendLogger;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function parse(job: ReceivedJob): AttemptAppendPayload | null {
  const payload = job.payload as Record<string, unknown>;
  const appId = text(payload['app_id']);
  const withdrawalId = text(payload['withdrawal_id']);
  const reconDiffId = text(payload['recon_diff_id']);
  const billDate = text(payload['bill_date']);
  const outBizNo = text(payload['out_biz_no']);
  const amountFen = text(payload['amount_fen']);
  const operator = text(payload['operator']);
  const at = text(payload['at']);
  if (
    appId === null ||
    withdrawalId === null ||
    reconDiffId === null ||
    billDate === null ||
    outBizNo === null ||
    amountFen === null ||
    operator === null ||
    at === null
  ) {
    return null;
  }
  return {
    app_id: appId,
    withdrawal_id: withdrawalId,
    recon_diff_id: reconDiffId,
    bill_date: billDate,
    out_biz_no: outBizNo,
    channel_order_id: text(payload['channel_order_id']),
    amount_fen: amountFen,
    booked_at: text(payload['booked_at']),
    operator,
    at,
  };
}

/**
 * The last delivery: the catalog's retryLimit of payout-attempt-append (5, the business queue
 * default; test/spec/payout/proven-success/queue.test.ts pins it) plus the first attempt.
 */
const LAST_ATTEMPT = 6;

export function createAttemptAppendJob(options: AttemptAppendJobOptions): JobHandler {
  const { db, clock, logger } = options;

  async function alreadyAppended(payload: AttemptAppendPayload): Promise<boolean> {
    const row = await db
      .withSchema('app')
      .selectFrom('payout_attempts')
      .select('id')
      .where('app_id', '=', payload.app_id)
      .where('withdrawal_id', '=', payload.withdrawal_id)
      .where('kind', '=', 'query')
      .where('result', '=', 'success')
      .where(sql`request->>'source'`, '=', SOURCE)
      .where(sql`request->>'recon_diff_id'`, '=', payload.recon_diff_id)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async function append(payload: AttemptAppendPayload): Promise<void> {
    const request = {
      source: SOURCE,
      recon_diff_id: payload.recon_diff_id,
      bill_date: payload.bill_date,
      operator: payload.operator,
    };
    const response = {
      out_biz_no: payload.out_biz_no,
      channel_order_id: payload.channel_order_id,
      amount_fen: payload.amount_fen,
      booked_at: payload.booked_at,
      channel_status: 'SUCCESS',
    };
    await db
      .withSchema('app')
      .insertInto('payout_attempts')
      .values({
        id: randomUUID(),
        app_id: payload.app_id,
        withdrawal_id: payload.withdrawal_id,
        kind: 'query',
        request: sql`${JSON.stringify(request)}::jsonb`,
        response: sql`${JSON.stringify(response)}::jsonb`,
        resp_code: RESP_CODE,
        resp_sub_code: null,
        result: 'success',
        latency_ms: null,
        at: clock.now(),
      })
      .execute();
  }

  return async function attemptAppendJob(job: ReceivedJob): Promise<void> {
    const payload = parse(job);
    if (payload === null) {
      logger.warn(
        { job_id: job.id, queue: job.queue, name: job.name },
        'payout_attempt_append_bad_payload',
      );
      return;
    }
    const fields = {
      job_id: job.id,
      attempt: job.attempt,
      app_id: payload.app_id,
      withdrawal_id: payload.withdrawal_id,
      recon_diff_id: payload.recon_diff_id,
    };
    try {
      if (await alreadyAppended(payload)) {
        logger.info(fields, 'payout_attempt_append_skipped');
        return;
      }
      await append(payload);
      logger.info(fields, 'payout_attempt_appended');
    } catch (error) {
      if (job.attempt >= LAST_ATTEMPT) {
        logger.error(
          { ...fields, error_name: error instanceof Error ? error.name : typeof error },
          PAYOUT_ATTEMPT_APPEND_ALERT,
        );
      }
      throw error;
    }
  };
}
