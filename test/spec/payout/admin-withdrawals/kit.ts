// B2-09c rule-test kit (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// listAdminWithdrawals (GET /admin/v1/withdrawals) and getAdminWithdrawal
// (GET /admin/v1/withdrawals/{withdrawal_id}) — withdraw.review or fund.view, read only, no step-up;
// only withdrawals of the caller's app; display_status derived from status + review_mode +
// hold_reason (BR-WDR-08 细则); the payee only masked (BR-ID-33); the batch, its items, the transfer
// attempts as a summary, the user's holds in effect at the clock; reading writes no audit record.
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// contract validation, the field cipher of the process), PostgreSQL through @couli/db/testing
// (couli_app; payout_attempts as couli_payout, its only writer), Redis for the admin sessions.
// Synthetic: users, withdrawals, payout_batches, payout_batch_items, payout_attempts and
// withdraw_holds rows written directly as the payout process would have left them (states outside
// this task are not produced by a fake command), the admin accounts, every phone number, payee name
// and account. Missing pieces fail as assertions (an unregistered admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Insertable, type Kysely, type RawBuilder, type Selectable } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';
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
import { blocklistHmacContexts } from '../../../../apps/api/src/modules/risk/application/blocklist.ts';

export const NOW = '2026-10-30T02:00:00.000Z';
export const MINUTE = 60_000;
export const LIST_PATH = '/admin/v1/withdrawals';
export const DETAIL_PATH = '/admin/v1/withdrawals/{withdrawal_id}';
/** specs/permissions.yaml: the two read points of CT-24y (any one is enough). */
export const REVIEW = 'withdraw.review';
export const VIEW = 'fund.view';

const ROOT = new URL('../../../../', import.meta.url);
const requireApi = createRequire(new URL('apps/api/package.json', ROOT));

// ---------------------------------------------------------------------------------------------
// Database and Redis of one test file. The testing helpers are imported at run time (computed
// URL), like payment/orders/kit.ts: this kit must not depend on @couli/db/testing statically.

interface TestDatabase {
  urlFor(role: string): string;
  drop(): Promise<void>;
}
interface TestRedis {
  url: string;
  stop(): Promise<void>;
}
interface Testing {
  createTestDatabase(): Promise<TestDatabase>;
  acquireTestRedis(): Promise<TestRedis>;
}
async function testing(): Promise<Testing> {
  return (await import(
    new URL('../../../../packages/db/src/testing/index.ts', import.meta.url).href
  )) as Testing;
}

export function suite() {
  let database: TestDatabase | undefined;
  let server: TestRedis | undefined;
  let db: Kysely<DB> | undefined;
  let payout: Kysely<DB> | undefined;
  beforeAll(async () => {
    const helpers = await testing();
    database = await helpers.createTestDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
    payout = createDb({ connectionString: database.urlFor('couli_payout'), max: 2 });
    server = await helpers.acquireTestRedis();
  }, 180_000);
  afterAll(async () => {
    try {
      if (payout) await destroyDb(payout);
    } finally {
      try {
        if (db) await destroyDb(db);
      } finally {
        try {
          await database?.drop();
        } finally {
          await server?.stop();
        }
      }
    }
  }, 30_000);
  return {
    /** couli_app: the business role of the admin entry. */
    db(): Kysely<DB> {
      expect(db, 'test database').toBeDefined();
      return db!;
    },
    /** couli_payout: the only role that may insert payout_attempts (seeding only). */
    payout(): Kysely<DB> {
      expect(payout, 'test database').toBeDefined();
      return payout!;
    },
    redisUrl(): string {
      expect(server, 'test redis').toBeDefined();
      return server!.url;
    },
  };
}
export type Suite = ReturnType<typeof suite>;

// ---------------------------------------------------------------------------------------------
// One app on the suite's database.

export interface Fixture {
  readonly s: Suite;
  readonly db: Kysely<DB>;
  readonly payout: Kysely<DB>;
  readonly clock: FixedClock;
  readonly appId: string;
}

export function fixture(s: Suite, instant = NOW): Fixture {
  return {
    s,
    db: s.db(),
    payout: s.payout(),
    clock: new FixedClock(instant),
    appId: `wd_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
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

/** `at` as ISO 8601 with the +08:00 offset (04 §5), e.g. 2026-10-30T10:00:00.000+08:00. */
export function withOffset(at: Date): string {
  return new Date(at.getTime() + 8 * 60 * MINUTE).toISOString().replace('Z', '+08:00');
}

// ---------------------------------------------------------------------------------------------
// Rows. Every value below is synthetic.

export type Method = 'alipay' | 'bank_card' | 'wechat';
export type WithdrawalRow = Selectable<DB['withdrawals']>;
export type BatchRow = Selectable<DB['payout_batches']>;
export type ItemRow = Selectable<DB['payout_batch_items']>;
export type AttemptRow = Selectable<DB['payout_attempts']>;
export type HoldRow = Selectable<DB['withdraw_holds']>;

/** The default payee of the snapshot (a 3-character name: masked `**甲`, BR-ID-33). */
export const PAYEE_NAME = '合成甲';
export const MASKED_NAME = '**甲';
export const BANK_NAME = '合成测试银行';
/** Default accounts by method: alipay e-mail form, a 19-digit card, a WeChat openid. */
export const ACCOUNT: Readonly<Record<Method, string>> = {
  alipay: 'synthetic.payee@example.test',
  bank_card: '6222020200112233445',
  wechat: 'o_synthetic_openid_0001',
};

/** What gives the field cipher (the admin entry's FIELD_CRYPTO). */
export interface Sealer {
  readonly crypto: FieldCrypto;
}

/** Field-cipher context of withdrawals.payee_account_cipher by method (payout_accounts.*). */
function accountContext(method: Method): string {
  const contexts = blocklistHmacContexts();
  if (method === 'alipay') return contexts.alipay;
  if (method === 'bank_card') return contexts.bank_card;
  return contexts.wechat_openid;
}

export interface Member {
  readonly appId: string;
  readonly userId: string;
  /** The full number (synthetic); never in a response. */
  readonly phone: string | null;
  /** 3 + 4 (BR-ID-33), null without a phone. */
  readonly phoneMasked: string | null;
}

let phoneSerial = 0;

/** A fresh synthetic mobile number. */
export function nextPhone(): string {
  phoneSerial += 1;
  return `139${String(phoneSerial).padStart(8, '0')}`;
}

/** A user of the fixture's app with its phone encrypted as identity stores it (or none). */
export async function seedMember(
  f: Fixture,
  h: Sealer,
  phone: string | null = nextPhone(),
): Promise<Member> {
  const userId = randomUUID();
  const now = f.clock.now();
  const cipher = phone === null ? null : h.crypto.encrypt(phone, PHONE_CIPHER_CONTEXT);
  await f.db
    .withSchema('app')
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
      phone_cipher: cipher === null ? null : Buffer.from(cipher, 'utf8'),
      phone_hmac: phone === null ? null : h.crypto.blindIndex(phone, PHONE_BLIND_INDEX_CONTEXT),
      created_at: now,
      updated_at: now,
    })
    .execute();
  return {
    appId: f.appId,
    userId,
    phone,
    phoneMasked: phone === null ? null : `${phone.slice(0, 3)}****${phone.slice(7)}`,
  };
}

type JsonColumn = WithdrawalRow['auto_decision'];

function jsonb(value: unknown): RawBuilder<JsonColumn> | null {
  return value === null ? null : sql<JsonColumn>`${JSON.stringify(value)}::jsonb`;
}

export type WithdrawalSeed = Partial<
  Omit<
    Insertable<DB['withdrawals']>,
    | 'app_id'
    | 'user_id'
    | 'payout_method'
    | 'payout_channel'
    | 'payee_account_cipher'
    | 'payee_hmac'
    | 'auto_decision'
    | 'risk_flags'
    | 'resolver_ids'
  >
> & {
  /** payout_method = payout_channel (default alipay). */
  readonly method?: Method;
  /** The payee account in clear (default ACCOUNT[method]); stored encrypted only. */
  readonly account?: string;
  readonly auto_decision?: Record<string, unknown> | null;
  readonly risk_flags?: readonly Record<string, unknown>[] | null;
  readonly resolver_ids?: readonly string[] | null;
};

/**
 * One withdrawal of `member` written directly (its app), consistent with the table's checks:
 * REJECTED gets reject_reason_code OTHER, PAID_* a paid_at, PAID_MANUAL its two admins, a
 * hold_reason its hold_at, unless the seed says otherwise.
 */
export async function seedWithdrawal(
  f: Fixture,
  h: Sealer,
  member: Member,
  seed: WithdrawalSeed = {},
): Promise<WithdrawalRow> {
  const {
    method = 'alipay',
    account,
    auto_decision = null,
    risk_flags = null,
    resolver_ids = null,
    ...rest
  } = seed;
  const id = rest.id ?? randomUUID();
  const status = rest.status ?? 'PENDING_REVIEW';
  const amount = rest.amount_fen ?? 12_345n;
  const fee = rest.fee_fen ?? 0n;
  const tax = rest.tax_fen ?? 0n;
  const createdAt = rest.created_at ?? f.clock.now();
  const context = accountContext(method);
  const clear = account ?? ACCOUNT[method];
  await f.db
    .withSchema('app')
    .insertInto('withdrawals')
    .values({
      app_id: member.appId,
      user_id: member.userId,
      amount_fen: amount,
      fee_fen: fee,
      tax_fen: tax,
      net_fen: amount - fee - tax,
      income_type: 'SERVICE_FEE',
      payout_method: method,
      payout_channel: method,
      payee_name: PAYEE_NAME,
      payee_account_cipher: Buffer.from(h.crypto.encrypt(clear, context), 'utf8'),
      payee_hmac: h.crypto.blindIndex(clear, context),
      bank_name: method === 'bank_card' ? BANK_NAME : null,
      wechat_app_id: method === 'wechat' ? 'wx_synthetic_app' : null,
      status,
      out_biz_no: `W${randomBytes(12).toString('hex').toUpperCase()}`,
      reject_reason_code: status === 'REJECTED' ? 'OTHER' : null,
      paid_at: status === 'PAID_API' || status === 'PAID_MANUAL' ? createdAt : null,
      manual_entry_by: status === 'PAID_MANUAL' ? randomUUID() : null,
      manual_confirm_by: status === 'PAID_MANUAL' ? randomUUID() : null,
      hold_at: rest.hold_reason === undefined || rest.hold_reason === null ? null : createdAt,
      created_at: createdAt,
      updated_at: createdAt,
      ...rest,
      auto_decision: jsonb(auto_decision),
      risk_flags: jsonb(risk_flags),
      resolver_ids: jsonb(resolver_ids),
      id,
    })
    .execute();
  const row = await f.db
    .withSchema('app')
    .selectFrom('withdrawals')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  expect(row, `withdrawals ${id}`).toBeDefined();
  return row!;
}

/** A payout batch of the fixture's app (manual batches name their creator). */
export async function seedBatch(
  f: Fixture,
  seed: {
    readonly kind?: 'auto' | 'manual';
    readonly created_at?: Date;
    readonly by?: string;
  } = {},
): Promise<BatchRow> {
  const kind = seed.kind ?? 'auto';
  return f.db
    .withSchema('app')
    .insertInto('payout_batches')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      kind,
      created_by: kind === 'manual' ? (seed.by ?? randomUUID()) : null,
      created_at: seed.created_at ?? f.clock.now(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** One payout_batch_items row of `w` in `batch`. */
export async function seedItem(
  f: Fixture,
  w: WithdrawalRow,
  batch: BatchRow,
  seed: {
    readonly result: 'paying' | 'skipped' | 'blocked' | 'moved_out';
    readonly at: Date;
    readonly reason?: string;
    readonly movedTo?: BatchRow;
  },
): Promise<ItemRow> {
  return f.db
    .withSchema('app')
    .insertInto('payout_batch_items')
    .values({
      id: randomUUID(),
      app_id: w.app_id,
      batch_id: batch.id,
      withdrawal_id: w.id,
      result: seed.result,
      reason: seed.reason ?? null,
      moved_to_batch_id: seed.movedTo?.id ?? null,
      at: seed.at,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * One payout_attempts row of `w`, inserted as couli_payout the way the payout process records it.
 * `request` and `response` are the stored bodies; the response must never carry them.
 */
export async function seedAttempt(
  f: Fixture,
  w: WithdrawalRow,
  seed: {
    readonly kind: 'transfer' | 'query' | 'cancel';
    readonly result: 'pending' | 'success' | 'fail' | 'unknown';
    readonly at: Date;
    readonly respCode?: string | null;
    readonly respSubCode?: string | null;
    readonly request?: Record<string, unknown>;
    readonly response?: Record<string, unknown> | null;
  },
): Promise<AttemptRow> {
  const id = randomUUID();
  const request = seed.request ?? { out_biz_no: w.out_biz_no };
  const response = seed.response ?? null;
  await sql`INSERT INTO app.payout_attempts
    (id, app_id, withdrawal_id, kind, request, response, resp_code, resp_sub_code, result,
     latency_ms, at)
    VALUES (${id}, ${w.app_id}, ${w.id}, ${seed.kind}, ${JSON.stringify(request)}::jsonb,
      ${response === null ? null : JSON.stringify(response)}::jsonb, ${seed.respCode ?? null},
      ${seed.respSubCode ?? null}, ${seed.result}, ${seed.result === 'pending' ? null : 12},
      ${seed.at})`.execute(f.payout);
  const row = await f.db
    .withSchema('app')
    .selectFrom('payout_attempts')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  expect(row, `payout_attempts ${id}`).toBeDefined();
  return row!;
}

/** One withdraw_holds row of `member` (its app); released holds name a releaser. */
export async function seedHold(
  f: Fixture,
  member: Member,
  seed: {
    readonly reason?: 'manual' | 'recon_diff' | 'ledger_mismatch' | 'manual_failed_watch';
    readonly sourceRef?: string | null;
    readonly created_at?: Date;
    readonly hold_until?: Date | null;
    readonly released_at?: Date | null;
  } = {},
): Promise<HoldRow> {
  const released = seed.released_at ?? null;
  return f.db
    .withSchema('app')
    .insertInto('withdraw_holds')
    .values({
      id: randomUUID(),
      app_id: member.appId,
      user_id: member.userId,
      reason: seed.reason ?? 'manual',
      source_ref: seed.sourceRef ?? null,
      created_by: 'system',
      created_at: seed.created_at ?? f.clock.now(),
      hold_until: seed.hold_until ?? null,
      released_at: released,
      released_by: released === null ? null : 'system',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Everything of the app a read could have touched (reads must leave it as it was). */
export async function footprint(f: Fixture) {
  const app = f.db.withSchema('app');
  return {
    withdrawals: await app
      .selectFrom('withdrawals')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    batches: await app
      .selectFrom('payout_batches')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    items: await app
      .selectFrom('payout_batch_items')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    attempts: await app
      .selectFrom('payout_attempts')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    holds: await app
      .selectFrom('withdraw_holds')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  };
}

/** Every audit record of the app (reading writes none). */
export function allAudits(f: Fixture) {
  return f.db
    .withSchema('app')
    .selectFrom('audit_logs')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('id')
    .execute();
}

// ---------------------------------------------------------------------------------------------
// Expected shapes (instants as epoch milliseconds).

/** The required keys of the contract's AdminWithdrawalListItem (additionalProperties false). */
export const LIST_KEYS = [
  'amount_fen',
  'auto_decision',
  'batch_id',
  'blocked_reason',
  'created_at',
  'display_status',
  'fee_fen',
  'hold_reason',
  'needs_manual',
  'net_fen',
  'out_biz_no',
  'paid_at',
  'payout_channel',
  'reject_note',
  'reject_reason_code',
  'review_mode',
  'reviewed_at',
  'reviewer_id',
  'risk_flags',
  'risk_flags_at',
  'status',
  'tax_fen',
  'user',
  'withdrawal_id',
] as const;

/** The required keys of the contract's AdminWithdrawalDetail (additionalProperties false). */
export const DETAIL_KEYS = [
  ...LIST_KEYS,
  'batch',
  'batch_items',
  'channel_order_id',
  'channel_state',
  'confirm_deadline',
  'executed_at',
  'execute_seq',
  'executor_id',
  'fail_code',
  'hold_at',
  'holds',
  'manual_confirm_by',
  'manual_entry_by',
  'manual_resolution',
  'payee',
  'payout_attempts',
  'payout_method',
  'resolver_ids',
  'review_deadline',
  'row_version',
  'updated_at',
].sort();

/** The BR-WDR-08 细则 display status of a row (the console's mapping; test-side oracle). */
export function displayOf(row: Pick<WithdrawalRow, 'status' | 'review_mode' | 'hold_reason'>) {
  switch (row.status) {
    case 'PENDING_REVIEW':
      return 'pending_review';
    case 'APPROVED':
      return row.hold_reason === 'payer_side_after_transfer' ? 'pending_handle' : 'pending_review';
    case 'REJECTED':
      return 'rejected';
    case 'PAID_MANUAL':
      return 'paid_manual';
    case 'PAID_API':
      return row.review_mode === 'auto' ? 'paid_auto_system' : 'paid_auto_review';
    case 'PAYING':
      return 'paying';
    case 'FAILED':
      return 'failed';
    default:
      throw new Error(`kit: unknown withdrawal status ${row.status}`);
  }
}

function ms(at: Date | null): number | null {
  return at === null ? null : at.getTime();
}

/** withdrawals.auto_decision as the contract shows it: a key missing in storage reads as null. */
function decisionView(stored: WithdrawalRow['auto_decision']): unknown {
  if (stored === null) return null;
  const decision = stored as Record<string, unknown>;
  const decidedAt = decision['decided_at'];
  return {
    result: decision['result'],
    failed_conditions: decision['failed_conditions'],
    warn_values: decision['warn_values'] ?? null,
    rule_version: decision['rule_version'] ?? null,
    decided_at: typeof decidedAt === 'string' ? Date.parse(decidedAt) : null,
    execute_blocked: decision['execute_blocked'] ?? null,
  };
}

/** The AdminWithdrawalListItem a row of `member` must be shown as. */
export function listView(row: WithdrawalRow, member: Member): Record<string, unknown> {
  return {
    withdrawal_id: row.id,
    out_biz_no: row.out_biz_no,
    user: { user_id: row.user_id, phone_masked: member.phoneMasked },
    status: row.status,
    display_status: displayOf(row),
    review_mode: row.review_mode,
    payout_channel: row.payout_channel,
    amount_fen: Number(row.amount_fen),
    fee_fen: Number(row.fee_fen),
    tax_fen: Number(row.tax_fen),
    net_fen: Number(row.net_fen),
    auto_decision: decisionView(row.auto_decision),
    hold_reason: row.hold_reason,
    blocked_reason: row.blocked_reason,
    needs_manual: row.needs_manual,
    reject_reason_code: row.reject_reason_code,
    reject_note: row.reject_note,
    reviewer_id: row.reviewer_id,
    reviewed_at: ms(row.reviewed_at),
    batch_id: row.batch_id,
    risk_flags: row.risk_flags ?? [],
    risk_flags_at: ms(row.risk_flags_at),
    created_at: row.created_at.getTime(),
    paid_at: ms(row.paid_at),
  };
}

export interface Payee {
  readonly masked_account: string;
  readonly masked_name: string;
  readonly bank_name: string | null;
}

/** The parts of the detail beyond the row, in the order the response must list them. */
export interface DetailParts {
  readonly payee: Payee;
  readonly batch: BatchRow | null;
  readonly items: readonly ItemRow[];
  readonly attempts: readonly AttemptRow[];
  readonly holds: readonly HoldRow[];
}

export function batchView(row: BatchRow): Record<string, unknown> {
  return { batch_id: row.id, kind: row.kind, created_at: row.created_at.getTime() };
}

export function itemView(row: ItemRow): Record<string, unknown> {
  return {
    batch_id: row.batch_id,
    result: row.result,
    reason: row.reason,
    moved_to_batch_id: row.moved_to_batch_id,
    at: row.at.getTime(),
  };
}

export function attemptView(row: AttemptRow): Record<string, unknown> {
  return {
    attempt_id: row.id,
    kind: row.kind,
    result: row.result,
    resp_code: row.resp_code,
    resp_sub_code: row.resp_sub_code,
    at: row.at.getTime(),
  };
}

export function holdView(row: HoldRow): Record<string, unknown> {
  return {
    hold_id: row.id,
    reason: row.reason,
    source_ref: row.source_ref,
    created_at: row.created_at.getTime(),
    hold_until: ms(row.hold_until),
  };
}

/** The AdminWithdrawalDetail a row of `member` must be shown as. */
export function detailView(
  row: WithdrawalRow,
  member: Member,
  parts: DetailParts,
): Record<string, unknown> {
  return {
    ...listView(row, member),
    payout_method: row.payout_method,
    review_deadline: ms(row.review_deadline),
    fail_code: row.fail_code,
    executor_id: row.executor_id,
    executed_at: ms(row.executed_at),
    execute_seq: row.execute_seq,
    manual_resolution: row.manual_resolution,
    resolver_ids: row.resolver_ids ?? [],
    manual_entry_by: row.manual_entry_by,
    manual_confirm_by: row.manual_confirm_by,
    hold_at: ms(row.hold_at),
    channel_state: row.channel_state,
    confirm_deadline: ms(row.confirm_deadline),
    channel_order_id: row.channel_order_id,
    updated_at: row.updated_at.getTime(),
    row_version: row.row_version,
    payee: parts.payee,
    batch: parts.batch === null ? null : batchView(parts.batch),
    batch_items: parts.items.map(itemView),
    payout_attempts: parts.attempts.map(attemptView),
    holds: parts.holds.map(holdView),
  };
}

const INSTANT_KEYS: ReadonlySet<string> = new Set([
  'created_at',
  'reviewed_at',
  'paid_at',
  'risk_flags_at',
  'review_deadline',
  'executed_at',
  'hold_at',
  'confirm_deadline',
  'updated_at',
  'decided_at',
  'at',
  'hold_until',
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

/** Rows newest first: created_at descending, then id descending (uuid order = hex text order). */
export function newestFirst<T extends { readonly id: string; readonly created_at: Date }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    const at = b.created_at.getTime() - a.created_at.getTime();
    if (at !== 0) return at;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/** The clear values of a withdrawal no response may carry: payee name and account, cipher, HMAC. */
export function secretsOf(row: WithdrawalRow, account: string, member: Member): string[] {
  const secrets = [
    row.payee_name,
    account,
    row.payee_hmac,
    Buffer.from(row.payee_account_cipher).toString('utf8'),
  ];
  if (member.phone !== null) secrets.push(member.phone);
  return secrets;
}

/** None of `secrets` appears anywhere in the response body. */
export function expectNoSecrets(body: string, secrets: readonly string[]): void {
  const leaked = secrets.filter((secret) => body.includes(secret));
  expect(leaked.length, `${leaked.length} clear value(s) in the response`).toBe(0);
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export type Operation = 'list' | 'detail';

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

export interface WithdrawalsAdmin extends Sealer {
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** GET /admin/v1/withdrawals with the query, as `reviewer` unless given (null: no token). */
  list(query?: Record<string, string>, caller?: AdminCaller | null): Promise<AdminSent>;
  /** GET /admin/v1/withdrawals/{withdrawal_id}, as `reviewer` unless given (null: no token). */
  detail(withdrawalId: string, caller?: AdminCaller | null): Promise<AdminSent>;
  /** An account with withdraw.review only. */
  readonly reviewer: AdminCaller;
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
export async function withAdmin(f: Fixture, run: (h: WithdrawalsAdmin) => Promise<void>) {
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
  const dir = mkdtempSync(join(base, 'b2-09c-'));
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
        JWT_KEY_ID: 'b2_09c_test',
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
    const caller: WithdrawalsAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .withSchema('app')
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `wd_${id}`,
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
          .withSchema('app')
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
    const reviewer = await caller([REVIEW]);
    const viewer = await caller([VIEW]);
    const send = async (
      op: Operation,
      url: string,
      who: AdminCaller | null | undefined,
    ): Promise<AdminSent> => {
      const actor = who === undefined ? reviewer : who;
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
    await run({
      crypto,
      caller,
      reviewer,
      viewer,
      list(query, who) {
        const text = new URLSearchParams(query ?? {}).toString();
        return send('list', text === '' ? LIST_PATH : `${LIST_PATH}?${text}`, who);
      },
      detail(withdrawalId, who) {
        return send('detail', `${LIST_PATH}/${encodeURIComponent(withdrawalId)}`, who);
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

const PATHS: Record<Operation, string> = { list: LIST_PATH, detail: DETAIL_PATH };

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

/** The withdrawal_id of each item of a successful list response, in order. */
export async function ids(sent: AdminSent): Promise<unknown[]> {
  return (await page(sent)).items.map((item) => item['withdrawal_id']);
}

/** The data of a successful detail response, its instants as epoch milliseconds. */
export async function detailOf(sent: AdminSent): Promise<Record<string, unknown>> {
  const data = normalize((await answer(sent, 0)).data);
  expect(typeof data === 'object' && data !== null, sent.body).toBe(true);
  return data as Record<string, unknown>;
}

/** The list-row fields of a detail (the detail carries every field of a list row). */
export function listPart(detail: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(LIST_KEYS.map((key) => [key, detail[key]]));
}
