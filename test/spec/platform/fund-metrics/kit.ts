// B1-01zzi rule-test kit (规划/02 §13; BR-FUND-02, BR-FUND-04, BR-CALC-13, BR-WDR-14, BR-WDR-18;
// orchestrator brief B.1–B.4). The fund metric names, the port tables and the fixture's expected
// values are written out here, independent of the code under test. The Prometheus text reader and
// the compile-only database come from B1-01zzh's kit (read only, not changed). The test database
// comes from the int tests (@couli/db/testing is allowed in *.int.test.ts only).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  sql,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect } from 'vitest';
import type { FundMetricsSnapshot } from '../../../../apps/api/src/modules/platform/metrics/index.ts';
import { samples } from '../metrics/kit.ts';

/** The injected clock's instant. The database's own now() is years earlier on purpose. */
export const NOW = '2031-04-05T06:07:08.000Z';

export const DAY = 86_400;

/** NOW shifted by whole seconds, as an ISO instant. */
export function at(offsetSeconds: number): string {
  return new Date(Date.parse(NOW) + offsetSeconds * 1000).toISOString();
}

/** A second tenant: every port counts across app_id (the gauges carry no app_id label). */
export const OTHER_APP = 'couli_fund_other';

// ---- metric names (brief B.2) ------------------------------------------------------------------

/** couli_order_sync_pending_open carries one label, reason; the other four carry none. */
export const PENDING_METRIC = 'couli_order_sync_pending_open';

export const SCALAR_METRICS = {
  billJobsFailed: 'couli_settle_bill_jobs_failed',
  partialBatches: 'couli_settle_batches_partial',
  beneficiariesHeldOver30Days: 'couli_beneficiary_held_over_30d',
  payingNeedsManual: 'couli_withdrawals_paying_needs_manual',
} as const satisfies Record<Exclude<keyof FundMetricsSnapshot, 'orderSyncPendingOpen'>, string>;

export type ScalarKey = keyof typeof SCALAR_METRICS;
export const SCALAR_KEYS = Object.keys(SCALAR_METRICS) as ScalarKey[];

export const FUND_METRIC_NAMES: readonly string[] = [
  PENDING_METRIC,
  ...SCALAR_KEYS.map((key) => SCALAR_METRICS[key]),
];

/** Fund metric names the text mentions (a sample, HELP or TYPE line). */
export function fundNamesIn(text: string): string[] {
  return FUND_METRIC_NAMES.filter((name) =>
    new RegExp(`(^|[\\s{])${name}([\\s{]|$)`, 'm').test(text),
  );
}

/** couli_order_sync_pending_open as { reason: value }; every series carries only `reason`. */
export function pendingGauge(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sample of samples(text).filter((s) => s.name === PENDING_METRIC)) {
    expect(Object.keys(sample.labels), `${PENDING_METRIC} labels`).toEqual(['reason']);
    const reason = sample.labels['reason']!;
    expect(Object.hasOwn(out, reason), `${PENDING_METRIC}{reason="${reason}"} twice`).toBe(false);
    out[reason] = sample.value;
  }
  return out;
}

/** One unlabelled gauge: exactly one sample line without labels; its value. */
export function scalarGauge(text: string, key: ScalarKey): number {
  const name = SCALAR_METRICS[key];
  const found = samples(text).filter((s) => s.name === name);
  expect(found.length, `${name}: exactly one sample`).toBe(1);
  expect(found[0]!.labels, `${name} has no labels`).toEqual({});
  return found[0]!.value;
}

/** The fund part of a rendered text, in snapshot form. */
export function fundFromText(text: string): FundMetricsSnapshot {
  return {
    orderSyncPendingOpen: pendingGauge(text),
    billJobsFailed: scalarGauge(text, 'billJobsFailed'),
    partialBatches: scalarGauge(text, 'partialBatches'),
    beneficiariesHeldOver30Days: scalarGauge(text, 'beneficiariesHeldOver30Days'),
    payingNeedsManual: scalarGauge(text, 'payingNeedsManual'),
  };
}

// ---- the port tables (brief B.1) ---------------------------------------------------------------

/** Tables each module's port reads; a port never reads another module's fund table. */
export const PORT_TABLES = {
  orders: ['order_sync_pending'],
  settlement: ['settle_jobs', 'settle_batches', 'commission_split_beneficiary_events'],
  payout: ['withdrawals'],
} as const;

export const FUND_TABLES: readonly string[] = Object.values(PORT_TABLES).flat();

export function mentions(query: string, table: string): boolean {
  return new RegExp(`(^|[\\s."(,])${table}("|\\b)`).test(query);
}

/** Statements that write. */
export const WRITE_SQL = /^\s*(insert|update|delete|merge|truncate)\b/i;

/** The database's own clock; "now" must come from the injected Clock only. */
export const SQL_CLOCK =
  /\b(now\s*\(|current_timestamp|current_date|localtimestamp|transaction_timestamp|statement_timestamp|clock_timestamp)/i;

/**
 * A Kysely that compiles and logs every query but never connects. Each query answers `rows()`;
 * one empty row lets a port that reads `rows[0]` go on to its next query, so every table it reads
 * is logged (B1-01zzh's compileOnlyDb always answers no rows).
 */
export function recordingDb(
  queries: string[],
  rows: () => readonly Record<string, unknown>[],
): Kysely<DB> {
  const connection: DatabaseConnection = {
    executeQuery<R>(): Promise<QueryResult<R>> {
      return Promise.resolve({ rows: [...rows()] } as unknown as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('streamQuery is not used by the fund ports');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      queries.push(event.query.sql);
    },
  });
}

// ---- database fixtures -------------------------------------------------------------------------

export interface TestDatabaseUrls {
  urlFor(role: 'couli_app'): string;
}

/** The same role's URL, but every transaction of the session is READ ONLY (server side). */
export function readOnlyUrl(database: TestDatabaseUrls): string {
  const url = new URL(database.urlFor('couli_app'));
  url.searchParams.set('options', '-c default_transaction_read_only=on');
  return url.toString();
}

export async function insertUser(db: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO app.users (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status)
    VALUES (${id}, ${appId}, 'synthetic', 'synthetic', ${id.slice(0, 8)}, ${id.slice(9, 18)}, 'L1', 'sms', 'normal')`.execute(
    db,
  );
  return id;
}

export async function insertAdmin(db: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO app.admin_users
      (id, app_id, login_name, password_hash, is_super, status, created_at, updated_at)
    VALUES (${id}, ${appId}, ${`fund-metrics-${id}`}, 'synthetic-unused', false, 'active',
      ${at(-365 * DAY)}::timestamptz, ${at(-365 * DAY)}::timestamptz)`.execute(db);
  return id;
}

/** A new order key of `appId`; returns its order_id. */
export async function insertOrderKey(db: Kysely<DB>, appId: string): Promise<string> {
  const orderId = randomUUID();
  await sql`INSERT INTO app.order_keys (platform, sub_order_id, order_id, app_id, attr_at)
    VALUES ('taobao', ${`fund-${orderId}`}, ${orderId}, ${appId},
      ${at(-100 * DAY)}::timestamptz)`.execute(db);
  return orderId;
}

export type PendingReason =
  | 'UNMAPPED_STATUS'
  | 'UNFREEZE_SIGNAL'
  | 'ILLEGAL_TRANSITION'
  | 'NO_RECEIVED_AT'
  | 'AMOUNT_PARSE_FAILED';

export type PendingStatus = 'open' | 'resolved' | 'dismissed';

export async function insertPending(
  db: Kysely<DB>,
  row: { appId: string; reason: PendingReason; status: PendingStatus; subOrderId: string },
): Promise<void> {
  const closed = row.status !== 'open';
  await sql`INSERT INTO app.order_sync_pending
      (app_id, platform, sub_order_id, reason, raw_status, detail, detected_at, status,
       resolved_by, resolved_at, created_at)
    VALUES (${row.appId}, 'taobao', ${row.subOrderId}, ${row.reason}, 'synthetic', 'synthetic',
      ${at(-2 * DAY)}::timestamptz, ${row.status},
      ${closed ? randomUUID() : null}::uuid, ${closed ? at(-DAY) : null}::timestamptz,
      ${at(-2 * DAY)}::timestamptz)`.execute(db);
}

export async function insertSettleJob(
  db: Kysely<DB>,
  row: {
    appId: string;
    job: 'bill' | 'settle_adjust' | 'recon_union' | 'recon_monthly';
    status: 'running' | 'done' | 'failed';
    platform: string;
    runAt: string;
  },
): Promise<void> {
  const finished = row.status === 'running' ? null : row.runAt;
  await sql`INSERT INTO app.settle_jobs
      (id, app_id, job, platform, run_at, status, processed_count, skipped_count, started_at,
       finished_at, created_at)
    VALUES (${randomUUID()}, ${row.appId}, ${row.job}, ${row.platform}, ${row.runAt}::timestamptz,
      ${row.status}, 0, 0, ${row.runAt}::timestamptz, ${finished}::timestamptz,
      ${row.runAt}::timestamptz)`.execute(db);
}

export async function insertBill(db: Kysely<DB>, appId: string, billId: string): Promise<void> {
  await sql`INSERT INTO app.settle_bills (app_id, bill_id, generation_started_at, created_at)
    VALUES (${appId}, ${billId}, ${at(-20 * DAY)}::timestamptz, ${at(-20 * DAY)}::timestamptz)`.execute(
    db,
  );
}

export type BatchStatus = 'DRAFT' | 'CONFIRMED' | 'EXECUTING' | 'PARTIAL' | 'DONE' | 'CANCELLED';

export async function insertBatch(
  db: Kysely<DB>,
  row: { appId: string; billId: string; adminId: string; status: BatchStatus },
): Promise<void> {
  const confirmed = ['CONFIRMED', 'EXECUTING', 'PARTIAL', 'DONE'].includes(row.status);
  await sql`INSERT INTO app.settle_batches
      (batch_id, app_id, bill_id, platform, kind, status, settle_mode, confirmed_by, confirmed_at,
       cancelled_reason, order_count, created_at)
    VALUES (${randomUUID()}, ${row.appId}, ${row.billId}, 'taobao', 'main', ${row.status},
      'IMMEDIATE', ${confirmed ? row.adminId : null}::uuid,
      ${confirmed ? at(-10 * DAY) : null}::timestamptz,
      ${row.status === 'CANCELLED' ? 'synthetic' : null}, 0, ${at(-15 * DAY)}::timestamptz)`.execute(
    db,
  );
}

export type BeneficiaryRole = 'self' | 'share' | 'direct' | 'indirect';
export type BeneficiaryStatus = 'active' | 'held' | 'forfeited';

export interface BeneficiaryKey {
  readonly appId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly role: BeneficiaryRole;
}

/** Events of one key (app_id, order_id, user_id, role), inserted in order (event_seq ascending). */
export async function insertBeneficiaryEvents(
  db: Kysely<DB>,
  key: BeneficiaryKey,
  events: readonly (readonly [BeneficiaryStatus, number])[],
): Promise<void> {
  for (const [status, offsetSeconds] of events) {
    await sql`INSERT INTO app.commission_split_beneficiary_events
        (app_id, order_id, user_id, role, status, reason, created_at)
      VALUES (${key.appId}, ${key.orderId}, ${key.userId}, ${key.role}, ${status},
        ${status === 'active' ? null : 'synthetic'}, ${at(offsetSeconds)}::timestamptz)`.execute(
      db,
    );
  }
}

export type WithdrawalStatus =
  'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'PAYING' | 'PAID_API' | 'PAID_MANUAL' | 'FAILED';

export async function insertWithdrawal(
  db: Kysely<DB>,
  row: { appId: string; userId: string; status: WithdrawalStatus; needsManual: boolean },
): Promise<void> {
  const id = randomUUID();
  const paid = row.status === 'PAID_API' || row.status === 'PAID_MANUAL';
  const manual = row.status === 'PAID_MANUAL';
  await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, status, out_biz_no, payout_channel,
       needs_manual, paid_at, manual_entry_by, manual_confirm_by, reject_reason_code,
       created_at, updated_at)
    VALUES (${id}, ${row.appId}, ${row.userId}, 1000, 0, 0, 1000, 'SERVICE_FEE', 'alipay',
      'synthetic', ${Buffer.from('synthetic-cipher')}, ${'a'.repeat(64)}, ${row.status},
      ${id.replaceAll('-', '')}, 'alipay', ${row.needsManual},
      ${paid ? at(-DAY) : null}::timestamptz, ${manual ? randomUUID() : null}::uuid,
      ${manual ? randomUUID() : null}::uuid, ${row.status === 'REJECTED' ? 'USER_REQUEST' : null},
      ${at(-3 * DAY)}::timestamptz, ${at(-DAY)}::timestamptz)`.execute(db);
}

// ---- fixtures with their expected values -------------------------------------------------------

/**
 * Open rows per reason, across app_id. Closed rows (resolved / dismissed) never count, and a reason
 * with no open row has no key at all.
 */
export async function seedPending(db: Kysely<DB>): Promise<Readonly<Record<string, number>>> {
  const row = (appId: string, reason: PendingReason, status: PendingStatus, subOrderId: string) =>
    insertPending(db, { appId, reason, status, subOrderId });
  await row('couli', 'UNMAPPED_STATUS', 'open', 's1');
  await row('couli', 'UNMAPPED_STATUS', 'open', 's2');
  await row(OTHER_APP, 'UNMAPPED_STATUS', 'open', 's1');
  // The same sub-order's earlier UNMAPPED_STATUS rows, closed: not counted.
  await row('couli', 'UNMAPPED_STATUS', 'dismissed', 's1');
  await row('couli', 'UNMAPPED_STATUS', 'resolved', 's1');
  await row('couli', 'ILLEGAL_TRANSITION', 'open', 's3');
  // Reasons with closed rows only: absent from the result.
  await row('couli', 'NO_RECEIVED_AT', 'resolved', 's4');
  await row('couli', 'AMOUNT_PARSE_FAILED', 'dismissed', 's5');
  return { UNMAPPED_STATUS: 3, ILLEGAL_TRANSITION: 1 };
}

export interface SettlementExpected {
  readonly billJobsFailed: number;
  readonly partialBatches: number;
  readonly beneficiariesHeldOver30Days: number;
}

/** Failed jobs of kind bill only (every platform and app_id; other job kinds never count). */
export async function seedSettleJobs(db: Kysely<DB>): Promise<number> {
  const job = (
    appId: string,
    kind: 'bill' | 'settle_adjust' | 'recon_union' | 'recon_monthly',
    status: 'running' | 'done' | 'failed',
    platform: string,
    runAt: string,
  ) => insertSettleJob(db, { appId, job: kind, status, platform, runAt });
  await job('couli', 'bill', 'failed', 'taobao', at(-10 * DAY)); // counts
  await job('couli', 'bill', 'failed', 'jd', at(-10 * DAY)); // counts
  await job('couli', 'bill', 'failed', 'taobao', at(-40 * DAY)); // counts
  await job(OTHER_APP, 'bill', 'failed', 'taobao', at(-10 * DAY)); // counts
  await job('couli', 'bill', 'done', 'taobao', at(-5 * DAY));
  await job('couli', 'bill', 'running', 'pdd', at(-DAY));
  await job('couli', 'settle_adjust', 'failed', 'taobao', at(-10 * DAY));
  await job('couli', 'recon_union', 'failed', 'taobao', at(-10 * DAY));
  await job('couli', 'recon_monthly', 'failed', 'taobao', at(-10 * DAY));
  return 4;
}

/** Batches in status PARTIAL only (every app_id). */
export async function seedBatches(db: Kysely<DB>): Promise<number> {
  for (const appId of ['couli', OTHER_APP]) await insertBill(db, appId, '2031-03');
  const admin = await insertAdmin(db, 'couli');
  const otherAdmin = await insertAdmin(db, OTHER_APP);
  const batch = (appId: string, adminId: string, status: BatchStatus) =>
    insertBatch(db, { appId, billId: '2031-03', adminId, status });
  await batch('couli', admin, 'PARTIAL'); // counts
  await batch('couli', admin, 'PARTIAL'); // counts
  await batch(OTHER_APP, otherAdmin, 'PARTIAL'); // counts
  for (const status of ['DRAFT', 'CONFIRMED', 'EXECUTING', 'DONE', 'CANCELLED'] as const) {
    await batch('couli', admin, status);
  }
  return 3;
}

/**
 * Beneficiary keys (app_id, order_id, user_id, role). A key counts when its latest event (max
 * event_seq) is held and its first held event was created at or before now − 30 × 24 h of the
 * injected clock. Offsets are seconds from NOW. Returns the count at NOW and one day later.
 */
export async function seedBeneficiaries(
  db: Kysely<DB>,
): Promise<{ atNow: number; oneDayLater: number }> {
  const key = async (
    appId: string,
    role: BeneficiaryRole,
    orderId?: string,
    userId?: string,
  ): Promise<BeneficiaryKey> => ({
    appId,
    orderId: orderId ?? (await insertOrderKey(db, appId)),
    userId: userId ?? randomUUID(),
    role,
  });
  // A: held 31 days → counts.
  const a = await key('couli', 'self');
  await insertBeneficiaryEvents(db, a, [['held', -31 * DAY]]);
  // K: same order and user as A, another role: its own key, held 35 days → counts.
  await insertBeneficiaryEvents(db, await key('couli', 'direct', a.orderId, a.userId), [
    ['held', -35 * DAY],
  ]);
  // B: held exactly 30 × 24 h before NOW → counts (满 30 天 includes the boundary).
  await insertBeneficiaryEvents(db, await key('couli', 'share'), [['held', -30 * DAY]]);
  // C: one second short of 30 days → not yet; counts one day later.
  await insertBeneficiaryEvents(db, await key('couli', 'self'), [['held', -30 * DAY + 1]]);
  // D: 29 days → not yet; one day later it is exactly 30 days → counts.
  await insertBeneficiaryEvents(db, await key('couli', 'indirect'), [['held', -29 * DAY]]);
  // E: held long ago, latest event active → never.
  await insertBeneficiaryEvents(db, await key('couli', 'self'), [
    ['held', -40 * DAY],
    ['active', -10 * DAY],
  ]);
  // F: held long ago, latest event forfeited → never.
  await insertBeneficiaryEvents(db, await key('couli', 'direct'), [
    ['held', -40 * DAY],
    ['forfeited', -5 * DAY],
  ]);
  // G: held 45 days, held again 2 days ago (still held): measured from the first held → counts.
  await insertBeneficiaryEvents(db, await key('couli', 'self'), [
    ['held', -45 * DAY],
    ['held', -2 * DAY],
  ]);
  // H: active first, held 31 days ago → counts.
  await insertBeneficiaryEvents(db, await key('couli', 'self'), [
    ['active', -60 * DAY],
    ['held', -31 * DAY],
  ]);
  // I: active first, held 20 days ago → never in this test. Its user's other keys were held
  // 50 days ago but are active now: the first held is per key, not per user or per order.
  const i = await key('couli', 'self');
  await insertBeneficiaryEvents(db, i, [
    ['active', -60 * DAY],
    ['held', -20 * DAY],
  ]);
  await insertBeneficiaryEvents(db, await key('couli', 'direct', i.orderId, i.userId), [
    ['held', -50 * DAY],
    ['active', -10 * DAY],
  ]);
  await insertBeneficiaryEvents(db, await key('couli', 'self', undefined, i.userId), [
    ['held', -50 * DAY],
    ['active', -10 * DAY],
  ]);
  // M: only ever active → never.
  await insertBeneficiaryEvents(db, await key('couli', 'self'), [['active', -90 * DAY]]);
  // L: another app_id, held 31 days → counts.
  await insertBeneficiaryEvents(db, await key(OTHER_APP, 'self'), [['held', -31 * DAY]]);
  // At NOW: A, K, B, G, H, L. One day later also C and D.
  return { atNow: 6, oneDayLater: 8 };
}

/** PAYING with needs_manual only (every app_id). */
export async function seedWithdrawals(db: Kysely<DB>): Promise<number> {
  const user = await insertUser(db, 'couli');
  const otherUser = await insertUser(db, OTHER_APP);
  const w = (appId: string, userId: string, status: WithdrawalStatus, needsManual: boolean) =>
    insertWithdrawal(db, { appId, userId, status, needsManual });
  await w('couli', user, 'PAYING', true); // counts
  await w('couli', user, 'PAYING', true); // counts
  await w(OTHER_APP, otherUser, 'PAYING', true); // counts
  await w('couli', user, 'PAYING', false); // still being paid normally
  // needs_manual stays set after the result is known: no longer PAYING, never counts.
  await w('couli', user, 'FAILED', true);
  await w('couli', user, 'PAID_API', true);
  await w('couli', user, 'PAID_MANUAL', true);
  await w('couli', user, 'REJECTED', true);
  await w('couli', user, 'APPROVED', false);
  await w('couli', user, 'PENDING_REVIEW', false);
  return 3;
}

export async function seedSettlement(
  db: Kysely<DB>,
): Promise<{ atNow: SettlementExpected; oneDayLater: SettlementExpected }> {
  const billJobsFailed = await seedSettleJobs(db);
  const partialBatches = await seedBatches(db);
  const held = await seedBeneficiaries(db);
  return {
    atNow: { billJobsFailed, partialBatches, beneficiariesHeldOver30Days: held.atNow },
    oneDayLater: { billJobsFailed, partialBatches, beneficiariesHeldOver30Days: held.oneDayLater },
  };
}

/** Every fund fixture; the expected snapshot at NOW and one day later. */
export async function seedFund(
  db: Kysely<DB>,
): Promise<{ atNow: FundMetricsSnapshot; oneDayLater: FundMetricsSnapshot }> {
  const orderSyncPendingOpen = await seedPending(db);
  const settlement = await seedSettlement(db);
  const payingNeedsManual = await seedWithdrawals(db);
  return {
    atNow: { orderSyncPendingOpen, ...settlement.atNow, payingNeedsManual },
    oneDayLater: { orderSyncPendingOpen, ...settlement.oneDayLater, payingNeedsManual },
  };
}
