// B2-09d rule-test kit (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml CT-24z
// listAdminSettleBills (GET /admin/v1/settle-bills), getAdminSettleBill
// (GET /admin/v1/settle-bills/{bill_id}) and listAdminSettleBatchItems
// (GET /admin/v1/settle-batches/{batch_id}/items) — settle.bill or fund.view, read only, no
// step-up; only settle_bills / settle_batches / settle_batch_items of the caller's app; the bill
// status derived at read time from the batches of the bill's latest round (AdminSettleBillStatus,
// 08 BR-FUND-04 细则「月结账单状态」), never stored; the bill-day totals read as stored (supplement
// batches do not write them back, D10-280 ③); item counts summed at read time; reading writes no
// audit record.
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// contract validation, the field cipher of the process, the injected clock), PostgreSQL through
// @couli/db/testing as couli_app, Redis for the admin sessions (../../payment/orders/kit.ts suite).
// Synthetic: the settle_bills / settle_batches / settle_batch_items rows (written directly as
// couli_app, the settlement module's role, as the bill-day task, a supplement launch or the batch
// commands would have left them), the order keys, beneficiary obligations and users they refer to,
// the admin accounts, every phone number. No real user or merchant data. Missing pieces fail as
// assertions (an unregistered admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Insertable, type Kysely, type RawBuilder, type Selectable } from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import {
  PHONE_BLIND_INDEX_CONTEXT,
  PHONE_CIPHER_CONTEXT,
} from '../../../../apps/api/src/modules/identity/domain/registration.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  FIELD_CRYPTO,
  FixedClock,
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type FieldCrypto,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type { Suite } from '../../payment/orders/kit.ts';

export { suite } from '../../payment/orders/kit.ts';

export const NOW = '2026-10-30T02:00:00.000Z';
export const MINUTE = 60_000;
export const LIST_PATH = '/admin/v1/settle-bills';
export const DETAIL_PATH = '/admin/v1/settle-bills/{bill_id}';
export const ITEMS_PATH = '/admin/v1/settle-batches/{batch_id}/items';
/** specs/permissions.yaml: the two read points of CT-24z (any one is enough; no step-up). */
export const BILL = 'settle.bill';
export const VIEW = 'fund.view';

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

// ---------------------------------------------------------------------------------------------
// One app on the suite's database.

export interface Fixture {
  readonly s: Suite;
  readonly db: Kysely<DB>;
  readonly clock: FixedClock;
  readonly appId: string;
}

export function fixture(s: Suite, instant = NOW): Fixture {
  return {
    s,
    db: s.db(),
    clock: new FixedClock(instant),
    appId: `sbill_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
  };
}

/** An instant `minutes` before the fixture's clock. */
export function ago(f: Fixture, minutes: number): Date {
  return new Date(f.clock.now().getTime() - minutes * MINUTE);
}

/** An instant `minutes` after the fixture's clock. */
export function later(f: Fixture, minutes: number): Date {
  return new Date(f.clock.now().getTime() + minutes * MINUTE);
}

// ---------------------------------------------------------------------------------------------
// Rows. Every value below is synthetic.

export type BillRow = Selectable<DB['settle_bills']>;
export type BatchRow = Selectable<DB['settle_batches']>;
export type ItemRow = Selectable<DB['settle_batch_items']>;

type JsonColumn = BillRow['platform_order_counts'];

function jsonb(value: Readonly<Record<string, number>> | null): RawBuilder<JsonColumn> | null {
  return value === null ? null : sql<JsonColumn>`${JSON.stringify(value)}::jsonb`;
}

export type BillSeed = Partial<
  Omit<
    Insertable<DB['settle_bills']>,
    'app_id' | 'bill_id' | 'platform_order_counts' | 'platform_settle_commission_totals'
  >
> & {
  readonly platform_order_counts?: Readonly<Record<string, number>> | null;
  readonly platform_settle_commission_totals?: Readonly<Record<string, number>> | null;
};

/** A bill whose bill-day task is still checking and generating: no totals yet. */
export const GENERATING: BillSeed = {
  generated_at: null,
  platform_order_counts: null,
  platform_settle_commission_totals: null,
  beneficiary_total_fen: null,
  platform_retained_fen: null,
  error_count: null,
  held_count: null,
};

/** One settle_bills row of the fixture's app: generated, with bill-day totals, unless seeded. */
export async function seedBill(f: Fixture, billId: string, seed: BillSeed = {}): Promise<BillRow> {
  const {
    platform_order_counts = { taobao: 3, jd: 1 },
    platform_settle_commission_totals = { taobao: 86_400, jd: 15_100 },
    ...rest
  } = seed;
  const started = rest.generation_started_at ?? ago(f, 600);
  await f.db
    .insertInto('settle_bills')
    .values({
      app_id: f.appId,
      bill_id: billId,
      generation_started_at: started,
      generated_at: ago(f, 590),
      beneficiary_total_fen: 71_200n,
      platform_retained_fen: 30_300n,
      error_count: 1,
      held_count: 2,
      created_at: started,
      ...rest,
      platform_order_counts: jsonb(platform_order_counts),
      platform_settle_commission_totals: jsonb(platform_settle_commission_totals),
    })
    .execute();
  const row = await f.db
    .selectFrom('settle_bills')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('bill_id', '=', billId)
    .executeTakeFirst();
  expect(row, `settle_bills ${billId}`).toBeDefined();
  return row!;
}

const confirmers = new Map<string, Promise<string>>();

/** The admin_users row of the app that confirmed its batches (settle_batches.confirmed_by). */
export function confirmer(f: Fixture): Promise<string> {
  let id = confirmers.get(f.appId);
  if (id === undefined) {
    id = (async () => {
      const adminId = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id: adminId,
          app_id: f.appId,
          login_name: `finance_${adminId}`,
          password_hash: 'unused-test-login',
          is_super: false,
          status: 'active',
          password_must_change: false,
          totp_bound_at: f.clock.now(),
          created_at: f.clock.now(),
          updated_at: f.clock.now(),
        })
        .execute();
      return adminId;
    })();
    confirmers.set(f.appId, id);
  }
  return id;
}

export type BatchSeed = Partial<Omit<Insertable<DB['settle_batches']>, 'app_id' | 'bill_id'>>;

const CONFIRMED_STATES: ReadonlySet<string> = new Set([
  'CONFIRMED',
  'EXECUTING',
  'PARTIAL',
  'DONE',
]);
const STARTED_STATES: ReadonlySet<string> = new Set(['EXECUTING', 'PARTIAL', 'DONE']);

/**
 * One settle_batches row of `bill` (the fixture's app), consistent with the table's checks: a
 * confirmed state gets the app's confirmer and confirmed_at, SCHEDULED a scheduled_at a day after
 * the clock, CANCELLED its reason, started states started_at, PARTIAL / DONE finished_at; created_at
 * is the bill's generated_at (the bill-day task) unless the seed says otherwise.
 */
export async function seedBatch(
  f: Fixture,
  bill: BillRow,
  seed: BatchSeed = {},
): Promise<BatchRow> {
  expect(bill.app_id, 'seedBatch: the bill of the fixture app').toBe(f.appId);
  const status = seed.status ?? 'DRAFT';
  const mode = seed.settle_mode ?? 'IMMEDIATE';
  const confirmed = CONFIRMED_STATES.has(status);
  const by = confirmed ? await confirmer(f) : null;
  return f.db
    .insertInto('settle_batches')
    .values({
      batch_id: randomUUID(),
      app_id: f.appId,
      bill_id: bill.bill_id,
      platform: 'taobao',
      kind: 'main',
      status,
      settle_mode: mode,
      scheduled_at: mode === 'SCHEDULED' ? later(f, 24 * 60) : null,
      confirmed_by: by,
      confirmed_at: confirmed ? ago(f, 30) : null,
      cancelled_reason: status === 'CANCELLED' ? '合成驳回原因' : null,
      settle_run_id: null,
      order_count: 1,
      started_at: STARTED_STATES.has(status) ? ago(f, 20) : null,
      finished_at: status === 'PARTIAL' || status === 'DONE' ? ago(f, 10) : null,
      paused_by_switch_at: null,
      created_at: bill.generated_at ?? bill.generation_started_at,
      ...seed,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** The batch as a rejection leaves it (status and cancelled_reason are couli_app's columns). */
export async function reject(f: Fixture, batch: BatchRow): Promise<BatchRow> {
  return f.db
    .updateTable('settle_batches')
    .set({ status: 'CANCELLED', cancelled_reason: '合成驳回原因' })
    .where('app_id', '=', f.appId)
    .where('batch_id', '=', batch.batch_id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** The batch as a finished execution leaves it. */
export async function finish(f: Fixture, batch: BatchRow): Promise<BatchRow> {
  return f.db
    .updateTable('settle_batches')
    .set({ status: 'DONE', started_at: ago(f, 2), finished_at: ago(f, 1) })
    .where('app_id', '=', f.appId)
    .where('batch_id', '=', batch.batch_id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** A fresh order key of the app (settle_batch_items.order_id refers to order_keys). */
async function seedOrderKey(f: Fixture, platform: string): Promise<string> {
  const orderId = randomUUID();
  await f.db
    .insertInto('order_keys')
    .values({
      app_id: f.appId,
      order_id: orderId,
      platform,
      sub_order_id: `synthetic-${orderId}`,
      attr_at: ago(f, 60 * 24 * 40),
    })
    .execute();
  return orderId;
}

export type ItemResult = 'credited' | 'skipped' | 'deferred' | null;

/** The seeded skip_reason, or a synthetic one for a skipped item. */
function skipReason(seed: { readonly skip_reason?: string | null }, result: ItemResult) {
  if (seed.skip_reason !== undefined) return seed.skip_reason;
  return result === 'skipped' ? 'seq_changed' : null;
}

export interface OrderItemSeed {
  readonly id?: string;
  readonly settle_seq?: number;
  readonly b_settle_fen?: bigint;
  readonly result?: ItemResult;
  readonly skip_reason?: string | null;
  readonly created_at?: Date;
}

/** One order row (item_type order) of `batch`, on a fresh order key; skipped gets a reason. */
export async function seedOrderItem(
  f: Fixture,
  batch: BatchRow,
  seed: OrderItemSeed = {},
): Promise<ItemRow> {
  const orderId = await seedOrderKey(f, batch.platform);
  const result = seed.result ?? null;
  return f.db
    .insertInto('settle_batch_items')
    .values({
      id: seed.id ?? randomUUID(),
      app_id: f.appId,
      batch_id: batch.batch_id,
      item_type: 'order',
      order_id: orderId,
      user_id: null,
      role: null,
      beneficiary_credit_id: null,
      settle_seq: seed.settle_seq ?? 1,
      b_settle_fen: seed.b_settle_fen ?? 720n,
      amount_fen: null,
      result,
      skip_reason: skipReason(seed, result),
      created_at: seed.created_at ?? batch.created_at,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface Member {
  readonly userId: string;
  /** The full number (synthetic); never in a response. */
  readonly phone: string;
  /** 3 + 4 (BR-ID-33); not in an item either (items carry the user_id only). */
  readonly phoneMasked: string;
}

let phoneSerial = 0;

/** A user of the fixture's app with its phone encrypted as identity stores it. */
export async function seedMember(f: Fixture, crypto: FieldCrypto): Promise<Member> {
  phoneSerial += 1;
  const phone = `137${String(phoneSerial).padStart(8, '0')}`;
  const userId = randomUUID();
  const now = f.clock.now();
  await f.db
    .insertInto('users')
    .values({
      id: userId,
      app_id: f.appId,
      nickname: 'synthetic member',
      avatar: '',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'member',
      register_method: 'synthetic',
      phone_cipher: Buffer.from(crypto.encrypt(phone, PHONE_CIPHER_CONTEXT), 'utf8'),
      phone_hmac: crypto.blindIndex(phone, PHONE_BLIND_INDEX_CONTEXT),
      created_at: now,
      updated_at: now,
    })
    .execute();
  return { userId, phone, phoneMasked: `${phone.slice(0, 3)}****${phone.slice(7)}` };
}

export interface BeneficiaryItemSeed extends OrderItemSeed {
  readonly role?: 'self' | 'share' | 'direct' | 'indirect';
  /** B_settle when recorded (default null on a beneficiary item). */
  readonly b_settle_fen?: bigint;
  /** The amount recomputed at execution (default null: before execution). */
  readonly amount_fen?: bigint | null;
}

/**
 * One beneficiary make-up item of `batch` for `member`, on a fresh order key and a fresh open
 * obligation (beneficiary_credits, first_credit by R5) the item refers to.
 */
export async function seedBeneficiaryItem(
  f: Fixture,
  batch: BatchRow,
  member: Member,
  seed: BeneficiaryItemSeed = {},
): Promise<ItemRow> {
  const orderId = await seedOrderKey(f, batch.platform);
  const role = seed.role ?? 'direct';
  const creditId = randomUUID();
  await f.db
    .insertInto('beneficiary_credits')
    .values({
      beneficiary_credit_id: creditId,
      app_id: f.appId,
      order_id: orderId,
      user_id: member.userId,
      role,
      kind: 'first_credit',
      opened_by: 'R5',
      opened_ref: `synthetic-batch-item-${orderId}`,
      origin_ledger_type: null,
      origin_sub_type: null,
      split_ref: 'commission_version:1',
      status: 'open',
      opened_at: ago(f, 60 * 24),
    })
    .execute();
  const result = seed.result ?? null;
  return f.db
    .insertInto('settle_batch_items')
    .values({
      id: seed.id ?? randomUUID(),
      app_id: f.appId,
      batch_id: batch.batch_id,
      item_type: 'beneficiary',
      order_id: orderId,
      user_id: member.userId,
      role,
      beneficiary_credit_id: creditId,
      settle_seq: seed.settle_seq ?? 1,
      b_settle_fen: seed.b_settle_fen ?? null,
      amount_fen: seed.amount_fen ?? null,
      result,
      skip_reason: skipReason(seed, result),
      created_at: seed.created_at ?? batch.created_at,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Everything of the app the reads could touch (reads must leave it as it was). */
export async function footprint(f: Fixture) {
  return {
    bills: await f.db
      .selectFrom('settle_bills')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('bill_id')
      .execute(),
    batches: await f.db
      .selectFrom('settle_batches')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('batch_id')
      .execute(),
    items: await f.db
      .selectFrom('settle_batch_items')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  };
}

/** Every audit record of the app (reading writes none). */
export function allAudits(f: Fixture) {
  return f.db
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
}

// ---------------------------------------------------------------------------------------------
// Expected shapes (instants as epoch milliseconds).

/** The required keys of the contract's AdminSettleBill (additionalProperties false). */
export const BILL_KEYS = [
  'batch_count',
  'beneficiary_total_fen',
  'bill_id',
  'created_at',
  'draft_batch_count',
  'error_count',
  'generated_at',
  'generation_started_at',
  'held_count',
  'platform_order_counts',
  'platform_retained_fen',
  'platform_settle_commission_totals',
  'status',
] as const;

/** The required keys of the contract's AdminSettleBillDetail. */
export const DETAIL_KEYS = [...BILL_KEYS, 'batches'].sort();

/** The required keys of the contract's AdminSettleBatch. */
export const BATCH_KEYS = [
  'batch_id',
  'cancelled_reason',
  'confirmed_at',
  'confirmed_by',
  'created_at',
  'finished_at',
  'in_current_round',
  'item_counts',
  'kind',
  'order_count',
  'paused_by_switch_at',
  'platform',
  'row_version',
  'scheduled_at',
  'settle_mode',
  'started_at',
  'status',
] as const;

/** The required keys of the contract's AdminSettleBatchItem. */
export const ITEM_KEYS = [
  'amount_fen',
  'b_settle_fen',
  'beneficiary_credit_id',
  'created_at',
  'id',
  'item_type',
  'order_id',
  'result',
  'role',
  'settle_seq',
  'skip_reason',
  'user_id',
] as const;

function ms(at: Date | null): number | null {
  return at === null ? null : at.getTime();
}

function fen(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * The AdminSettleBill a stored row must be shown as: the columns as stored (bill-day totals are
 * never recomputed), the derived `status` the test expects, and the batch summary of `batches`
 * (every batch of the bill, CANCELLED included).
 */
export function billView(
  row: BillRow,
  status: string,
  batches: readonly BatchRow[],
): Record<string, unknown> {
  return {
    bill_id: row.bill_id,
    status,
    generation_started_at: row.generation_started_at.getTime(),
    generated_at: ms(row.generated_at),
    platform_order_counts: row.platform_order_counts,
    platform_settle_commission_totals: row.platform_settle_commission_totals,
    beneficiary_total_fen: fen(row.beneficiary_total_fen),
    platform_retained_fen: fen(row.platform_retained_fen),
    error_count: row.error_count,
    held_count: row.held_count,
    batch_count: batches.length,
    draft_batch_count: batches.filter((b) => b.status === 'DRAFT').length,
    created_at: row.created_at.getTime(),
  };
}

export interface ItemCounts {
  readonly order: { readonly credited: number; readonly skipped: number; readonly pending: number };
  readonly beneficiary: {
    readonly credited: number;
    readonly skipped: number;
    readonly deferred: number;
    readonly pending: number;
  };
}

/** An AdminSettleBatchItemCounts with the given cells, every other cell 0. */
export function counts(
  cells: {
    readonly order?: Partial<ItemCounts['order']>;
    readonly beneficiary?: Partial<ItemCounts['beneficiary']>;
  } = {},
): ItemCounts {
  return {
    order: { credited: 0, skipped: 0, pending: 0, ...cells.order },
    beneficiary: { credited: 0, skipped: 0, deferred: 0, pending: 0, ...cells.beneficiary },
  };
}

/** The AdminSettleBatch a stored row must be shown as. */
export function batchView(
  row: BatchRow,
  inCurrentRound: boolean,
  itemCounts: ItemCounts = counts(),
): Record<string, unknown> {
  return {
    batch_id: row.batch_id,
    platform: row.platform,
    kind: row.kind,
    status: row.status,
    settle_mode: row.settle_mode,
    scheduled_at: ms(row.scheduled_at),
    confirmed_by: row.confirmed_by,
    confirmed_at: ms(row.confirmed_at),
    cancelled_reason: row.cancelled_reason,
    order_count: row.order_count,
    started_at: ms(row.started_at),
    finished_at: ms(row.finished_at),
    paused_by_switch_at: ms(row.paused_by_switch_at),
    row_version: row.row_version,
    created_at: row.created_at.getTime(),
    in_current_round: inCurrentRound,
    item_counts: itemCounts,
  };
}

/** Batches as the detail lists them: created_at, then batch_id, ascending. */
export function inDetailOrder(batches: readonly BatchRow[]): BatchRow[] {
  return [...batches].sort((a, b) => {
    const at = a.created_at.getTime() - b.created_at.getTime();
    if (at !== 0) return at;
    return a.batch_id < b.batch_id ? -1 : a.batch_id > b.batch_id ? 1 : 0;
  });
}

/** The AdminSettleBatchItem a stored row must be shown as. */
export function itemView(row: ItemRow): Record<string, unknown> {
  return {
    id: row.id,
    item_type: row.item_type,
    order_id: row.order_id,
    user_id: row.user_id,
    role: row.role,
    beneficiary_credit_id: row.beneficiary_credit_id,
    settle_seq: row.settle_seq,
    b_settle_fen: fen(row.b_settle_fen),
    amount_fen: fen(row.amount_fen),
    result: row.result,
    skip_reason: row.skip_reason,
    created_at: row.created_at.getTime(),
  };
}

/** Items in check order: settle_seq, then id, ascending. */
export function inCheckOrder(items: readonly ItemRow[]): ItemRow[] {
  return [...items].sort((a, b) => {
    if (a.settle_seq !== b.settle_seq) return a.settle_seq - b.settle_seq;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

const INSTANT_KEYS: ReadonlySet<string> = new Set([
  'generation_started_at',
  'generated_at',
  'created_at',
  'scheduled_at',
  'confirmed_at',
  'started_at',
  'finished_at',
  'paused_by_switch_at',
]);

/** A response value with every date-time string (at any depth) turned into epoch milliseconds. */
export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] =
      INSTANT_KEYS.has(key) && typeof inner === 'string' ? Date.parse(inner) : normalize(inner);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export type Operation = 'list' | 'detail' | 'items';

export interface Envelope {
  code: number;
  msg: string;
  data?: unknown;
  trace_id: string;
}

export interface AdminSent {
  readonly op: Operation;
  readonly statusCode: number;
  readonly body: string;
  json(): Envelope;
}

export interface AdminCaller {
  readonly id: string;
  readonly token: string;
}

export interface SettleAdmin {
  /** The entry's field cipher (to store a member's phone as identity does). */
  readonly crypto: FieldCrypto;
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** GET /admin/v1/settle-bills with the query, as `biller` unless given (null: no token). */
  list(query?: Record<string, string>, caller?: AdminCaller | null): Promise<AdminSent>;
  /** GET /admin/v1/settle-bills/{bill_id}, as `biller` unless given (null: no token). */
  detail(billId: string, caller?: AdminCaller | null): Promise<AdminSent>;
  /** GET /admin/v1/settle-batches/{batch_id}/items, as `biller` unless given (null: no token). */
  items(
    batchId: string,
    query?: Record<string, string>,
    caller?: AdminCaller | null,
  ): Promise<AdminSent>;
  /** An account with settle.bill only (no step-up session). */
  readonly biller: AdminCaller;
  /** An account with fund.view only. */
  readonly viewer: AdminCaller;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** Runs `run` against a started admin entry on the fixture's database, clock and Redis. */
export async function withSettleAdmin(f: Fixture, run: (h: SettleAdmin) => Promise<void>) {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as {
    createHttpApp(
      entry: 'admin',
      options: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: RootLogger;
        dbHandles: DbHandles;
        redisUrl: ReturnType<typeof loadConnectionConfig>['redisUrl'];
      },
    ): Promise<HttpApp>;
  };
  const base = fileURLToPath(new URL('.tmp/', ROOT));
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'b2-09d-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  let app: HttpApp | undefined;
  try {
    app = await createHttpApp('admin', {
      config: loadConfig({
        APP_ENV: 'test',
        FIELD_KEY_PROVIDER: 'local',
        FIELD_MASTER_KEY_FILE: join(dir, 'master.hex'),
        FIELD_KEYRING_FILE: join(dir, 'keyring.json'),
        ADMIN_TOKEN_SIGNING_KEY: tokenKey.toString('base64url'),
        ADMIN_IP_ALLOWLIST: '127.0.0.1,::1',
        ADMIN_CORS_ORIGIN: 'https://admin.example.invalid',
        JWT_KEY_ID: 'b2_09d_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'silent' },
        { write: () => undefined },
      ),
      dbHandles: { db: f.db, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await app.init();
    const server = app;
    const redis = server.get<RedisHandle>(REDIS);
    const crypto = server.get<FieldCrypto>(FIELD_CRYPTO);
    const caller: SettleAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `sbill_${id}`,
          password_hash: 'unused-test-login',
          is_super: options.superAdmin === true,
          status: 'active',
          password_must_change: false,
          totp_bound_at: f.clock.now(),
          created_at: f.clock.now(),
          updated_at: f.clock.now(),
        })
        .execute();
      if (permissions.length > 0) {
        await f.db
          .insertInto('admin_permissions')
          .values(
            permissions.map((permission_key) => ({
              app_id: f.appId,
              admin_id: id,
              permission_key,
              granted_by: id,
              granted_at: f.clock.now(),
            })),
          )
          .execute();
      }
      const { token, claims } = await createAdminTokens({ key: tokenKey, clock: f.clock }).issue({
        adminId: id,
        appId: f.appId,
      });
      await createAdminSessions({ redis: redis.namespace('admin-auth'), clock: f.clock }).create(
        claims.sessionId,
        {
          adminId: id,
          appId: f.appId,
          expiresAtMs: claims.expiresAt * 1000,
          lastSeenMs: f.clock.now().getTime(),
        },
      );
      return { id, token };
    };
    const biller = await caller([BILL]);
    const viewer = await caller([VIEW]);
    const send = async (
      op: Operation,
      url: string,
      who: AdminCaller | null | undefined,
    ): Promise<AdminSent> => {
      const actor = who === undefined ? biller : who;
      const headers: Record<string, string> = { 'x-trace-id': randomUUID() };
      if (actor !== null) headers['authorization'] = `Bearer ${actor.token}`;
      const response = await server.inject({
        method: 'GET',
        url,
        headers,
        remoteAddress: '127.0.0.1',
      });
      return {
        op,
        statusCode: response.statusCode,
        body: response.body,
        json: () => JSON.parse(response.body) as Envelope,
      };
    };
    const withQuery = (path: string, query: Record<string, string> | undefined) => {
      const text = new URLSearchParams(query ?? {}).toString();
      return text === '' ? path : `${path}?${text}`;
    };
    await run({
      crypto,
      caller,
      biller,
      viewer,
      list(query, who) {
        return send('list', withQuery(LIST_PATH, query), who);
      },
      detail(billId, who) {
        return send('detail', `${LIST_PATH}/${encodeURIComponent(billId)}`, who);
      },
      items(batchId, query, who) {
        const path = `/admin/v1/settle-batches/${encodeURIComponent(batchId)}/items`;
        return send('items', withQuery(path, query), who);
      },
    });
  } finally {
    try {
      await app?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The contract.

export interface ContractOperation {
  readonly operationId?: string;
  readonly 'x-implementation'?: string;
  readonly 'x-auth'?: string;
  readonly 'x-error-codes'?: readonly number[];
  readonly responses: Record<
    string,
    { readonly content?: Record<string, { readonly schema: JsonSchema }> }
  >;
}
type ContractPaths = Record<string, Record<string, ContractOperation>>;
let contractPromise: Promise<ContractPaths> | undefined;

/** The dereferenced paths of contracts/openapi.yaml. */
export function contractPaths(): Promise<ContractPaths> {
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<{ paths: ContractPaths }>;
  };
  contractPromise ??= parser
    .dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    })
    .then((document) => document.paths);
  return contractPromise;
}

const PATHS: Record<Operation, string> = {
  list: LIST_PATH,
  detail: DETAIL_PATH,
  items: ITEMS_PATH,
};

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10403: 403,
  20001: 400,
};

/** The response body conforms to its operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const path = PATHS[sent.op];
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[path]?.['get']?.responses[status]?.content?.[
    'application/json'
  ]?.schema;
  expect(schema, `${path} ${status}`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(sent.body) as unknown;
  } catch {
    parsed = sent.body;
  }
  expect(check(parsed), `${sent.body} ${JSON.stringify(check.errors)}`).toBe(true);
}

/** Status, code and (when given) exact data, then the contract schema. */
export async function answer(sent: AdminSent, code: number, data?: unknown): Promise<Envelope> {
  expect(sent.statusCode, sent.body).toBe(HTTP_STATUS[code]);
  const body = sent.json();
  expect(body.code, sent.body).toBe(code);
  if (data !== undefined) expect(body.data, sent.body).toEqual(data);
  await conforms(sent);
  return body;
}

export interface Page {
  readonly items: Record<string, unknown>[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

/** The page of a successful list response. */
export async function page(sent: AdminSent): Promise<Page> {
  const body = await answer(sent, 0);
  const data = body.data;
  expect(typeof data === 'object' && data !== null, sent.body).toBe(true);
  expect(Array.isArray((data as Record<string, unknown>)['items']), sent.body).toBe(true);
  return data as Page;
}

/** The bill_id of each row of a successful bill list response, in order. */
export async function billIds(sent: AdminSent): Promise<unknown[]> {
  return (await page(sent)).items.map((item) => item['bill_id']);
}

/** The id of each row of a successful batch item list response, in order. */
export async function itemIds(sent: AdminSent): Promise<unknown[]> {
  return (await page(sent)).items.map((item) => item['id']);
}

/** The data of a successful detail response, its instants as epoch milliseconds. */
export async function detailOf(sent: AdminSent): Promise<Record<string, unknown>> {
  const data = normalize((await answer(sent, 0)).data);
  expect(typeof data === 'object' && data !== null, sent.body).toBe(true);
  return data as Record<string, unknown>;
}

/** The bill_id → status of a successful bill list response. */
export async function statuses(sent: AdminSent): Promise<Record<string, unknown>> {
  const rows = (await page(sent)).items;
  return Object.fromEntries(rows.map((row) => [String(row['bill_id']), row['status']]));
}

/** batch_id → in_current_round of a detail. */
export function rounds(detail: Record<string, unknown>): Record<string, unknown> {
  const batches = detail['batches'];
  expect(Array.isArray(batches), JSON.stringify(detail)).toBe(true);
  const rows = batches as Record<string, unknown>[];
  return Object.fromEntries(rows.map((b) => [String(b['batch_id']), b['in_current_round']]));
}
