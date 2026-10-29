// B2-07c: the worker's daily R2 reconciliation of the payout channel (规划/08 BR-WDR-23, BR-WDR-15,
// BR-FUND-24; 编排裁定 D10-408). Handler of queue `payout-recon` (worker entry, couli_app):
//   job `recon`, payload PayoutReconJobPayload { app_id, channel: 'alipay', bill_date } (bill_date:
//   the +08:00 accounting day reconciled, run T+1), and job `manual_diff`, the follow-up of ①.
// recon:
//   - The channel's bill of bill_date (bills[channel].billDetails) is matched with the app's
//     withdrawals: a line with an out_biz_no by out_biz_no (then by channel_order_id), a line
//     without one (a manual transfer) by channel_order_id. Only a line whose status
//     payout.query_status_map maps to success is "支付宝成功". The line's amount is compared with
//     net_fen (@couli/money). One app.recon_channel row per line / per PAID_* withdrawal of the day
//     (date = bill_date = the bill reconciled), result matched / paying_query / paying_manual /
//     diff, upserted on the partial unique index of its key (a rerun rewrites the same row).
//   - ① line success, ours PAYING with needs_manual = false → an immediate query through the
//     existing query chain (queue `payout`, job `query`, due at once, the current point of the
//     schedule) marked source = 'recon' (D10-415 ②). needs_manual is couli_payout's column
//     (db/schema.sql): the worker cannot set it, the payout process's query job does — when that
//     query is not a success, or an ordinary query fails while recon_channel already shows the
//     bill's success — and then sends `manual_diff` { app_id, withdrawal_id, execute_seq } here.
// manual_diff (D10-416): the R2 diff of that withdrawal (ours 0, the bill line's amount, period
//   its bill day, deduplicated per withdrawal) and an alert when new; no hold (then BR-WDR-15,
//   W10). The bill line is read back from the withdrawal's success row in recon_channel.
//   - ② line success, ours PAYING with needs_manual = true → only the row (with the bill line) and
//     a pending-disposal hint (info line); W10 ends it.
//   - ③ line success and ours APPROVED / FAILED / REJECTED (or PENDING_REVIEW) or none; ours PAID_*
//     and no success line (near the day boundary: neither paid_at's day's bill nor the next day's);
//     amounts differ → recon_diffs (source R2, type channel_mismatch, dedupe_key; through ledger's
//     registerReconDiffOnce), an alert and, for the member, withdraw_holds reason recon_diff
//     without hold_until, all only when the diff is new. Every diff carries its bill line in
//     `resolution` (an APPROVED withdrawal returned by W9 marked for W11).
//   - Terminal withdrawals are read only (corrections go through a diff and an adjustment,
//     BR-FUND-24): nothing here writes withdrawals, vouchers or balances.
//   - Every run writes app.payout_recon_runs (app_id, channel, bill_date): succeeded when the day
//     ran to its end (diffs found included); partial when the bill could not be had (no port, or
//     PayoutBillUnavailableError: the job then fails for the queue's retry); failed when the run
//     failed. Never succeeded on a missing bill, and a later incomplete rerun never takes a
//     succeeded day back. Each run enqueues the next day's run (scheduleReconDay), on the run's own
//     transaction or, after a failure, on the one that records it.
// Alerts are logger.warn lines with a fixed message (the alert rules are another task's); logs
// carry ids, out_biz_no, channel_order_id, codes and amounts only — never the payee.
import type { DB } from '@couli/db';
import { chinaDayRange } from '@couli/domain';
import { subFen } from '@couli/money';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Logger } from 'pino';
import { registerReconDiffOnce, type ReconDiffRegistration } from '../../ledger/index.ts';
import {
  newUuidV7,
  type Clock,
  type JobHandler,
  type JobPayload,
  type JobQueue,
  type ReceivedJob,
} from '../../platform/index.ts';
import { readPayoutChannelConfig, type JudgementLists } from '../application/judgement.ts';
import { nextQueryPoint } from '../application/query-schedule.ts';
import {
  PAYOUT_RECON_JOB,
  PAYOUT_RECON_MANUAL_JOB,
  PAYOUT_RECON_QUEUE,
  PAYOUT_RECON_SOURCE,
  reconDayAfter,
  reconDayBefore,
  reconDayEndMs,
  reconDayStartMs,
  scheduleReconDay,
  type PayoutReconLogger,
  type PayoutReconManualPayload,
} from '../application/recon-schedule.ts';
import type { WithdrawHolds } from '../application/withdraw-holds.ts';
import type { PayoutConfigPort } from '../application/withdraw-rules.ts';
import { PayoutBillUnavailableError, type ChannelBillLine } from '../domain/channel-result.ts';
import type { PayoutChannel, PayoutChannelName } from '../infra/channels/payout-channel.ts';
import { PAYOUT_QUERY_JOB, PAYOUT_QUEUE, type QueryJobPayload } from './transfer-job.ts';

/** The worker's queue of the reconciliation (platform/queue catalog and worker plan). */
export type PayoutReconQueue = 'payout-recon';

/** The daily run of one (app, channel, bill day). */
export type PayoutReconJobName = 'recon';

/** R2 reconciles Alipay only for now (D10-408). */
export type PayoutReconChannel = 'alipay';

export interface PayoutReconJobPayload {
  readonly app_id: string;
  readonly channel: PayoutReconChannel;
  /** YYYY-MM-DD, the +08:00 accounting day of the bill. */
  readonly bill_date: string;
}

export type { PayoutReconLogger };

/** The bill reader of a channel: an adapter without billDetails has no bill (unavailable). */
export type PayoutBillPort = Pick<PayoutChannel, 'billDetails'>;

export interface PayoutReconJobOptions {
  /** couli_app: withdrawals (read only), recon_channel, payout_recon_runs, recon diffs, holds, jobs. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** content's configuration reader (payout.*), direct PG. */
  readonly config: PayoutConfigPort;
  readonly queue: JobQueue;
  /** The bill port of each reconciled channel. */
  readonly bills: Readonly<Partial<Record<PayoutChannelName, PayoutBillPort>>>;
  /** withdraw_holds (reason recon_diff) under the users lock, audited. */
  readonly holds: WithdrawHolds;
  readonly logger: PayoutReconLogger;
}

export { PAYOUT_RECON_JOB, PAYOUT_RECON_QUEUE };
/** ①'s follow-up on the same queue: the payout process set needs_manual against the bill. */
export { PAYOUT_RECON_MANUAL_JOB };
/** The alert of a new R2 diff (fixed message; the alert rule is another task's). */
export const PAYOUT_RECON_DIFF_ALERT = 'payout_recon_diff';
/** ②'s pending-disposal hint (W10 ends the withdrawal). */
export const PAYOUT_RECON_PENDING_DISPOSAL = 'payout_recon_pending_disposal';
/** The actor of the holds this job adds. */
export const PAYOUT_RECON_ACTOR = 'system:payout-recon';

/**
 * 「paid_at 靠近日界」: a PAID_* withdrawal paid within this window before a bill day's end may be
 * booked on the next day's bill, so it is a diff only when neither bill lists it (BR-WDR-23 细则;
 * ten minutes as payment's MIDNIGHT_GRACE_MS — 待实测).
 */
export const RECON_DAY_BOUNDARY_MS = 10 * 60_000;

const PAID: ReadonlySet<string> = new Set(['PAID_API', 'PAID_MANUAL']);
const PAYER_SIDE_HOLD = 'payer_side_after_transfer';

type DiffCase =
  | 'paid_not_in_bill'
  | 'paid_line_not_success'
  | 'amount_mismatch'
  | 'duplicate_payout'
  | 'payer_side_returned'
  | 'unknown_line'
  | 'query_not_success';

interface WithdrawalRow {
  readonly id: string;
  readonly user_id: string;
  readonly status: string;
  readonly needs_manual: boolean;
  readonly net_fen: bigint;
  readonly out_biz_no: string;
  readonly channel_order_id: string | null;
  readonly execute_seq: number;
  readonly hold_reason: string | null;
  readonly paid_at: Date | null;
}

const WITHDRAWAL_COLUMNS = [
  'id',
  'user_id',
  'status',
  'needs_manual',
  'net_fen',
  'out_biz_no',
  'channel_order_id',
  'execute_seq',
  'hold_reason',
  'paid_at',
] as const;

interface ReconRowValues {
  readonly outBizNo: string | null;
  readonly channelOrderId: string | null;
  readonly ourStatus: string | null;
  readonly ourAmountFen: bigint | null;
  readonly line: ChannelBillLine | null;
  readonly result: 'matched' | 'paying_query' | 'paying_manual' | 'diff';
}

interface DiffInput {
  readonly withdrawal: WithdrawalRow | null;
  readonly line: ChannelBillLine | null;
  readonly kind: DiffCase;
  readonly expectedFen: bigint;
  readonly actualFen: bigint;
  /** Whether the member gets a recon_diff hold (③); ① has none. */
  readonly hold: boolean;
  /** ①: the recon_channel row standing in for the bill line (not kept as a ChannelBillLine). */
  readonly billRow?: BillRowJson;
}

interface BillRowJson {
  readonly [key: string]: string | null;
  readonly recon_channel_id: string;
  readonly channel_order_id: string | null;
  readonly channel_status: string;
  readonly channel_amount_fen: string;
}

interface RunCounts {
  billRows: number;
  matched: number;
  diffs: number;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function parseRecon(job: ReceivedJob): PayoutReconJobPayload | null {
  const payload = job.payload as Record<string, unknown>;
  const appId = payload['app_id'];
  const channel = payload['channel'];
  const billDate = payload['bill_date'];
  if (!isText(appId) || channel !== 'alipay' || !isText(billDate)) return null;
  try {
    chinaDayRange(billDate);
  } catch {
    return null;
  }
  return { app_id: appId, channel, bill_date: billDate };
}

interface BillLineJson {
  readonly [key: string]: string | null;
  readonly out_biz_no: string | null;
  readonly channel_order_id: string;
  readonly amount_fen: string;
  readonly status: string;
  readonly booked_at: string;
}

function lineJson(line: ChannelBillLine): BillLineJson {
  return {
    out_biz_no: line.outBizNo,
    channel_order_id: line.channelOrderId,
    amount_fen: line.amountFen.toString(),
    status: line.status,
    booked_at: line.bookedAt,
  };
}

function parseManual(job: ReceivedJob): PayoutReconManualPayload | null {
  const payload = job.payload as Record<string, unknown>;
  const appId = payload['app_id'];
  const withdrawalId = payload['withdrawal_id'];
  const executeSeq = payload['execute_seq'];
  if (
    !isText(appId) ||
    !isText(withdrawalId) ||
    typeof executeSeq !== 'number' ||
    !Number.isInteger(executeSeq)
  ) {
    return null;
  }
  return { app_id: appId, withdrawal_id: withdrawalId, execute_seq: executeSeq };
}

export function createPayoutReconJob(options: PayoutReconJobOptions): JobHandler {
  const { db, clock, config, queue, bills, holds, logger } = options;
  /** readPayoutChannelConfig wants pino's warn; the job's logger has the same two-argument shape. */
  const configLogger = {
    warn: (fields: Record<string, unknown>, message?: string) => logger.warn(fields, message ?? ''),
  } as unknown as Pick<Logger, 'warn'>;

  function at(ms: number): Date {
    const instant = structuredClone(clock.now());
    instant.setTime(ms);
    return instant;
  }

  async function lists(trx: Transaction<DB>, appId: string) {
    return readPayoutChannelConfig(appId, trx, config, configLogger);
  }

  function isSuccess(map: JudgementLists['queryStatusMap'], status: string): boolean {
    return Object.hasOwn(map, status) && map[status] === 'success';
  }

  function sameAmount(a: bigint, b: bigint): boolean {
    return subFen(a, b) === 0n;
  }

  async function upsertRow(
    trx: Transaction<DB>,
    appId: string,
    billDate: string,
    row: ReconRowValues,
  ): Promise<void> {
    const now = clock.now();
    const values = {
      out_biz_no: row.outBizNo,
      channel_order_id: row.channelOrderId,
      our_status: row.ourStatus,
      channel_status: row.line?.status ?? null,
      our_amount_fen: row.ourAmountFen,
      channel_amount_fen: row.line?.amountFen ?? null,
      result: row.result,
    };
    const insert = trx
      .withSchema('app')
      .insertInto('recon_channel')
      .values({
        id: newUuidV7(now),
        app_id: appId,
        date: billDate,
        bill_date: billDate,
        ...values,
        created_at: now,
        updated_at: now,
      });
    // The conflict target names the partial unique index of the row's key, with its predicate.
    if (row.outBizNo !== null) {
      await insert
        .onConflict((oc) =>
          oc
            .columns(['app_id', 'bill_date', 'out_biz_no'])
            .where('out_biz_no', 'is not', null)
            .doUpdateSet({ ...values, updated_at: now }),
        )
        .execute();
    } else {
      await insert
        .onConflict((oc) =>
          oc
            .columns(['app_id', 'bill_date', 'channel_order_id'])
            .where('channel_order_id', 'is not', null)
            .doUpdateSet({ ...values, updated_at: now }),
        )
        .execute();
    }
  }

  /** The diff's dedupe key: per bill day and withdrawal / line; a missing PAID_* once per withdrawal. */
  function dedupeKey(billDate: string, input: DiffInput): string {
    if (input.withdrawal === null) {
      return `R2:alipay:${billDate}:line:${input.line?.channelOrderId ?? 'none'}`;
    }
    if (input.kind === 'paid_not_in_bill') return `R2:alipay:missing:wd:${input.withdrawal.id}`;
    // D10-416: one diff per withdrawal whichever query set needs_manual.
    if (input.kind === 'query_not_success') return `R2:alipay:paying:wd:${input.withdrawal.id}`;
    return `R2:alipay:${billDate}:wd:${input.withdrawal.id}`;
  }

  function resolution(billDate: string, input: DiffInput): JobPayload {
    const base: Record<string, string | boolean | BillLineJson | BillRowJson | null> = {
      case: input.kind,
      bill_date: billDate,
      bill_line: input.line === null ? null : lineJson(input.line),
    };
    if (input.billRow !== undefined) base['bill_row'] = input.billRow;
    if (input.withdrawal !== null) {
      base['withdrawal_id'] = input.withdrawal.id;
      base['out_biz_no'] = input.withdrawal.out_biz_no;
      base['our_status'] = input.withdrawal.status;
    }
    // BR-WDR-23 ③ 决-08 A: the bill line lets W11 settle the returned withdrawal as PAID_API.
    if (input.kind === 'payer_side_returned') base['w11_by_bill_line'] = true;
    return base as JobPayload;
  }

  /** Registers the diff; when new: the alert and (③) the member's hold, queued in `holdsToAdd`. */
  async function registerDiff(
    trx: Transaction<DB>,
    appId: string,
    billDate: string,
    input: DiffInput,
    holdsToAdd: { userId: string; diffId: string }[],
  ): Promise<ReconDiffRegistration> {
    const refType = input.withdrawal === null ? 'channel_order_id' : 'withdrawal';
    const refId = input.withdrawal?.id ?? input.line?.channelOrderId ?? 'none';
    const registration = await registerReconDiffOnce(
      trx,
      {
        appId,
        type: 'channel_mismatch',
        source: 'R2',
        period: billDate,
        refType,
        refId,
        expectedFen: input.expectedFen,
        actualFen: input.actualFen,
        diffFen: subFen(input.expectedFen, input.actualFen),
        dedupeKey: dedupeKey(billDate, input),
        resolution: resolution(billDate, input),
      },
      { clock },
    );
    if (registration.inserted) {
      logger.warn(
        {
          app_id: appId,
          bill_date: billDate,
          diff_id: registration.row.id,
          case: input.kind,
          withdrawal_id: input.withdrawal?.id ?? null,
          out_biz_no: input.withdrawal?.out_biz_no ?? input.line?.outBizNo ?? null,
          channel_order_id: input.line?.channelOrderId ?? input.billRow?.channel_order_id ?? null,
          expected_fen: input.expectedFen,
          actual_fen: input.actualFen,
        },
        PAYOUT_RECON_DIFF_ALERT,
      );
      if (input.hold && input.withdrawal !== null) {
        holdsToAdd.push({ userId: input.withdrawal.user_id, diffId: registration.row.id });
      }
    }
    return registration;
  }

  /** The new holds in user order (one lock order across the run). */
  async function addHolds(
    trx: Transaction<DB>,
    appId: string,
    holdsToAdd: { userId: string; diffId: string }[],
  ): Promise<void> {
    const sorted = [...holdsToAdd].sort((a, b) =>
      a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0,
    );
    for (const hold of sorted) {
      await holds.add(trx, {
        appId,
        userId: hold.userId,
        reason: 'recon_diff',
        sourceRef: `recon_diff:${hold.diffId}`,
        createdBy: PAYOUT_RECON_ACTOR,
        holdUntil: null,
      });
    }
  }

  async function writeRun(
    trx: Transaction<DB>,
    payload: PayoutReconJobPayload,
    status: 'succeeded' | 'partial' | 'failed',
    startedAt: Date,
    counts: RunCounts,
  ): Promise<void> {
    const finishedAt = clock.now();
    const values = {
      status,
      started_at: startedAt,
      finished_at: finishedAt,
      bill_rows: counts.billRows,
      matched: counts.matched,
      diffs: counts.diffs,
    };
    await trx
      .withSchema('app')
      .insertInto('payout_recon_runs')
      .values({
        id: newUuidV7(finishedAt),
        app_id: payload.app_id,
        channel: payload.channel,
        bill_date: payload.bill_date,
        ...values,
        created_at: finishedAt,
        updated_at: finishedAt,
      })
      .onConflict((oc) =>
        oc
          .columns(['app_id', 'channel', 'bill_date'])
          .doUpdateSet({ ...values, updated_at: finishedAt })
          // A day that ran to its end is never taken back by an incomplete rerun.
          .where(
            sql<boolean>`payout_recon_runs.status <> 'succeeded' OR excluded.status = 'succeeded'`,
          ),
      )
      .execute();
  }

  async function sendNextDay(trx: Transaction<DB>, payload: PayoutReconJobPayload): Promise<void> {
    const now = clock.now();
    await scheduleReconDay(queue, trx, payload.app_id, reconDayAfter(payload.bill_date, now), now);
  }

  /** An incomplete run: recorded with no counts, the next day still sent. */
  async function recordIncomplete(
    payload: PayoutReconJobPayload,
    status: 'partial' | 'failed',
    startedAt: Date,
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await writeRun(trx, payload, status, startedAt, { billRows: 0, matched: 0, diffs: 0 });
      await sendNextDay(trx, payload);
    });
  }

  /** Was this withdrawal listed (any status) on the bill of `billDate`, as a run recorded it? */
  async function listedOn(
    trx: Transaction<DB>,
    appId: string,
    billDate: string,
    w: WithdrawalRow,
  ): Promise<boolean> {
    const row = await trx
      .withSchema('app')
      .selectFrom('recon_channel')
      .select('id')
      .where('app_id', '=', appId)
      .where('bill_date', '=', sql<Date>`${billDate}::date`)
      .where('out_biz_no', '=', w.out_biz_no)
      .where('channel_status', 'is not', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  async function daySucceeded(
    trx: Transaction<DB>,
    appId: string,
    billDate: string,
  ): Promise<boolean> {
    const row = await trx
      .withSchema('app')
      .selectFrom('payout_recon_runs')
      .select('id')
      .where('app_id', '=', appId)
      .where('channel', '=', 'alipay')
      .where('bill_date', '=', sql<Date>`${billDate}::date`)
      .where('status', '=', 'succeeded')
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The withdrawals the bill's lines name (by out_biz_no or channel_order_id). */
  async function namedWithdrawals(
    trx: Transaction<DB>,
    appId: string,
    lines: readonly ChannelBillLine[],
  ): Promise<WithdrawalRow[]> {
    const outBizNos = [...new Set(lines.flatMap((line) => (line.outBizNo ? [line.outBizNo] : [])))];
    const orders = [...new Set(lines.map((line) => line.channelOrderId))];
    if (outBizNos.length === 0 && orders.length === 0) return [];
    return trx
      .withSchema('app')
      .selectFrom('withdrawals')
      .select(WITHDRAWAL_COLUMNS)
      .where('app_id', '=', appId)
      .where('payout_channel', '=', 'alipay')
      .where((eb) =>
        eb.or([
          ...(outBizNos.length > 0 ? [eb('out_biz_no', 'in', outBizNos)] : []),
          ...(orders.length > 0 ? [eb('channel_order_id', 'in', orders)] : []),
        ]),
      )
      .execute();
  }

  /** PAID_* withdrawals of the app paid within [fromMs, toMs). */
  async function paidBetween(
    trx: Transaction<DB>,
    appId: string,
    fromMs: number,
    toMs: number,
  ): Promise<WithdrawalRow[]> {
    return trx
      .withSchema('app')
      .selectFrom('withdrawals')
      .select(WITHDRAWAL_COLUMNS)
      .where('app_id', '=', appId)
      .where('payout_channel', '=', 'alipay')
      .where('status', 'in', [...PAID])
      .where('paid_at', '>=', at(fromMs))
      .where('paid_at', '<', at(toMs))
      .orderBy('paid_at')
      .orderBy('id')
      .execute();
  }

  /** ①: the immediate query on the existing chain, marked source = 'recon', on the run's transaction. */
  async function immediateQuery(
    trx: Transaction<DB>,
    payload: PayoutReconJobPayload,
    w: WithdrawalRow,
    schedule: Awaited<ReturnType<typeof lists>>['querySchedule'],
  ): Promise<void> {
    const now = clock.now();
    const first = await trx
      .withSchema('app')
      .selectFrom('payout_attempts')
      .select((eb) => eb.fn.min('at').as('first_at'))
      .where('app_id', '=', payload.app_id)
      .where('withdrawal_id', '=', w.id)
      .where('kind', '=', 'transfer')
      .executeTakeFirst();
    const firstAt = first?.first_at instanceof Date ? first.first_at : null;
    // The current point of the schedule: an unknown answer sends the chain's next point under
    // the chain's own key, merging with the one already queued.
    const point = firstAt === null ? 0 : Math.max(0, nextQueryPoint(schedule, firstAt, now) - 1);
    const query: QueryJobPayload = {
      withdrawal_id: w.id,
      execute_seq: w.execute_seq,
      app_id: payload.app_id,
      point,
    };
    await queue.send(
      PAYOUT_QUEUE,
      PAYOUT_QUERY_JOB,
      { ...query, source: PAYOUT_RECON_SOURCE },
      {
        trx,
        singletonKey: `${w.id}:${w.execute_seq}:query:recon:${payload.bill_date}`,
        delaySeconds: 0,
      },
    );
    logger.info(
      {
        app_id: payload.app_id,
        bill_date: payload.bill_date,
        withdrawal_id: w.id,
        out_biz_no: w.out_biz_no,
        point,
      },
      'payout_recon_query_sent',
    );
  }

  /** One day's reconciliation on one transaction; returns the counts. */
  async function reconcile(
    payload: PayoutReconJobPayload,
    lines: readonly ChannelBillLine[],
    startedAt: Date,
  ): Promise<RunCounts> {
    const appId = payload.app_id;
    const billDate = payload.bill_date;
    return db.transaction().execute(async (trx) => {
      const channelConfig = await lists(trx, appId);
      const statusMap = channelConfig.queryStatusMap;
      const named = await namedWithdrawals(trx, appId, lines);
      const byOutBizNo = new Map(named.map((w) => [w.out_biz_no, w]));
      const byOrder = new Map(
        named.flatMap((w) =>
          w.channel_order_id === null ? [] : [[w.channel_order_id, w] as const],
        ),
      );
      const counts: RunCounts = { billRows: lines.length, matched: 0, diffs: 0 };
      const handled = new Set<string>();
      const holdsToAdd: { userId: string; diffId: string }[] = [];

      const diff = async (row: ReconRowValues, input: DiffInput) => {
        await upsertRow(trx, appId, billDate, row);
        await registerDiff(trx, appId, billDate, input, holdsToAdd);
        counts.diffs += 1;
      };

      // Success lines first, so a key listed twice is judged by its success line.
      const ordered = [...lines].sort(
        (a, b) => Number(isSuccess(statusMap, b.status)) - Number(isSuccess(statusMap, a.status)),
      );
      const seen = new Set<string>();
      for (const line of ordered) {
        const w =
          (line.outBizNo === null ? undefined : byOutBizNo.get(line.outBizNo)) ??
          byOrder.get(line.channelOrderId) ??
          null;
        const key = w === null ? `line:${line.channelOrderId}` : `wd:${w.id}`;
        if (seen.has(key)) {
          logger.warn(
            {
              app_id: appId,
              bill_date: billDate,
              withdrawal_id: w?.id ?? null,
              channel_order_id: line.channelOrderId,
            },
            'payout_recon_line_repeated',
          );
          continue;
        }
        seen.add(key);
        if (w !== null) handled.add(w.id);
        const rowOf = (result: ReconRowValues['result']): ReconRowValues => ({
          outBizNo: w?.out_biz_no ?? line.outBizNo,
          channelOrderId: line.channelOrderId,
          ourStatus: w?.status ?? null,
          ourAmountFen: w?.net_fen ?? null,
          line,
          result,
        });

        if (!isSuccess(statusMap, line.status)) {
          if (w !== null && PAID.has(w.status)) {
            // Ours paid, the bill shows no success for it (③: 内部 PAID_*、支付宝没有成功记录).
            await diff(rowOf('diff'), {
              withdrawal: w,
              line,
              kind: 'paid_line_not_success',
              expectedFen: w.net_fen,
              actualFen: 0n,
              hold: true,
            });
          } else {
            logger.info(
              {
                app_id: appId,
                bill_date: billDate,
                withdrawal_id: w?.id ?? null,
                channel_order_id: line.channelOrderId,
                channel_status: line.status,
              },
              'payout_recon_line_not_success',
            );
          }
          continue;
        }

        if (w === null) {
          await diff(rowOf('diff'), {
            withdrawal: null,
            line,
            kind: 'unknown_line',
            expectedFen: 0n,
            actualFen: line.amountFen,
            hold: false,
          });
          continue;
        }

        if (PAID.has(w.status)) {
          if (sameAmount(line.amountFen, w.net_fen)) {
            await upsertRow(trx, appId, billDate, rowOf('matched'));
            counts.matched += 1;
          } else {
            await diff(rowOf('diff'), {
              withdrawal: w,
              line,
              kind: 'amount_mismatch',
              expectedFen: w.net_fen,
              actualFen: line.amountFen,
              hold: true,
            });
          }
          continue;
        }

        if (w.status === 'PAYING') {
          const agrees = sameAmount(line.amountFen, w.net_fen);
          if (!agrees) {
            await diff(rowOf('diff'), {
              withdrawal: w,
              line,
              kind: 'amount_mismatch',
              expectedFen: 0n,
              actualFen: line.amountFen,
              hold: true,
            });
          }
          if (!w.needs_manual) {
            // ①
            if (agrees) await upsertRow(trx, appId, billDate, rowOf('paying_query'));
            await immediateQuery(trx, payload, w, channelConfig.querySchedule);
          } else {
            // ②
            if (agrees) await upsertRow(trx, appId, billDate, rowOf('paying_manual'));
            logger.info(
              {
                app_id: appId,
                bill_date: billDate,
                withdrawal_id: w.id,
                out_biz_no: w.out_biz_no,
                channel_order_id: line.channelOrderId,
                channel_amount_fen: line.amountFen,
                channel_status: line.status,
              },
              PAYOUT_RECON_PENDING_DISPOSAL,
            );
          }
          continue;
        }

        // ③ the bill paid it, ours did not (APPROVED / FAILED / REJECTED / PENDING_REVIEW).
        await diff(rowOf('diff'), {
          withdrawal: w,
          line,
          kind:
            w.status === 'APPROVED' && w.hold_reason === PAYER_SIDE_HOLD
              ? 'payer_side_returned'
              : 'duplicate_payout',
          expectedFen: 0n,
          actualFen: line.amountFen,
          hold: true,
        });
      }

      // ③ ours PAID_* and no line: the day's payments, and the previous day's near its end.
      const now = clock.now();
      const dayStart = reconDayStartMs(billDate);
      const dayEnd = reconDayEndMs(billDate);
      const previous = reconDayBefore(billDate, now);
      const next = reconDayAfter(billDate, now);
      const candidates = [
        ...(await paidBetween(trx, appId, dayStart - RECON_DAY_BOUNDARY_MS, dayStart)).map((w) => ({
          w,
          other: previous,
        })),
        ...(await paidBetween(trx, appId, dayStart, dayEnd)).map((w) => ({
          w,
          other: (w.paid_at?.getTime() ?? dayStart) >= dayEnd - RECON_DAY_BOUNDARY_MS ? next : null,
        })),
      ];
      for (const { w, other } of candidates) {
        if (handled.has(w.id)) continue;
        handled.add(w.id);
        if (other !== null) {
          // Near the boundary: the other day's bill decides (listed there → not a diff; that
          // day not reconciled yet → its run, or a rerun of this one, decides).
          if (await listedOn(trx, appId, other, w)) continue;
          if (!(await daySucceeded(trx, appId, other))) {
            logger.info(
              { app_id: appId, bill_date: billDate, withdrawal_id: w.id, other_bill_date: other },
              'payout_recon_boundary_deferred',
            );
            continue;
          }
        }
        await diff(
          {
            outBizNo: w.out_biz_no,
            channelOrderId: null,
            ourStatus: w.status,
            ourAmountFen: w.net_fen,
            line: null,
            result: 'diff',
          },
          {
            withdrawal: w,
            line: null,
            kind: 'paid_not_in_bill',
            expectedFen: w.net_fen,
            actualFen: 0n,
            hold: true,
          },
        );
      }

      await addHolds(trx, appId, holdsToAdd);
      await writeRun(trx, payload, 'succeeded', startedAt, counts);
      await sendNextDay(trx, payload);
      return counts;
    });
  }

  async function runDay(payload: PayoutReconJobPayload): Promise<void> {
    const startedAt = clock.now();
    const fields = {
      app_id: payload.app_id,
      channel: payload.channel,
      bill_date: payload.bill_date,
    };
    const port = bills[payload.channel];
    if (port?.billDetails === undefined) {
      await recordIncomplete(payload, 'partial', startedAt);
      logger.warn({ ...fields, reason: 'no_bill_port' }, 'payout_recon_bill_unavailable');
      return;
    }
    let lines: readonly ChannelBillLine[];
    try {
      lines = await port.billDetails(payload.app_id, payload.bill_date);
    } catch (error: unknown) {
      const unavailable = error instanceof PayoutBillUnavailableError;
      await recordIncomplete(payload, unavailable ? 'partial' : 'failed', startedAt);
      logger.warn(
        { ...fields, reason: unavailable ? 'unavailable' : 'error', error_name: errorName(error) },
        'payout_recon_bill_unavailable',
      );
      // The queue retries the day; a missing bill is never "everything agrees".
      throw error;
    }
    let counts: RunCounts;
    try {
      counts = await reconcile(payload, lines, startedAt);
    } catch (error: unknown) {
      await recordIncomplete(payload, 'failed', startedAt);
      logger.warn({ ...fields, error_name: errorName(error) }, 'payout_recon_failed');
      throw error;
    }
    logger.info(
      { ...fields, bill_rows: counts.billRows, matched: counts.matched, diffs: counts.diffs },
      'payout_recon_done',
    );
  }

  /**
   * ①'s follow-up (D10-416): the payout process set needs_manual against the bill's success. The
   * withdrawal's success row in recon_channel (latest bill day) gives the period and amount.
   */
  async function manualDiff(payload: PayoutReconManualPayload): Promise<void> {
    const fields = { app_id: payload.app_id, withdrawal_id: payload.withdrawal_id };
    await db.transaction().execute(async (trx) => {
      const w = await trx
        .withSchema('app')
        .selectFrom('withdrawals')
        .select(WITHDRAWAL_COLUMNS)
        .where('app_id', '=', payload.app_id)
        .where('id', '=', payload.withdrawal_id)
        .executeTakeFirst();
      if (w === undefined) {
        logger.warn(fields, 'payout_recon_manual_missing');
        return;
      }
      const { queryStatusMap } = await lists(trx, payload.app_id);
      const rows = await trx
        .withSchema('app')
        .selectFrom('recon_channel')
        .select([
          'id',
          sql<string>`bill_date::text`.as('bill_date'),
          'channel_order_id',
          'channel_status',
          'channel_amount_fen',
        ])
        .where('app_id', '=', payload.app_id)
        .where('out_biz_no', '=', w.out_biz_no)
        .where('channel_status', 'is not', null)
        .where('channel_amount_fen', 'is not', null)
        .orderBy('bill_date', 'desc')
        .execute();
      const row = rows.find(
        (r) => r.channel_status !== null && isSuccess(queryStatusMap, r.channel_status),
      );
      if (row === undefined || row.channel_status === null || row.channel_amount_fen === null) {
        logger.warn({ ...fields, out_biz_no: w.out_biz_no }, 'payout_recon_manual_no_bill');
        return;
      }
      await registerDiff(
        trx,
        payload.app_id,
        row.bill_date,
        {
          withdrawal: w,
          line: null,
          kind: 'query_not_success',
          expectedFen: 0n,
          actualFen: row.channel_amount_fen,
          hold: false,
          billRow: {
            recon_channel_id: row.id,
            channel_order_id: row.channel_order_id,
            channel_status: row.channel_status,
            channel_amount_fen: row.channel_amount_fen.toString(),
          },
        },
        [],
      );
    });
  }

  return async function payoutReconJob(job: ReceivedJob): Promise<void> {
    if (job.name === PAYOUT_RECON_MANUAL_JOB) {
      const payload = parseManual(job);
      if (payload === null) {
        logger.warn(
          { job_id: job.id, queue: job.queue, name: job.name },
          'payout_recon_bad_payload',
        );
        return;
      }
      await manualDiff(payload);
      return;
    }
    const payload = job.name === PAYOUT_RECON_JOB ? parseRecon(job) : null;
    if (payload === null) {
      logger.warn({ job_id: job.id, queue: job.queue, name: job.name }, 'payout_recon_bad_payload');
      return;
    }
    await runDay(payload);
  };
}
