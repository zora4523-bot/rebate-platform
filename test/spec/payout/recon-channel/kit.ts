// B2-07c rule-test kit (claude-independent, SPEC_REF 37808a50; 规划/08 BR-WDR-23 通道对账对提现的影响 and
// its 细则, BR-WDR-15 24 小时未知人工处置, BR-FUND-24 人工调账; 编排裁定 D10-408): the worker's daily R2
// reconciliation of the Alipay bill against the withdrawals, on a real PostgreSQL.
// Real pieces: the job handler (apps/api/src/modules/payout/jobs/recon-job.ts createPayoutReconJob,
// queue payout-recon, job recon), the daily seed (application/recon-schedule.ts), payout's
// withdraw_holds writer (application/withdraw-holds.ts, audit port recorded), the production queue
// specs (pgboss.job read with plain SQL), and for ① the existing query chain of the payout process
// (B2-06e createQueryJob through ../query/kit.ts) and the worker's landing (B2-06fz). B2-06d's process
// kit seeds the withdrawals. Synthetic: the bill — FakeChannel's injectable demo bill (B2-07b), lines
// in the normalised ChannelBillLine shape, status 'SUCCESS' unless a test sets a status the query
// kit's payout.query_status_map maps to fail / unknown (not a captured Alipay bill).
// Conventions written out here, from the rule text and the task brief:
//   - The run of the 2026-10-18 bill happens T+1, the clock at 2026-10-19 10:00 +08:00 (NOW).
//   - PAID_* and W9-returned withdrawals carry fee and tax (amount_fen ≠ net_fen); the bill amount
//     is compared with net_fen and our_amount_fen records net_fen.
//   - Only a line whose status query_status_map maps to success is "支付宝成功".
//   - A recon diff: source R2, type channel_mismatch, period the bill day, open, deduplicated;
//     expected_fen = what our books paid out for it (net_fen of a PAID_* withdrawal, 0 otherwise),
//     actual_fen = the bill line's amount (0 without a line), diff_fen = expected − actual (as the
//     R4 diffs of B2-15j); ref_type 'withdrawal' / ref_id the withdrawal's id when there is one.
//   - A recon_diff hold: reason recon_diff, hold_until null (never expires by itself), not
//     released, source_ref naming the diff.
//   - An alert: a logger.warn line naming the withdrawal (id or out_biz_no) or the bill line.
// Only *.int.test.ts files call open (they create the database). Handler factories are called
// inside each test before anything is observed: red is the skeleton's NotImplemented.
import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type Selectable } from 'kysely';
import { expect, vi } from 'vitest';
import {
  createWithdrawHolds,
  type WithdrawHolds,
} from '../../../../apps/api/src/modules/payout/application/withdraw-holds.ts';
import { seedPayoutRecon } from '../../../../apps/api/src/modules/payout/application/recon-schedule.ts';
import type { ChannelBillLine } from '../../../../apps/api/src/modules/payout/domain/channel-result.ts';
import { FakeChannel } from '../../../../apps/api/src/modules/payout/infra/channels/fake-channel.ts';
import type { PayoutChannel } from '../../../../apps/api/src/modules/payout/infra/channels/payout-channel.ts';
import {
  createPayoutReconJob,
  type PayoutReconJobOptions,
} from '../../../../apps/api/src/modules/payout/jobs/recon-job.ts';
import {
  QUEUE_CATALOG,
  type JobHandler,
  type JobPayload,
  type ReceivedJob,
  type SendOptions,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { setupOn, teardown } from '../../platform/queue/int-kit.ts';
import {
  DAY,
  HOUR,
  NOW,
  QUERY_LISTS,
  setup as querySetup,
  snapshot,
  type Harness,
  type QueryFixture,
  type Seeded,
} from '../query/kit.ts';

export {
  DAY,
  HOUR,
  MINUTE,
  NOW,
  QUERY_FAIL_STEP,
  QUERY_LISTS,
  TIMEOUT,
  UNKNOWN_STEP,
  balanceOf,
  expectNoPayeeInLogs,
  queryScripted,
  querySuccess,
  withdrawal,
  withdrawalVouchers,
  type Harness,
  type Seeded,
} from '../query/kit.ts';

export const RECON_QUEUE = 'payout-recon';
export const RECON_JOB = 'recon';
export const CHANNEL = 'alipay';
/** The bill day reconciled by default and the next one. */
export const BILL_DATE = '2026-10-18';
export const NEXT_BILL_DATE = '2026-10-19';
/** 2026-10-18 10:00 +08:00: well inside the bill day. */
export const IN_DAY = new Date('2026-10-18T02:00:00.000Z');
/** 2026-10-18 23:59:30 +08:00: thirty seconds before the bill day ends. */
export const NEAR_DAY_END = new Date('2026-10-18T15:59:30.000Z');
/** Ends (+08:00) of 2026-10-18, 10-19 and 10-20, as UTC instants. */
export const END_OF_BILL_DAY = Date.parse('2026-10-18T16:00:00.000Z');
export const END_OF_NEXT_DAY = Date.parse('2026-10-19T16:00:00.000Z');
export const END_OF_DAY_AFTER = Date.parse('2026-10-20T16:00:00.000Z');
/** When the PAYING withdrawals were transferred: 2026-10-18 20:00 +08:00 (14 hours before NOW). */
export const TRANSFERRED_AT = new Date(NOW.getTime() - 14 * HOUR);
/** The bill's success status of these synthetic lines (query_status_map maps it to success). */
export const LINE_SUCCESS = 'SUCCESS';
/** Bill statuses that are not a success: query_status_map maps them to fail / unknown (query kit). */
export const LINE_FAIL = 'TEST_CLOSED';
export const LINE_UNKNOWN = 'DEALING';
/**
 * The fee and tax of the kit's PAID_* and W9-returned withdrawals unless given: amount_fen =
 * net_fen + 300 + 200, so a comparison with amount_fen instead of net_fen is visible.
 */
export const FEE = 300n;
export const TAX = 200n;

/** The production specs of the queues these tests send to, and their `<q>.dead`. */
const QUEUES = new Set([
  'payout',
  'payout-landing',
  'payout-review',
  'evt.payout-went-negative',
  RECON_QUEUE,
]);
const CATALOG = QUEUE_CATALOG.filter(
  (spec) => QUEUES.has(spec.name) || QUEUES.has(spec.name.replace(/\.dead$/, '')),
);

interface Database {
  urlFor(role: 'couli_app' | 'couli_payout'): string;
  drop(): Promise<void>;
}

/** The process kit's harness on a catalog that also holds payout-recon (when it exists). */
export async function open(create: () => Promise<Database>): Promise<Harness> {
  const database = await create();
  const setup = setupOn(database, 'api', {
    catalog: CATALOG,
    plan: { api: [], stream: [], admin: [], worker: [], payout: [] },
  });
  await setup.runtime.start();
  const app = database.urlFor('couli_app');
  return {
    database,
    setup,
    db: createDb({ connectionString: app, max: 8 }),
    observer: createDb({ connectionString: app, max: 3 }),
    payout: createDb({ connectionString: database.urlFor('couli_payout'), max: 3 }),
  };
}

export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await teardown([h.setup]);
  await Promise.all([destroyDb(h.db), destroyDb(h.observer), destroyDb(h.payout)]);
  await h.database.drop();
}

/** What a kit seed may set (fee / tax default to FEE / TAX: amount_fen ≠ net_fen). */
export interface WithdrawalValues {
  readonly net?: bigint;
  readonly fee?: bigint;
  readonly tax?: bigint;
  readonly userId?: string;
}

export interface PaidSeed extends Seeded {
  readonly channelOrderId: string;
  readonly paidAt: Date;
}

export function channelOrderId(): string {
  return `2026${randomBytes(12).toString('hex')}`;
}

/** The success line of the bill for `w` (its out_biz_no and net_fen unless patched). */
export function lineOf(
  w: Pick<Seeded, 'outBizNo' | 'net'> & { readonly channelOrderId?: string },
  patch: Partial<ChannelBillLine> = {},
): ChannelBillLine {
  return {
    outBizNo: w.outBizNo,
    channelOrderId: w.channelOrderId ?? channelOrderId(),
    amountFen: w.net,
    status: LINE_SUCCESS,
    bookedAt: '2026-10-18T10:05:00+08:00',
    ...patch,
  };
}

export async function setup(h: Harness) {
  const f = await querySetup(h);
  /** The demo bills of this app: bill day → lines (a day left out has no bill). */
  const days: Record<string, readonly ChannelBillLine[]> = {};
  const fake = new FakeChannel({
    mode: 'dry_run',
    lists: QUERY_LISTS,
    script: {},
    bills: { [f.appId]: days },
  });
  const audit = { append: vi.fn(async () => undefined) };
  const holds: WithdrawHolds = createWithdrawHolds({
    clock: f.clock,
    lockUsersForUpdate: f.options.lockUsersForUpdate,
    audit,
  });

  function setBill(billDate: string, lines: readonly ChannelBillLine[]): void {
    days[billDate] = lines.map((line) => ({ ...line }));
  }

  /** The bill days asked of the channel, in call order. */
  function billCalls(): string[] {
    return fake.calls.flatMap((call) => (call.kind === 'bill' ? [call.billDate] : []));
  }

  /** The worker's handler (called inside each test: red is the skeleton's NotImplemented). */
  function reconJob(extra: Partial<PayoutReconJobOptions> = {}): JobHandler {
    return createPayoutReconJob({
      db: h.db,
      clock: f.clock,
      config: f.options.config,
      queue: f.options.queue,
      bills: { alipay: fake },
      holds,
      logger: f.logger,
      ...extra,
    });
  }

  function reconJobOf(billDate: string, app = f.appId): ReceivedJob {
    return Object.freeze({
      id: randomUUID(),
      queue: RECON_QUEUE,
      name: RECON_JOB,
      payload: { app_id: app, channel: CHANNEL, bill_date: billDate },
      attempt: 1,
    });
  }

  /** One run of the reconciliation of `billDate` that must resolve. */
  async function runDay(billDate = BILL_DATE, extra: Partial<PayoutReconJobOptions> = {}) {
    const handler = reconJob(extra);
    await expect(handler(reconJobOf(billDate))).resolves.toBeUndefined();
  }

  /** The daily seed (called inside each test: red is the skeleton's NotImplemented). */
  function seed(): Promise<void> {
    return seedPayoutRecon({
      db: h.db,
      clock: f.clock,
      queue: f.options.queue,
      logger: f.logger,
    });
  }

  /** A PAID_API withdrawal paid at `paidAt` with its channel_order_id (fee / tax FEE / TAX). */
  async function seedPaid(paidAt: Date, values: WithdrawalValues = {}): Promise<PaidSeed> {
    const w = await f.seedWithdrawal({ fee: FEE, tax: TAX, ...values, status: 'PAID_API' });
    const order = channelOrderId();
    await sql`UPDATE app.withdrawals SET paid_at = ${paidAt}, channel_order_id = ${order}
      WHERE app_id = ${w.appId} AND id = ${w.id}`.execute(h.db);
    return { ...w, channelOrderId: order, paidAt };
  }

  /** A PAID_MANUAL withdrawal (manual transfer entered and confirmed) paid at `paidAt`. */
  async function seedManual(paidAt: Date, values: WithdrawalValues = {}): Promise<PaidSeed> {
    const w = await f.seedWithdrawal({ fee: FEE, tax: TAX, ...values, status: 'PAID_API' });
    const order = channelOrderId();
    await sql`UPDATE app.withdrawals SET status = 'PAID_MANUAL', paid_at = ${paidAt},
        channel_order_id = ${order}, manual_entry_by = ${randomUUID()},
        manual_confirm_by = ${randomUUID()}
      WHERE app_id = ${w.appId} AND id = ${w.id}`.execute(h.db);
    return { ...w, channelOrderId: order, paidAt };
  }

  /** An APPROVED withdrawal returned by W9 after a payer-side failure of its transfer. */
  async function seedReturned(values: WithdrawalValues = {}): Promise<Seeded> {
    const w = await f.seedWithdrawal({
      fee: FEE,
      tax: TAX,
      ...values,
      status: 'APPROVED',
      executeSeq: 1,
    });
    await f.seedAttempt(w.id, 'transfer', 'fail', TRANSFERRED_AT, w.appId);
    await sql`UPDATE app.withdrawals SET hold_reason = 'payer_side_after_transfer',
        hold_at = ${TRANSFERRED_AT}
      WHERE app_id = ${w.appId} AND id = ${w.id}`.execute(h.db);
    return w;
  }

  /**
   * The worker's turn after a payout-process handler: every created job of this app on
   * payout-recon other than a daily `recon` run goes through the recon handler, every
   * payout-landing job through the landing handler, until none is left. Rows are claimed first.
   */
  async function followUps(): Promise<void> {
    let handler: JobHandler | undefined;
    for (let round = 0; round < 8; round += 1) {
      const pending = await sql<{ id: string; data: { name: string; payload: JobPayload } }>`
        SELECT id::text AS id, data FROM pgboss.job
        WHERE name = ${RECON_QUEUE} AND state = 'created' AND data->>'name' <> ${RECON_JOB}
          AND data->'payload'->>'app_id' = ${f.appId}
        ORDER BY created_on, id`.execute(h.observer);
      const landed = await f.landPending();
      if (pending.rows.length === 0 && landed === 0) return;
      for (const row of pending.rows) {
        const claimed = await sql<{ id: string }>`
          DELETE FROM pgboss.job WHERE name = ${RECON_QUEUE} AND id = ${row.id}::uuid
            AND state = 'created' RETURNING id::text AS id`.execute(h.observer);
        if (claimed.rows.length !== 1) continue;
        handler ??= reconJob();
        await handler(
          Object.freeze({
            id: row.id,
            queue: RECON_QUEUE,
            name: row.data.name,
            payload: row.data.payload,
            attempt: 1,
          }),
        );
      }
    }
  }

  /**
   * ①: the query job the run left on queue `payout` for `w` (name `query`, due at once), claimed and
   * run through the payout process's query handler (B2-06e) with `channel`, then the worker's turn.
   * Returns how many such jobs there were (the test expects exactly one).
   */
  async function runImmediateQuery(w: Seeded, channel: PayoutChannel): Promise<number> {
    const queued = await sql<{ id: string; data: { name: string; payload: JobPayload } }>`
      SELECT id::text AS id, data FROM pgboss.job
      WHERE name = 'payout' AND state = 'created' AND data->>'name' = 'query'
        AND data->'payload'->>'withdrawal_id' = ${w.id}
        AND start_after <= created_on + interval '1 second'
      ORDER BY created_on, id`.execute(h.observer);
    const query = f.rawQueryJob(channel);
    for (const row of queued.rows) {
      await sql`DELETE FROM pgboss.job WHERE name = 'payout' AND id = ${row.id}::uuid`.execute(
        h.observer,
      );
      await query(
        Object.freeze({
          id: row.id,
          queue: 'payout',
          name: row.data.name,
          payload: row.data.payload,
          attempt: 1,
        }),
      );
    }
    await followUps();
    return queued.rows.length;
  }

  return {
    ...f,
    fake,
    audit,
    holds,
    setBill,
    billCalls,
    reconJob,
    reconJobOf,
    runDay,
    seed,
    seedPaid,
    seedManual,
    seedReturned,
    followUps,
    runImmediateQuery,
  };
}
export type ReconFixture = Awaited<ReturnType<typeof setup>>;

// ---------------------------------------------------------------------------------------------
// Readers.

export interface ReconRow {
  app_id: string;
  date: string;
  bill_date: string;
  out_biz_no: string | null;
  channel_order_id: string | null;
  our_status: string | null;
  channel_status: string | null;
  our_amount_fen: bigint | null;
  channel_amount_fen: bigint | null;
  result: string;
}

/** The recon_channel rows of the app (dates as text). */
export async function reconRows(f: QueryFixture): Promise<ReconRow[]> {
  const result = await sql<ReconRow>`
    SELECT app_id, date::text AS date, bill_date::text AS bill_date, out_biz_no, channel_order_id,
      our_status, channel_status, our_amount_fen, channel_amount_fen, result
    FROM app.recon_channel WHERE app_id = ${f.appId}
    ORDER BY bill_date, out_biz_no NULLS LAST, channel_order_id NULLS LAST`.execute(f.h.observer);
  return result.rows;
}

/** The rows of one withdrawal (by out_biz_no) or one bill line (by channel_order_id). */
export async function rowsOf(
  f: QueryFixture,
  key: { readonly outBizNo?: string | null; readonly channelOrderId?: string | null },
): Promise<ReconRow[]> {
  return (await reconRows(f)).filter(
    (row) =>
      (key.outBizNo != null && row.out_biz_no === key.outBizNo) ||
      (key.channelOrderId != null && row.channel_order_id === key.channelOrderId),
  );
}

export type DiffRow = Selectable<DB['recon_diffs']>;

export function diffs(f: QueryFixture): Promise<DiffRow[]> {
  return f.h.observer
    .withSchema('app')
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

export async function diffsOf(f: QueryFixture, refIds: readonly string[]): Promise<DiffRow[]> {
  return (await diffs(f)).filter((row) => refIds.includes(row.ref_id));
}

export interface ExpectedDiff {
  /** null: any non-empty ref_type. */
  readonly refType: string | null;
  /** One of these. */
  readonly refIds: readonly string[];
  readonly expectedFen: bigint;
  readonly actualFen: bigint;
  /** One of these (default: the bill day). */
  readonly periods?: readonly string[];
}

/** An open R2 channel_mismatch diff of the app, deduplicated, amounts as the kit's header says. */
export function expectDiff(f: QueryFixture, row: DiffRow | undefined, want: ExpectedDiff): void {
  expect(row, `recon diff of ${want.refIds.join(' / ')}`).toBeDefined();
  const diff = row!;
  expect(diff).toMatchObject({
    app_id: f.appId,
    type: 'channel_mismatch',
    source: 'R2',
    status: 'open',
    handler_id: null,
    closed_at: null,
    expected_fen: want.expectedFen,
    actual_fen: want.actualFen,
    diff_fen: want.expectedFen - want.actualFen,
  });
  expect(want.refIds).toContain(diff.ref_id);
  expect(want.periods ?? [BILL_DATE]).toContain(diff.period);
  if (want.refType === null) expect(diff.ref_type.length).toBeGreaterThan(0);
  else expect(diff.ref_type).toBe(want.refType);
  expect(typeof diff.dedupe_key === 'string' && diff.dedupe_key.length > 0, 'dedupe_key').toBe(
    true,
  );
}

/** The bill line travels on the diff (resolution names its channel_order_id). */
export function expectBillLineOn(row: DiffRow | undefined, line: ChannelBillLine): void {
  expect(row?.resolution, 'resolution').not.toBeNull();
  expect(JSON.stringify(row?.resolution ?? null)).toContain(line.channelOrderId);
}

export type HoldRow = Selectable<DB['withdraw_holds']>;

export function holdsOf(f: QueryFixture, userId: string): Promise<HoldRow[]> {
  return f.h.observer
    .withSchema('app')
    .selectFrom('withdraw_holds')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('user_id', '=', userId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

export async function allHolds(f: QueryFixture): Promise<HoldRow[]> {
  return f.h.observer
    .withSchema('app')
    .selectFrom('withdraw_holds')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

/** Exactly one hold of the member: recon_diff, never expiring by itself, not released, the diff's. */
export async function expectReconHold(f: QueryFixture, userId: string, diff: DiffRow | undefined) {
  const rows = await holdsOf(f, userId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    reason: 'recon_diff',
    hold_until: null,
    released_at: null,
    released_by: null,
  });
  expect(rows[0]?.created_by.length ?? 0).toBeGreaterThan(0);
  expect(diff, 'the diff the hold refers to').toBeDefined();
  expect(rows[0]?.source_ref ?? '').toContain(diff!.id);
}

export interface RunRow {
  app_id: string;
  channel: string;
  bill_date: string;
  status: string;
  started_at: Date;
  finished_at: Date;
  bill_rows: number;
  matched: number;
  diffs: number;
}

export async function runs(f: QueryFixture): Promise<RunRow[]> {
  const result = await sql<RunRow>`
    SELECT app_id, channel, bill_date::text AS bill_date, status, started_at, finished_at,
      bill_rows, matched, diffs
    FROM app.payout_recon_runs WHERE app_id = ${f.appId}
    ORDER BY bill_date`.execute(f.h.observer);
  return result.rows;
}

/** warn lines (the alerts) whose fields name one of `values`. */
export function alertsAbout(f: QueryFixture, values: readonly string[]): unknown[][] {
  return (f.logger.warn.mock.calls as unknown[][]).filter((call) => {
    const text = JSON.stringify(call, (_key: string, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    return values.some((value) => text.includes(value));
  });
}

/** info or warn lines whose fields name one of `values`. */
export function linesAbout(f: QueryFixture, values: readonly string[]): unknown[][] {
  return [
    ...(f.logger.info.mock.calls as unknown[][]),
    ...(f.logger.warn.mock.calls as unknown[][]),
  ].filter((call) => {
    const text = JSON.stringify(call, (_key: string, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    return values.some((value) => text.includes(value));
  });
}

/** What the reconciliation must leave as it was: withdrawals, vouchers and balances of the app. */
export async function books(f: QueryFixture) {
  const all = await snapshot(f);
  return { withdrawals: all.withdrawals, vouchers: all.vouchers, balances: all.balances };
}

export interface SentRecon {
  readonly payload: JobPayload;
  readonly options: SendOptions;
}

/** The daily `recon` jobs sent for this app (recording queue), in send order. */
export function reconSends(f: QueryFixture): SentRecon[] {
  return f.send.mock.calls
    .filter(
      (call) => call[0] === RECON_QUEUE && call[1] === RECON_JOB && call[2]['app_id'] === f.appId,
    )
    .map((call) => ({ payload: call[2], options: call[3] }));
}

/** When a sent job is due, by the fixture's clock now (the clock does not move during a run). */
export function dueMs(f: QueryFixture, sent: SentRecon): number {
  return f.clock.now().getTime() + (sent.options.delaySeconds ?? 0) * 1000;
}

export interface QueryJobRow {
  data: { name: string; payload: Record<string, unknown> };
  singleton_key: string | null;
  delay_s: number;
}

/** The created `query` jobs on queue payout naming `w`. */
export async function queryJobsOf(f: QueryFixture, w: Seeded): Promise<QueryJobRow[]> {
  const result = await sql<QueryJobRow>`
    SELECT data, singleton_key,
      round(extract(epoch FROM start_after - created_on))::int AS delay_s
    FROM pgboss.job
    WHERE name = 'payout' AND state = 'created' AND data->>'name' = 'query'
      AND data->'payload'->>'withdrawal_id' = ${w.id}
    ORDER BY created_on, id`.execute(f.h.observer);
  return result.rows;
}

/** Hours from NOW as an instant (negative: before). */
export function hoursFromNow(hours: number): Date {
  return new Date(NOW.getTime() + hours * HOUR);
}

/** The next day's clock: NOW + 1 day (the run of the 2026-10-19 bill). */
export const NEXT_RUN = new Date(NOW.getTime() + DAY);

/** A Kysely handle type re-export for the tests' own SQL. */
export type Db = Kysely<DB>;
