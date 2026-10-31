// B2-08b rule-test kit (claude-independent, SPEC_REF 81273415): tax_ytd added when a withdrawal is
// paid (规划/08 BR-WDR-20: only PAID_API / PAID_MANUAL, year = the +08:00 year of the withdrawal's
// created_at, cum_income += amount_fen, cum_withheld += tax_fen, rejections and failures add
// nothing; 04 §3.2 tax_ytd; BR-ID-25 细则「实名更正」: the year's totals are kept per real-name
// identity — 编排裁定 D10-181 ①, D10-459: identity's port realname-identity-key gives the verified
// real name's id_no_hmac, a corrected real name starts a row of its own, no event consumer).
// Real pieces: PostgreSQL through @couli/db/testing (couli_app), the ledger, the event bus,
// identity's users lock, B2-06fz's landing job (landing/kit.ts → process/kit.ts) and B2-07e's W11
// port (proven-success/kit.ts). Synthetic: members, their app.realname rows (as identity's
// verification leaves them; a correction is simulated by changing id_no_hmac), PAYING withdrawals
// with a chosen created_at (INSERT plus their real WITHDRAW:FREEZE voucher; process/kit.ts seeds
// one fixed created_at only), attempts. No real person, id number or channel data: every hmac is
// random hex.
// Only *.int.test.ts files call the database parts; the factories under test
// (createRealnameIdentityKeyReader, createTaxYtdAccumulator) are called inside each test before
// anything is seeded: red is the skeleton's NotImplemented.
import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { buildVouchers } from '@couli/domain';
import { sql, type Kysely } from 'kysely';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import type { PostingEntry } from '../../../../apps/api/src/modules/ledger/index.ts';
import type { ProcessFixture, Seeded } from '../landing/kit.ts';

export const TIMEOUT = 60_000;
export const MINUTE = 60_000;
/** The only income type (BR-WDR-20, BR-FUND-13). */
export const SERVICE_FEE = 'SERVICE_FEE';
/** The warn line of a paid withdrawal whose member has no verified real name (task §9.2 1). */
export const IDENTITY_MISSING = 'tax_ytd_identity_missing';
/** UUIDv7 (application ids, ADR-0001 §4). */
export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A synthetic identity key: 64 lowercase hex, the shape of realname.id_no_hmac. */
export function randomHmac(): string {
  return randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------------------------
// A database of its own (identity port and accumulator tests).

interface Database {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export async function openDb(create: () => Promise<Database>) {
  const database = await create();
  const url = database.urlFor('couli_app');
  return {
    database,
    /** couli_app: the business handle and the seeds. */
    db: createDb({ connectionString: url, max: 4 }),
    /** couli_app: observations from another connection. */
    observer: createDb({ connectionString: url, max: 2 }),
  };
}
export type DbHarness = Awaited<ReturnType<typeof openDb>>;

export async function closeDb(h: DbHarness | undefined): Promise<void> {
  if (!h) return;
  await Promise.all([destroyDb(h.db), destroyDb(h.observer)]);
  await h.database.drop();
}

/** A synthetic member of `appId` (identity's users row; no ledger account needed here). */
export async function seedMember(db: Kysely<DB>, appId: string): Promise<string> {
  const userId = randomUUID();
  await sql`INSERT INTO app.users
    (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status)
    VALUES (${userId}, ${appId}, 'synthetic', 'synthetic', ${randomUUID()}, ${randomUUID()}, 'L1',
      'sms', 'normal')`.execute(db);
  return userId;
}

// ---------------------------------------------------------------------------------------------
// identity's app.realname rows (as identity's verification / correction leaves them).

export type RealnameSeed =
  | { readonly status: 'verified'; readonly hmac: string }
  | { readonly status: 'failed' }
  /** 'none'; with `retainedHmac` the cleared row keeps its hmac for tax (tax_retained). */
  | { readonly status: 'none'; readonly retainedHmac?: string };

/** One app.realname row of the member (couli_app may INSERT it); synthetic ciphers only. */
export async function seedRealname(
  db: Kysely<DB>,
  appId: string,
  userId: string,
  seed: RealnameSeed,
): Promise<void> {
  let hmac: string | null = null;
  if (seed.status === 'verified') hmac = seed.hmac;
  else if (seed.status === 'none' && seed.retainedHmac !== undefined) hmac = seed.retainedHmac;
  const verified = seed.status === 'verified';
  const retained = seed.status === 'none' && hmac !== null;
  const cipher = (label: string) => (hmac !== null ? Buffer.from(`synthetic-${label}`) : null);
  await sql`INSERT INTO app.realname
    (id, app_id, user_id, name_cipher, id_no_cipher, id_no_hmac, birth_date_cipher, status,
     provider, verified_at, tax_retained)
    VALUES (${randomUUID()}, ${appId}, ${userId}, ${cipher('name')}, ${cipher('id-no')}, ${hmac},
      ${cipher('birth-date')}, ${seed.status}, ${verified ? 'synthetic' : null},
      ${verified ? new Date('2026-10-01T02:00:00.000Z') : null}, ${retained})`.execute(db);
}

/**
 * Customer service corrected the member's real name (BR-ID-25): the verified row now carries
 * another id_no_hmac (simulated by changing the column; exactly one row must change).
 */
export async function correctRealname(
  db: Kysely<DB>,
  appId: string,
  userId: string,
  hmac: string,
): Promise<void> {
  const result = await sql`UPDATE app.realname
    SET id_no_hmac = ${hmac}, id_no_cipher = ${Buffer.from('synthetic-id-no-corrected')},
      name_cipher = ${Buffer.from('synthetic-name-corrected')}, row_version = row_version + 1
    WHERE app_id = ${appId} AND user_id = ${userId} AND status = 'verified'`.execute(db);
  if (result.numAffectedRows !== 1n) throw new Error('correctRealname: no verified row');
}

// ---------------------------------------------------------------------------------------------
// tax_ytd observations.

export interface TaxRow {
  readonly id: string;
  readonly app_id: string;
  readonly user_id: string;
  readonly year: number;
  readonly income_type: string;
  readonly identity_hmac: string;
  readonly cum_income_fen: bigint;
  readonly cum_withheld_fen: bigint;
  readonly continuous_months: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Every tax_ytd row of the app (by user, year, identity). */
export async function taxRows(db: Kysely<DB>, appId: string): Promise<TaxRow[]> {
  return db
    .withSchema('app')
    .selectFrom('tax_ytd')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('user_id')
    .orderBy('year')
    .orderBy('identity_hmac')
    .execute();
}

/** The business columns of a tax_ytd row (no id or timestamps). */
export function totals(row: TaxRow) {
  return {
    app_id: row.app_id,
    user_id: row.user_id,
    year: row.year,
    income_type: row.income_type,
    identity_hmac: row.identity_hmac,
    cum_income_fen: row.cum_income_fen,
    cum_withheld_fen: row.cum_withheld_fen,
    continuous_months: row.continuous_months,
  };
}

/** The tax_ytd business columns expected for (user, year, identity) with these sums. */
export function expected(
  appId: string,
  userId: string,
  year: number,
  identityHmac: string,
  income: bigint,
  withheld: bigint,
) {
  return {
    app_id: appId,
    user_id: userId,
    year,
    income_type: SERVICE_FEE,
    identity_hmac: identityHmac,
    cum_income_fen: income,
    cum_withheld_fen: withheld,
    continuous_months: 0,
  };
}

export interface InvariantMismatch {
  readonly user_id: string;
  readonly year: number;
  readonly cum_income_fen: string;
  readonly paid_amount_fen: string;
  readonly cum_withheld_fen: string;
  readonly paid_tax_fen: string;
}

/**
 * The tax_ytd invariant (BR-WDR-20) per (member, year): Σ cum_income_fen over the member's identity
 * rows of the year = Σ amount_fen of the member's PAID_API / PAID_MANUAL withdrawals whose
 * created_at falls in that +08:00 year, and Σ cum_withheld_fen = Σ their tax_fen. Returns where it
 * does not hold (empty when it holds). Per identity the tests compare the rows themselves.
 */
export async function invariantMismatches(
  db: Kysely<DB>,
  appId: string,
): Promise<InvariantMismatch[]> {
  const result = await sql<InvariantMismatch>`
    WITH paid AS (
      SELECT user_id,
        extract(year FROM (created_at AT TIME ZONE 'UTC') + interval '8 hours')::int AS year,
        sum(amount_fen) AS amount_fen, sum(tax_fen) AS tax_fen
      FROM app.withdrawals
      WHERE app_id = ${appId} AND status IN ('PAID_API', 'PAID_MANUAL')
      GROUP BY 1, 2
    ), ytd AS (
      SELECT user_id, year, sum(cum_income_fen) AS income, sum(cum_withheld_fen) AS withheld
      FROM app.tax_ytd WHERE app_id = ${appId} GROUP BY 1, 2
    )
    SELECT COALESCE(p.user_id, y.user_id)::text AS user_id, COALESCE(p.year, y.year) AS year,
      COALESCE(y.income, 0)::text AS cum_income_fen, COALESCE(p.amount_fen, 0)::text AS paid_amount_fen,
      COALESCE(y.withheld, 0)::text AS cum_withheld_fen, COALESCE(p.tax_fen, 0)::text AS paid_tax_fen
    FROM paid p FULL JOIN ytd y ON y.user_id = p.user_id AND y.year = p.year`.execute(db);
  return result.rows.filter(
    (row) =>
      row.cum_income_fen !== row.paid_amount_fen || row.cum_withheld_fen !== row.paid_tax_fen,
  );
}

// ---------------------------------------------------------------------------------------------
// PAYING withdrawals with a chosen created_at (the landing tests).

export interface PayingSeed {
  readonly userId: string;
  readonly net?: bigint;
  readonly fee?: bigint;
  readonly tax?: bigint;
  /** Default 2026-10-19 09:58 +08:00 (as process/kit.ts seeds). */
  readonly createdAt?: Date;
  readonly channel?: 'alipay' | 'bank_card';
}

/**
 * A reviewed and executed withdrawal in PAYING (execute_seq 1, a manual batch), created at
 * `createdAt`, its amount frozen by the real WITHDRAW:FREEZE voucher `wd:{id}:FREEZE`. Same shape
 * as process/kit.ts's seedWithdrawal, whose created_at cannot be chosen (couli_app may not update
 * the column afterwards).
 */
export async function seedPaying(f: ProcessFixture, values: PayingSeed): Promise<Seeded> {
  const id = randomUUID();
  const appId = f.appId;
  const owner = values.userId;
  const net = values.net ?? 1000n;
  const fee = values.fee ?? 0n;
  const tax = values.tax ?? 0n;
  const amount = net + fee + tax;
  const channel = values.channel ?? 'alipay';
  const createdAt = values.createdAt ?? new Date('2026-10-19T01:58:00.000Z');
  const executedAt = new Date(createdAt.getTime() + MINUTE);
  const outBizNo = randomBytes(16).toString('hex');
  const batchId = await f.seedBatch();
  await f.h.db.transaction().execute(async (trx) => {
    await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, bank_name, status, out_biz_no,
       payout_channel, review_mode, reviewer_id, reviewed_at, executor_id, executed_at, batch_id,
       execute_seq, row_version, created_at, updated_at)
      VALUES (${id}, ${appId}, ${owner}, ${amount}, ${fee}, ${tax}, ${net}, ${SERVICE_FEE},
       ${channel}, '合成姓名', ${Buffer.from('synthetic-encrypted-account')},
       ${randomBytes(32).toString('hex')}, ${channel === 'bank_card' ? '合成银行' : null},
       'PAYING', ${outBizNo}, ${channel}, 'manual', ${randomUUID()}, ${createdAt}, ${f.adminId},
       ${executedAt}, ${batchId}, 1, 2, ${createdAt}, ${executedAt})`.execute(trx);
    await lockUsersForUpdate(trx, { appId, userIds: [owner] });
    const [balance] = await f.ledger.lockBalances(trx, { appId, userIds: [owner] });
    const [built] = buildVouchers('WITHDRAW:FREEZE', {
      withdrawal_id: id,
      user_id: owner,
      withdraw_fen: amount,
    });
    if (balance === undefined || built === undefined) {
      throw new Error('seed: the member has no balance row or FREEZE built no voucher');
    }
    const entries: PostingEntry[] = built.entries.map((entry) => ({
      account: { ownerType: 'user', accountId: balance.account_id },
      sub_account: entry.sub_account === 'frozen' ? 'frozen' : 'available',
      amount_fen: entry.amount_fen,
      ledger_type: entry.ledger_type,
      sub_type: entry.sub_type,
      income_type: null,
    }));
    await f.ledger.post(trx, {
      appId,
      uniqKey: built.uniq_key,
      bizType: 'withdrawal',
      bizId: id,
      operator: 'system',
      memo: null,
      orderKey: null,
      beneficiaryUserId: null,
      role: null,
      voucherKind: null,
      entries,
    });
  });
  return { id, appId, userId: owner, outBizNo, channel, net, amount, executeSeq: 1, batchId };
}

/** Every log line of a fixture logger as one JSON text (bigint as text), for "never logged" checks. */
export function logText(logger: Record<string, { mock: { calls: unknown[][] } }>): string {
  return JSON.stringify(
    Object.values(logger).flatMap((fn) => fn.mock.calls),
    (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
  );
}
