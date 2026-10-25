// B2-15j / BR-PAY-07 细则「不变量」(claude-independent, SPEC_REF 736d24c5): storage fixtures for the
// four collection invariants db/invariants/ledger/pay-*.sql; only the real SQL runs, no invariant
// algorithm is rewritten here. Every corruption is a legal INSERT / UPDATE as couli_app (no
// append-only trigger, constraint or role permission is disabled), as ../invariants/kit.ts and
// ../invariants-settlement/kit.ts do. Vouchers follow specs/ledger-rules.md 第 10 节 (uniq keys
// PAY_RECEIPT:{pay_order_id}, PAY_REFUND:{pay_refund_id}, PAY_ANOMALY:{pay_anomaly_id},
// PAY_ANOMALY_REFUND:{pay_refund_id}, PAY_FEE:{pay_channel}:{bill_date}; platform subjects only).
// A missing SQL file fails as an assertion, never as ENOENT.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createDb, destroyDb, type DB } from '@couli/db';
import { subFen } from '@couli/money';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  APP,
  DAY,
  account,
  entry,
  insert,
  platform,
  voucher,
  type Account,
  type Result,
  type Row,
  type Voucher,
} from '../invariants/kit.ts';

export {
  APP,
  OTHER_APP,
  DAY,
  TIMEOUT,
  account,
  clean,
  detailContains,
  differences,
} from '../invariants/kit.ts';
export type { Account, Result, Voucher } from '../invariants/kit.ts';

export type Code = 'pay-01' | 'pay-02' | 'pay-03' | 'pay-04';
export type Channel = 'wechat_pay' | 'alipay';
export const AT = '2032-06-15T08:00:00Z';
const BIZ = 'test_item';

interface Database {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}

/** Scope of the differences of each invariant (pay-01 names the user account it found). */
export const SCOPE: Record<Code, 'account' | 'global'> = {
  'pay-01': 'account',
  'pay-02': 'global',
  'pay-03': 'global',
  'pay-04': 'global',
};

/** The one SQL file of the invariant, vetted: one read-only SELECT, no SQL clock. */
export function source(code: Code): string {
  const directory = new URL('../../../../../db/invariants/ledger/', import.meta.url);
  const names = existsSync(directory) ? readdirSync(directory) : [];
  const matches = names.filter((name) => name.startsWith(`${code}_`) && name.endsWith('.sql'));
  expect(matches, `BR-PAY-07 ${code}: exactly one ${code}_*.sql`).toHaveLength(1);
  const raw = readFileSync(new URL(matches[0]!, directory), 'utf8');
  expect(raw).toMatch(/^\s*--[^\n]*BR-PAY-07/);
  const text = raw.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (token) =>
    token.startsWith("'") ? token : ' ',
  );
  const tokens = text.replace(/'(?:''|[^'])*'/g, ' ');
  expect(tokens.trim()).toMatch(/^(?:SELECT|WITH)\b/i);
  expect(tokens.trim().replace(/;\s*$/, '')).not.toContain(';');
  expect(tokens).not.toMatch(
    /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL|DO|COPY|INTO)\b/i,
  );
  expect(tokens).not.toMatch(
    /\b(?:now|clock_timestamp|statement_timestamp|transaction_timestamp)\s*\(|\b(?:CURRENT_DATE|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP)\b/i,
  );
  return text.trim().replace(/;\s*$/, '');
}

export interface Fixture {
  db: Kysely<DB>;
  /**
   * Runs the invariant read-only (REPEATABLE READ, couli.check_date set as the daily runner does)
   * and checks the unified output. `count` is the expected checked_rows: a population of 0 fails
   * the fixture here (规划/11 §4.2, D18); the empty population has its own `empty()`.
   */
  check(count: bigint, date?: string): Promise<Result[]>;
  /** The sentinel of an empty population: one 'none' row with checked_rows 0. */
  empty(date?: string): Promise<Result[]>;
}

// A fresh database per scenario keeps intentionally bad rows out of the next test.
export async function scenario(
  create: () => Promise<Database>,
  code: Code,
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const query = source(code);
  const database = await create();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  const reader = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  const read = (date: string) =>
    reader
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        await sql`SET TRANSACTION READ ONLY`.execute(trx);
        await sql`SELECT set_config('couli.check_date', ${date}, true)`.execute(trx);
        const { rows } = await sql.raw<Result>(query).execute(trx);
        expect(rows.length, 'a sentinel or at least one difference is mandatory').toBeGreaterThan(
          0,
        );
        for (const row of rows) {
          expect(Object.keys(row).sort()).toEqual([
            'account_id',
            'app_id',
            'checked_rows',
            'detail',
            'invariant',
            'scope',
          ]);
          expect(row.invariant).toBe(code);
          expect(typeof row.checked_rows).toBe('bigint');
          expect(row.checked_rows).toBe(rows[0]!.checked_rows);
          expect(['none', SCOPE[code]]).toContain(row.scope);
        }
        const types = await sql
          .raw<Row>(
            `SELECT pg_typeof(invariant)::text AS invariant,
          pg_typeof(checked_rows)::text AS checked_rows, pg_typeof(scope)::text AS scope,
          pg_typeof(app_id)::text AS app_id, pg_typeof(account_id)::text AS account_id,
          pg_typeof(detail)::text AS detail FROM (${query}\n) AS result LIMIT 1`,
          )
          .execute(trx);
        expect(types.rows).toEqual([
          {
            invariant: 'text',
            checked_rows: 'bigint',
            scope: 'text',
            app_id: 'text',
            account_id: 'uuid',
            detail: 'jsonb',
          },
        ]);
        return rows;
      });
  try {
    await run({
      db,
      async check(count, date = DAY) {
        expect(
          count,
          'D18: a fixture must give the invariant something to inspect',
        ).toBeGreaterThan(0n);
        const rows = await read(date);
        for (const row of rows) expect(row.checked_rows).toBe(count);
        return rows;
      },
      async empty(date = DAY) {
        const rows = await read(date);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          invariant: code,
          checked_rows: 0n,
          scope: 'none',
          app_id: null,
          account_id: null,
          detail: null,
        });
        return rows;
      },
    });
  } finally {
    await Promise.all([destroyDb(db), destroyDb(reader)]);
    await database.drop();
  }
}

// ---------------------------------------------------------------------------------------------
// Payment rows (what B2-15b ～ B2-15e would have left).

export interface PayOrder {
  readonly app: string;
  readonly id: string;
  readonly out_trade_no: string;
  readonly pay_channel: Channel;
  readonly biz_type: string;
  readonly amount_fen: bigint;
  readonly status: 'PENDING' | 'PAID' | 'CLOSED';
}
export interface PayAnomaly {
  readonly app: string;
  readonly id: string;
  readonly pay_channel: Channel;
  readonly amount_fen: bigint;
}
export interface PayRefund {
  readonly app: string;
  readonly id: string;
  readonly out_refund_no: string;
  readonly target_type: 'pay_order' | 'pay_anomaly';
  readonly target_id: string;
  readonly amount_fen: bigint;
  readonly status: 'PROCESSING' | 'SUCCESS' | 'FAILED';
}

function merchantNo(prefix: string): string {
  return `${prefix}${randomBytes(10).toString('hex').toUpperCase()}`;
}

/** The payer of the app's pay orders (pay_orders_user_fkey). */
async function payer(db: Kysely<DB>, app: string): Promise<string> {
  const id = randomUUID();
  await insert(db, 'users', {
    id,
    app_id: app,
    nickname: 'synthetic payer',
    avatar: '',
    invite_code: randomUUID(),
    attr_code: randomUUID(),
    level: 'member',
    register_method: 'synthetic',
    created_at: AT,
    updated_at: AT,
  });
  return id;
}

export async function payOrder(
  db: Kysely<DB>,
  options: {
    readonly app?: string;
    readonly status?: PayOrder['status'];
    readonly channel?: Channel;
    readonly amount?: bigint;
  } = {},
): Promise<PayOrder> {
  const app = options.app ?? APP;
  const status = options.status ?? 'PAID';
  const order: PayOrder = {
    app,
    id: randomUUID(),
    out_trade_no: merchantNo('P'),
    pay_channel: options.channel ?? 'wechat_pay',
    biz_type: BIZ,
    amount_fen: options.amount ?? 12_345n,
    status,
  };
  await insert(db, 'pay_orders', {
    id: order.id,
    app_id: app,
    user_id: await payer(db, app),
    biz_type: order.biz_type,
    biz_ref: randomUUID(),
    pay_channel: order.pay_channel,
    amount_fen: order.amount_fen,
    status,
    out_trade_no: order.out_trade_no,
    channel_trade_no: status === 'PAID' ? merchantNo('T') : null,
    expire_at: AT,
    paid_at: status === 'PAID' ? AT : null,
    closed_at: status === 'CLOSED' ? AT : null,
    created_at: AT,
    updated_at: AT,
  });
  return order;
}

/** An anomaly receipt row (BR-PAY-05 ④): for a CLOSED order of ours, or for no order (null). */
export async function payAnomaly(
  db: Kysely<DB>,
  options: {
    readonly app?: string;
    readonly channel?: Channel;
    readonly amount?: bigint;
    readonly order?: PayOrder | null;
  } = {},
): Promise<PayAnomaly> {
  const app = options.app ?? options.order?.app ?? APP;
  const anomaly: PayAnomaly = {
    app,
    id: randomUUID(),
    pay_channel: options.channel ?? options.order?.pay_channel ?? 'wechat_pay',
    amount_fen: options.amount ?? options.order?.amount_fen ?? 12_345n,
  };
  await insert(db, 'pay_anomalies', {
    id: anomaly.id,
    app_id: app,
    pay_channel: anomaly.pay_channel,
    channel_trade_no: merchantNo('T'),
    out_trade_no: options.order?.out_trade_no ?? null,
    pay_order_id: options.order?.id ?? null,
    amount_fen: anomaly.amount_fen,
    refunded_fen: 0n,
    evidence: JSON.stringify({ source: 'notify', seeded_by: 'b2-15j-invariants' }),
    status: 'open',
    created_at: AT,
  });
  return anomaly;
}

/**
 * A refund row. A SUCCESS one also moves the target's refunded_fen (and an anomaly refunded in
 * full becomes 'refunded'), as the success handling of B2-15e does; `bookTarget: false` leaves the
 * target as it was (a corruption).
 */
export async function payRefund(
  db: Kysely<DB>,
  target: PayOrder | PayAnomaly,
  options: {
    readonly amount?: bigint;
    readonly status?: PayRefund['status'];
    readonly bookTarget?: boolean;
  } = {},
): Promise<PayRefund> {
  const targetType = 'out_trade_no' in target ? 'pay_order' : 'pay_anomaly';
  const refund: PayRefund = {
    app: target.app,
    id: randomUUID(),
    out_refund_no: merchantNo('R'),
    target_type: targetType,
    target_id: target.id,
    amount_fen: options.amount ?? 1_000n,
    status: options.status ?? 'SUCCESS',
  };
  await insert(db, 'pay_refunds', {
    id: refund.id,
    app_id: refund.app,
    target_type: targetType,
    target_id: target.id,
    idempotency_key: `seed_${randomBytes(12).toString('hex')}`,
    out_refund_no: refund.out_refund_no,
    amount_fen: refund.amount_fen,
    reason_code: targetType === 'pay_anomaly' ? 'ANOMALY_RECEIPT' : 'USER_REQUEST',
    status: refund.status,
    operator: randomUUID(),
    created_at: AT,
    succeeded_at: refund.status === 'SUCCESS' ? AT : null,
    failed_at: refund.status === 'FAILED' ? AT : null,
  });
  if (refund.status === 'SUCCESS' && options.bookTarget !== false) {
    const amount = refund.amount_fen.toString();
    if (targetType === 'pay_order') {
      await sql`UPDATE app.pay_orders SET refunded_fen = refunded_fen + ${amount}::bigint
        WHERE app_id = ${refund.app} AND id = ${target.id}::uuid`.execute(db);
    } else {
      await sql`UPDATE app.pay_anomalies
        SET refunded_fen = refunded_fen + ${amount}::bigint,
          status = CASE WHEN refunded_fen + ${amount}::bigint = amount_fen THEN 'refunded' ELSE status END
        WHERE app_id = ${refund.app} AND id = ${target.id}::uuid`.execute(db);
    }
  }
  return refund;
}

/** Raises the refunded_fen of an anomaly without any refund behind it (a corruption). */
export async function bumpRefunded(db: Kysely<DB>, anomaly: PayAnomaly, amount: bigint) {
  await sql`UPDATE app.pay_anomalies SET refunded_fen = refunded_fen + ${amount.toString()}::bigint
    WHERE app_id = ${anomaly.app} AND id = ${anomaly.id}::uuid`.execute(db);
}

// ---------------------------------------------------------------------------------------------
// Vouchers (platform subjects, ledger_type and sub_type as payment posts them).

/** The app's platform account of a subject, created on first use (ledger_accounts is unique). */
export async function subject(db: Kysely<DB>, app: string, name: string): Promise<Account> {
  const row = await db
    .selectFrom('ledger_accounts')
    .select(['id', 'app_id', 'owner_id', 'owner_type', 'subject'])
    .where('app_id', '=', app)
    .where('owner_type', '=', 'platform')
    .where('owner_id', '=', 'platform')
    .where('subject', '=', name)
    .executeTakeFirst();
  return row ?? platform(db, name, app);
}

/** One debit-positive line: an account (or a platform subject name) and its signed amount. */
export interface Line {
  readonly to: Account | string;
  readonly amount: bigint;
  /** ledger_type of the line; the voucher's type by default. */
  readonly ledgerType?: string;
}

export interface VoucherInput {
  readonly app: string;
  readonly bizType: string;
  readonly bizId: string;
  readonly uniqKey: string;
  /** voucher_kind (null leaves it empty: the type is then only on the entries). */
  readonly kind: string | null;
  readonly ledgerType: string;
  readonly subType: string;
  readonly lines: readonly Line[];
}

export async function post(db: Kysely<DB>, input: VoucherInput): Promise<Voucher> {
  const v = await voucher(db, {
    app_id: input.app,
    biz_type: input.bizType,
    biz_id: input.bizId,
    uniq_key: input.uniqKey,
    voucher_kind: input.kind,
    operator: 'system:payment',
    accounting_date: DAY,
  });
  for (const line of input.lines) {
    const target = typeof line.to === 'string' ? await subject(db, input.app, line.to) : line.to;
    await entry(db, target, v, line.amount, {
      ledger_type: line.ledgerType ?? input.ledgerType,
      sub_type: input.subType,
      income_type: null,
    });
  }
  return v;
}

/** PAY_RECEIPT: 借 CASH_PAY:{pay_channel} / 贷 PAY_RECEIPTS:{biz_type}, amount_fen. */
export function receipt(
  db: Kysely<DB>,
  order: PayOrder,
  patch: Partial<VoucherInput> = {},
): Promise<Voucher> {
  return post(db, {
    app: order.app,
    bizType: 'pay_order',
    bizId: order.id,
    uniqKey: `PAY_RECEIPT:${order.id}`,
    kind: 'PAY_RECEIPT',
    ledgerType: 'PAY_RECEIPT',
    subType: order.pay_channel,
    lines: [
      { to: `CASH_PAY:${order.pay_channel}`, amount: order.amount_fen },
      { to: `PAY_RECEIPTS:${order.biz_type}`, amount: subFen(0n, order.amount_fen) },
    ],
    ...patch,
  });
}

/** PAY_ANOMALY of a registration: 借 CASH_PAY:{pay_channel} / 贷 PAY_SUSPENSE, the received amount. */
export function anomalyReceipt(
  db: Kysely<DB>,
  anomaly: PayAnomaly,
  patch: Partial<VoucherInput> = {},
): Promise<Voucher> {
  return post(db, {
    app: anomaly.app,
    bizType: 'pay_anomaly',
    bizId: anomaly.id,
    uniqKey: `PAY_ANOMALY:${anomaly.id}`,
    kind: 'PAY_ANOMALY',
    ledgerType: 'PAY_ANOMALY',
    subType: anomaly.pay_channel,
    lines: [
      { to: `CASH_PAY:${anomaly.pay_channel}`, amount: anomaly.amount_fen },
      { to: 'PAY_SUSPENSE', amount: subFen(0n, anomaly.amount_fen) },
    ],
    ...patch,
  });
}

/** PAY_REFUND of a refund of a pay order: 借 PAY_RECEIPTS:{biz_type} / 贷 CASH_PAY:{pay_channel}. */
export function refundVoucher(
  db: Kysely<DB>,
  order: PayOrder,
  refund: PayRefund,
  patch: Partial<VoucherInput> = {},
): Promise<Voucher> {
  return post(db, {
    app: refund.app,
    bizType: 'pay_refund',
    bizId: refund.id,
    uniqKey: `PAY_REFUND:${refund.id}`,
    kind: 'PAY_REFUND',
    ledgerType: 'PAY_REFUND',
    subType: order.pay_channel,
    lines: [
      { to: `PAY_RECEIPTS:${order.biz_type}`, amount: refund.amount_fen },
      { to: `CASH_PAY:${order.pay_channel}`, amount: subFen(0n, refund.amount_fen) },
    ],
    ...patch,
  });
}

/**
 * The reverse PAY_ANOMALY of a refund of an anomaly receipt: 借 PAY_SUSPENSE / 贷 CASH_PAY.
 * `forward: true` books it the wrong way round (贷 PAY_SUSPENSE), a corruption.
 */
export function anomalyRefundVoucher(
  db: Kysely<DB>,
  anomaly: PayAnomaly,
  refund: PayRefund,
  options: { readonly forward?: boolean } & Partial<VoucherInput> = {},
): Promise<Voucher> {
  const { forward, ...patch } = options;
  const sign = forward === true ? -1n : 1n;
  return post(db, {
    app: refund.app,
    bizType: 'pay_refund',
    bizId: refund.id,
    uniqKey: `PAY_ANOMALY_REFUND:${refund.id}`,
    kind: 'PAY_ANOMALY',
    ledgerType: 'PAY_ANOMALY',
    subType: anomaly.pay_channel,
    lines: [
      { to: 'PAY_SUSPENSE', amount: sign * refund.amount_fen },
      { to: `CASH_PAY:${anomaly.pay_channel}`, amount: subFen(0n, sign * refund.amount_fen) },
    ],
    ...patch,
  });
}

/** PAY_FEE of one (channel, bill date): 借 PAY_CHANNEL_FEE / 贷 CASH_PAY:{pay_channel}. */
export function feeVoucher(
  db: Kysely<DB>,
  app: string,
  channel: Channel,
  billDate: string,
  amount: bigint,
): Promise<Voucher> {
  return post(db, {
    app,
    bizType: 'pay_bill',
    bizId: `${channel}:${billDate}`,
    uniqKey: `PAY_FEE:${channel}:${billDate}`,
    kind: 'PAY_FEE',
    ledgerType: 'PAY_FEE',
    subType: channel,
    lines: [
      { to: 'PAY_CHANNEL_FEE', amount },
      { to: `CASH_PAY:${channel}`, amount: subFen(0n, amount) },
    ],
  });
}

/** A user account of the app (USER_BALANCE), for the vouchers that must never reach one. */
export function userAccount(db: Kysely<DB>, app: string): Promise<Account> {
  return account(db, { app_id: app });
}

/** A user-side rebate voucher (not a payment voucher): it is outside pay-01's population. */
export async function rebateVoucher(db: Kysely<DB>, user: Account): Promise<Voucher> {
  const v = await voucher(db, {
    app_id: user.app_id,
    biz_type: 'order',
    order_key: `taobao:${randomUUID()}`,
    beneficiary_user_id: user.owner_id,
    role: 'self',
    voucher_kind: 'CREDIT',
  });
  await entry(db, user, v, -100n);
  await entry(db, await subject(db, user.app_id, 'UNION_RECEIVABLE:taobao'), v, 100n);
  return v;
}

/** Row values of a details object as text (detail keys are left to the SQL). */
export function detailOf(row: Result): Record<string, unknown> {
  expect(typeof row.detail === 'object' && row.detail !== null, JSON.stringify(row)).toBe(true);
  return row.detail as Record<string, unknown>;
}

/** The difference rows whose detail mentions `value` anywhere. */
export function mentioning(rows: readonly Result[], value: string): Result[] {
  const leaves = (node: unknown): string[] =>
    node !== null && typeof node === 'object'
      ? Object.values(node).flatMap(leaves)
      : [String(node)];
  return rows.filter((row) => leaves(row.detail).includes(value));
}
