// B2-06fz rule tests (D10-326 option C; 规划/02 §5.3 P→A; 规划/08 BR-WDR-13, BR-WDR-14,
// BR-WDR-09; state machine W5 / W6): the worker's landing job (jobs/landing-job.ts) on a real
// PostgreSQL with the real ledger and event bus. B2-06d's process kit does the rest: the database
// and its three pools (couli_app `db` and `observer`, couli_payout `payout`), the PAYING seeds
// with their real WITHDRAW:FREEZE voucher, observers and snapshots, and the landing handler
// itself (f.landingJob(): the fixture's couli_app handle, ledger, users lock, bus, clock, logger).
// Attempt rows are inserted here as couli_payout, the way the payout process records a result:
// `response` carries the raw answer plus channel_order_id, paid_at (the channel's time) and
// status (the channel's status before query_status_map), `at` is when the result was received.
// Only *.int.test.ts files call setup (they create the database). The handler is built inside
// each test before anything is seeded or observed: red is the skeleton's NotImplemented.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { ReceivedJob } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  LANDING_JOB,
  LANDING_QUEUE,
  MINUTE,
  NOW,
  type ProcessFixture,
  type Seeded,
} from '../process/kit.ts';

export {
  LANDING_JOB,
  LANDING_QUEUE,
  LOGON_ID,
  MINUTE,
  NOW,
  PAYEE_NAME,
  TIMEOUT,
  attempts,
  balanceOf,
  changes,
  close,
  entries,
  expectNoPayeeInLogs,
  jobs,
  open,
  setup,
  snapshot,
  withdrawal,
  withdrawalVouchers,
  type Harness,
  type ProcessFixture,
  type Seeded,
} from '../process/kit.ts';

/** When the payout process received the result (the attempt row's `at`): 3 minutes before NOW. */
export const RECEIVED_AT = new Date(NOW.getTime() - 3 * MINUTE);
/** The channel's own time of the payment (neither NOW nor RECEIVED_AT). */
export const CHANNEL_PAID_AT = '2026-10-19T09:58:30+08:00';

export type AttemptResult = 'pending' | 'success' | 'fail' | 'unknown';

export interface SeedResult {
  readonly kind?: 'transfer' | 'query';
  readonly result: AttemptResult;
  readonly at?: Date;
  readonly response?: Record<string, unknown> | null;
  readonly respCode?: string | null;
  readonly respSubCode?: string | null;
}

/**
 * One payout_attempts row of `w` with its result, as the payout process records it (couli_payout);
 * returns its id. The request is a masked summary (no payee account or name).
 */
export async function seedResult(
  f: ProcessFixture,
  w: Pick<Seeded, 'id' | 'appId' | 'outBizNo'>,
  values: SeedResult,
): Promise<string> {
  const id = randomUUID();
  const kind = values.kind ?? 'transfer';
  const request =
    kind === 'transfer'
      ? { out_biz_no: w.outBizNo, payee: { identity: 'log***26', name: '合**' } }
      : { out_biz_no: w.outBizNo, point: 1, try: 1 };
  const response =
    values.response === undefined || values.response === null
      ? null
      : JSON.stringify(values.response);
  await sql`INSERT INTO app.payout_attempts
    (id, app_id, withdrawal_id, kind, request, response, resp_code, resp_sub_code, result,
     latency_ms, at)
    VALUES (${id}, ${w.appId}, ${w.id}, ${kind}, ${JSON.stringify(request)}::jsonb,
      ${response}::jsonb, ${values.respCode ?? null}, ${values.respSubCode ?? null},
      ${values.result}, ${values.result === 'pending' ? null : 12},
      ${values.at ?? RECEIVED_AT})`.execute(f.h.payout);
  return id;
}

/** A success the channel answered: `response` as the payout process stores it. */
export function successResponse(channelOrderId: string, paidAt?: string): Record<string, unknown> {
  return {
    raw: { code: '10000' },
    kind: 'success',
    status: 'SUCCESS',
    channel_order_id: channelOrderId,
    ...(paidAt === undefined ? {} : { paid_at: paidAt }),
  };
}

/** A success attempt of `w` (resp_code 10000); returns its id. */
export function seedSuccess(
  f: ProcessFixture,
  w: Seeded,
  values: { channelOrderId?: string; paidAt?: string; at?: Date; kind?: 'transfer' | 'query' } = {},
): Promise<string> {
  return seedResult(f, w, {
    ...(values.kind === undefined ? {} : { kind: values.kind }),
    ...(values.at === undefined ? {} : { at: values.at }),
    result: 'success',
    respCode: '10000',
    respSubCode: null,
    response: successResponse(values.channelOrderId ?? `CH${w.outBizNo}`, values.paidAt),
  });
}

/** A definite failure of the transfer (definite_fail_codes); returns its id. */
export function seedTransferFail(f: ProcessFixture, w: Seeded): Promise<string> {
  return seedResult(f, w, {
    result: 'fail',
    respCode: '40004',
    respSubCode: 'TEST_CONFIRMED_FAIL',
    response: {
      raw: { code: '40004', subCode: 'TEST_CONFIRMED_FAIL', msg: 'synthetic' },
      kind: 'fail',
    },
  });
}

/** The payout-landing job the payout process enqueues for (w, attempt); overrides for the gates. */
export function landJobOf(
  w: Pick<Seeded, 'id' | 'appId' | 'executeSeq'>,
  attemptId: string,
  overrides: { seq?: number; appId?: string; withdrawalId?: string; attempt?: number } = {},
): ReceivedJob {
  return Object.freeze({
    id: randomUUID(),
    queue: LANDING_QUEUE,
    name: LANDING_JOB,
    payload: {
      app_id: overrides.appId ?? w.appId,
      withdrawal_id: overrides.withdrawalId ?? w.id,
      execute_seq: overrides.seq ?? w.executeSeq,
      attempt_id: attemptId,
    },
    attempt: overrides.attempt ?? 1,
  });
}

/** needs_manual = true as an earlier T + 24 h decision left it (couli_payout's column). */
export async function markNeedsManual(f: ProcessFixture, w: Seeded): Promise<void> {
  await sql`UPDATE app.withdrawals SET needs_manual = true, row_version = row_version + 1
    WHERE app_id = ${w.appId} AND id = ${w.id}`.execute(f.h.payout);
}

/** A member entry (USER_BALANCE; debit positive, credit negative). */
export function user(sub: 'available' | 'frozen', amount: bigint, type: string) {
  return {
    owner_type: 'user',
    subject: 'USER_BALANCE',
    sub_account: sub,
    amount_fen: amount,
    ledger_type: type,
  };
}

/** A platform entry (stored on the available sub-account). */
export function platform(subject: string, amount: bigint, type: string) {
  return {
    owner_type: 'platform',
    subject,
    sub_account: 'available',
    amount_fen: amount,
    ledger_type: type,
  };
}

/** wallet.withdrawal_changed payloads of this app that name `withdrawalId`. */
export async function changesOf(f: ProcessFixture, withdrawalId: string) {
  const rows = await f.h.observer
    .withSchema('app')
    .selectFrom('event_log')
    .select('payload')
    .where('app_id', '=', f.appId)
    .where('name', '=', 'wallet.withdrawal_changed')
    .orderBy('id')
    .execute();
  return rows
    .map((row) => (row.payload as unknown as { data: Record<string, unknown> }).data)
    .filter((data) => data['withdrawal_id'] === withdrawalId);
}

/**
 * True when no other connection holds a row lock on the withdrawal right now (an observer's
 * FOR NO KEY UPDATE SKIP LOCKED still sees the row; it takes and drops the lock at once).
 */
export async function withdrawalRowFree(f: ProcessFixture, w: Seeded): Promise<boolean> {
  const result = await sql<{ id: string }>`
    SELECT id::text AS id FROM app.withdrawals
    WHERE app_id = ${w.appId} AND id = ${w.id}
    FOR NO KEY UPDATE SKIP LOCKED`.execute(f.h.observer);
  return result.rows.length === 1;
}

/**
 * row_version + 1 from another connection, unless someone holds the row (then nothing happens and
 * false is returned: never waits on the landing's own lock).
 */
export async function bumpRowVersion(f: ProcessFixture, w: Seeded): Promise<boolean> {
  const result = await sql<{ id: string }>`
    UPDATE app.withdrawals SET row_version = row_version + 1
    WHERE app_id = ${w.appId} AND id IN (
      SELECT id FROM app.withdrawals WHERE app_id = ${w.appId} AND id = ${w.id}
      FOR NO KEY UPDATE SKIP LOCKED)
    RETURNING id::text AS id`.execute(f.h.observer);
  return result.rows.length === 1;
}
