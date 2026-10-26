// B2-11a rule-test kit (BR-WDR-29 审核风险标签快照). Only *.int.test.ts open PG, through the
// B2-05d apply kit (real ledger, payout_accounts and withdrawals). Seeds are synthetic raw SQL; the
// facts and the same-device judgement are injectable ports, so a stub can fail with a real failed
// statement (22012) on the W1 transaction. The skeleton factories (createWithdrawRiskFlags,
// createWithdrawRiskFactsReader) are only called inside a test, never in hooks.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import {
  createWithdrawApply,
  type WithdrawApplyOptions,
  type WithdrawApplyService,
} from '../../../../apps/api/src/modules/payout/application/withdraw-apply.ts';
import type { PayoutConfigPort } from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import {
  createWithdrawRiskFlags,
  type WithdrawApplyRiskOptions,
  type WithdrawRiskFactsReader,
  type WithdrawRiskFlags,
  type WithdrawRiskFlagsOptions,
  type WithdrawRiskSubject,
} from '../../../../apps/api/src/modules/payout/application/withdraw-risk-flags.ts';
import { generateOutBizNo } from '../../../../apps/api/src/modules/payout/domain/out-biz-no.ts';
import type {
  SameDeviceAccountsCheck,
  SameDeviceAccountsInput,
} from '../../../../apps/api/src/modules/risk/application/same-device-accounts.ts';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import { voucher } from '../../ledger/posting/kit.ts';
import { NOW, fund, seedUser, type Fixture } from '../apply/kit.ts';
import type { FactValues } from './oracle.ts';

/** t of every test unless a test moves the clock: 2026-10-19 10:00 +08:00. */
export const T = new Date(NOW);
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

/** `ms` before `at` (default t). */
export function ago(ms: number, at: Date = T): Date {
  return new Date(at.getTime() - ms);
}

export type Failure = (handle: Kysely<DB>) => Promise<never>;

/** A statement that fails in PG (22012): without a savepoint it aborts the W1 transaction. */
export const failingStatement: Failure = async (handle) => {
  await sql`SELECT 1 / 0`.execute(handle);
  throw new Error('synthetic: the failing statement did not fail');
};

/** A failure without a statement (a client-side timeout). */
export const failingCall: Failure = async () => {
  throw new Error('synthetic query timeout');
};

export type FactMethod = keyof WithdrawRiskFactsReader;

export const FACT_METHODS: readonly FactMethod[] = [
  'hasPaidWithdrawal',
  'creditedToday',
  'selfOrders60d',
  'withdrawn30dFen',
  'received60dFen',
  'hadNegative',
  'reconDiff',
  'payeePrevOtherUser',
];

export interface FactCall {
  readonly method: FactMethod;
  readonly subject: WithdrawRiskSubject;
  readonly usersRowFree: boolean | null;
}

export interface StubFactsOptions {
  readonly calls?: FactCall[];
  readonly fail?: Partial<Record<FactMethod, Failure>>;
  /** Probe, on every call, whether the member's users row is still unlocked (BR-WDR-03 ⑭). */
  readonly probe?: () => Promise<boolean>;
}

/** A facts reader answering `values`; `fail` makes a method fail instead. */
export function stubFacts(
  values: FactValues,
  options: StubFactsOptions = {},
): WithdrawRiskFactsReader {
  const calls = options.calls ?? [];
  async function run<V>(
    method: FactMethod,
    handle: Kysely<DB>,
    subject: WithdrawRiskSubject,
    value: V,
  ): Promise<V> {
    const usersRowFree = options.probe === undefined ? null : await options.probe();
    calls.push({ method, subject, usersRowFree });
    const failure = options.fail?.[method];
    if (failure !== undefined) await failure(handle);
    return value;
  }
  return {
    hasPaidWithdrawal: (h, s) => run('hasPaidWithdrawal', h, s, values.paid),
    creditedToday: (h, s) => run('creditedToday', h, s, values.credited),
    selfOrders60d: (h, s) => run('selfOrders60d', h, s, values.orders),
    withdrawn30dFen: (h, s) => run('withdrawn30dFen', h, s, values.withdrawn),
    received60dFen: (h, s) => run('received60dFen', h, s, values.received),
    hadNegative: (h, s) => run('hadNegative', h, s, values.negative),
    reconDiff: (h, s) => run('reconDiff', h, s, values.recon),
    payeePrevOtherUser: (h, s) => run('payeePrevOtherUser', h, s, values.payeePrev),
  };
}

/** `reader` with one method replaced by a failure. */
export function breakFact(
  reader: WithdrawRiskFactsReader,
  method: FactMethod,
  failure: Failure,
): WithdrawRiskFactsReader {
  const broken = async (handle: Kysely<DB>) => failure(handle);
  return { ...reader, [method]: broken } as WithdrawRiskFactsReader;
}

export interface JudgeCall {
  readonly input: SameDeviceAccountsInput;
  /** txid_current() on the handle the judgement got. */
  readonly txid: string;
  readonly usersRowFree: boolean | null;
}

export interface StubJudgeOptions {
  readonly calls?: JudgeCall[];
  readonly fail?: Failure;
  readonly probe?: () => Promise<boolean>;
}

/** risk's ③ port answering `marked`; records each call. */
export function stubJudge(
  marked: boolean,
  options: StubJudgeOptions = {},
): SameDeviceAccountsCheck {
  const calls = options.calls ?? [];
  return {
    async judge(handle, input) {
      const usersRowFree = options.probe === undefined ? null : await options.probe();
      const { rows } = await sql<{ txid: string }>`SELECT txid_current()::text AS txid`.execute(
        handle,
      );
      calls.push({ input, txid: rows[0]!.txid, usersRowFree });
      if (options.fail !== undefined) await options.fail(handle);
      return { marked, devices: marked ? [{ device_hash: 'a'.repeat(64), rank: 3 }] : [] };
    },
  };
}

export interface MapConfig extends PayoutConfigPort {
  readonly reads: string[];
}

/** A configuration port over `values`; `fail` makes every risk.withdraw.* read fail. */
export function mapConfig(
  values: ReadonlyMap<string, unknown> = new Map(),
  fail?: Failure,
): MapConfig {
  const reads: string[] = [];
  return {
    reads,
    async configValue(_appId, key, handle) {
      reads.push(key);
      if (fail !== undefined && key.startsWith('risk.withdraw.')) await fail(handle);
      return values.has(key) ? { value: values.get(key), version: 1 } : null;
    },
  };
}

export interface RiskServiceInput {
  readonly config?: PayoutConfigPort;
  readonly sameDevice?: SameDeviceAccountsCheck;
  readonly facts?: WithdrawRiskFactsReader;
}

/** createWithdrawRiskFlags with a silent logger; absent ports: no configuration, ③ unmarked. */
export function riskService(input: RiskServiceInput = {}): WithdrawRiskFlags {
  const options: WithdrawRiskFlagsOptions = {
    config: input.config ?? mapConfig(),
    logger: { warn: () => undefined },
    sameDevice: input.sameDevice ?? stubJudge(false),
    ...(input.facts === undefined ? {} : { facts: input.facts }),
  };
  return createWithdrawRiskFlags(options);
}

/** A subject of an application that never touches the database (stub facts). */
export function subject(overrides: Partial<WithdrawRiskSubject> = {}): WithdrawRiskSubject {
  return {
    appId: `risk_flags_${randomUUID()}`,
    userId: randomUUID(),
    withdrawalId: randomUUID(),
    amountFen: 1000n,
    payeeHmac: randomBytes(32).toString('hex'),
    now: T,
    ...overrides,
  };
}

/** The fixture member's subject at `now` (the payee is the fixture's current account). */
export function memberSubject(
  f: Fixture,
  now: Date = T,
  userId = f.actor.userId,
): WithdrawRiskSubject {
  return {
    appId: f.actor.appId,
    userId,
    withdrawalId: randomUUID(),
    amountFen: 1000n,
    payeeHmac: f.hmac,
    now,
  };
}

/** W1 of the fixture with `riskFlags` (WithdrawApplyRiskOptions) added to its options. */
export function applyWith(f: Fixture, riskFlags: WithdrawRiskFlags): WithdrawApplyService {
  const options: WithdrawApplyOptions & WithdrawApplyRiskOptions = { ...f.options, riskFlags };
  return createWithdrawApply(options);
}

/** risk_flags / risk_flags_at of the fixture's withdrawals, in id order. */
export async function snapshots(f: Fixture, handle: Kysely<DB> = f.h.db) {
  const { rows } = await sql<{
    id: string;
    risk_flags: unknown;
    risk_flags_at: Date | null;
  }>`SELECT id, risk_flags, risk_flags_at FROM app.withdrawals
    WHERE app_id = ${f.actor.appId} ORDER BY id`.execute(handle);
  return rows;
}

/** Whether the member's users row can be locked right now from another connection. */
export function usersRowProbe(f: Fixture): () => Promise<boolean> {
  return async () => {
    try {
      await f.h.observer.transaction().execute(async (other) => {
        await sql`SELECT id FROM app.users WHERE app_id = ${f.actor.appId} AND id = ${f.actor.userId}
          FOR NO KEY UPDATE NOWAIT`.execute(other);
      });
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === '55P03') return false;
      throw error;
    }
  };
}

/** Another member of the fixture's app, with an empty ledger account. */
export async function otherMember(f: Fixture): Promise<string> {
  const userId = await seedUser(f.h.db, f.actor.appId);
  await fund(f.h.db, f.ledger, { appId: f.actor.appId, userId }, 0n);
  return userId;
}

/**
 * One user-account voucher booked at `at` (the fixture's clock is moved there and back). Amounts
 * are debit-positive / credit-negative: −100 credits the member 100 fen, +100 takes 100 fen.
 */
export async function book(
  f: Fixture,
  userId: string,
  signedFen: bigint,
  ledgerType: string,
  at: Date,
): Promise<void> {
  const before = f.clock.now();
  f.clock.set(at);
  try {
    await f.h.db.transaction().execute(async (trx) => {
      await lockUsersForUpdate(trx, { appId: f.actor.appId, userIds: [userId] });
      const [balance] = await f.ledger.lockBalances(trx, {
        appId: f.actor.appId,
        userIds: [userId],
      });
      if (balance === undefined) throw new Error('kit: the member has no ledger account');
      const base = voucher(f.actor.appId, balance.account_id, signedFen);
      await f.ledger.post(trx, {
        ...base,
        entries: base.entries.map((entry) => ({ ...entry, ledger_type: ledgerType })),
      });
    });
  } finally {
    f.clock.set(before);
  }
}

export type WithdrawalStatus =
  'PENDING_REVIEW' | 'APPROVED' | 'PAYING' | 'REJECTED' | 'PAID_API' | 'PAID_MANUAL' | 'FAILED';

/** A past withdrawal row (another payee HMAC, so the BR-WDR-04 payee counts stay untouched). */
export async function seedWithdrawal(
  f: Fixture,
  input: { status: WithdrawalStatus; amountFen: bigint; createdAt: Date; userId?: string },
  handle: Kysely<DB> = f.h.db,
): Promise<string> {
  const id = randomUUID();
  const paid = input.status === 'PAID_API' || input.status === 'PAID_MANUAL';
  const manual = input.status === 'PAID_MANUAL' ? randomUUID() : null;
  const amount = input.amountFen.toString();
  await sql`INSERT INTO app.withdrawals
    (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
     payee_name, payee_account_cipher, payee_hmac, status, out_biz_no, payout_channel, paid_at,
     reject_reason_code, manual_entry_by, manual_confirm_by, created_at, updated_at)
    VALUES (${id}, ${f.actor.appId}, ${input.userId ?? f.actor.userId}, ${amount}, 0, 0, ${amount},
      'SERVICE_FEE', 'alipay', '合成姓名', ${Buffer.from('synthetic-encrypted-account')},
      ${randomBytes(32).toString('hex')}, ${input.status}, ${generateOutBizNo(randomBytes)},
      'alipay', ${paid ? input.createdAt : null}, ${input.status === 'REJECTED' ? 'OTHER' : null},
      ${manual}, ${manual === null ? null : randomUUID()}, ${input.createdAt},
      ${input.createdAt})`.execute(handle);
  return id;
}

/** A withdraw_holds row; released when `releasedAt` is given. */
export async function seedHold(
  f: Fixture,
  input: {
    reason: 'manual' | 'recon_diff' | 'ledger_mismatch' | 'manual_failed_watch';
    createdAt: Date;
    releasedAt: Date | null;
    userId?: string;
  },
  handle: Kysely<DB> = f.h.db,
): Promise<void> {
  await sql`INSERT INTO app.withdraw_holds
    (id, app_id, user_id, reason, created_by, created_at, released_at, released_by)
    VALUES (${randomUUID()}, ${f.actor.appId}, ${input.userId ?? f.actor.userId}, ${input.reason},
      'synthetic', ${input.createdAt}, ${input.releasedAt},
      ${input.releasedAt === null ? null : 'synthetic'})`.execute(handle);
}

/**
 * A payout binding that is no longer current: `hmac` bound by `userId` from `boundAt` until it
 * was changed away at `changedAt` (payout_accounts row updated then, payout_account_changes row).
 */
export async function seedPastBinding(
  f: Fixture,
  input: {
    userId: string;
    method: 'alipay' | 'bank_card';
    hmac: string;
    boundAt: Date;
    changedAt: Date;
  },
): Promise<void> {
  const alipay = input.method === 'alipay';
  const cipher = Buffer.from('synthetic-encrypted-account');
  await sql`INSERT INTO app.payout_accounts
    (id, app_id, user_id, payout_method, payee_name, is_current, alipay_hmac, alipay_logon_id_cipher,
     bank_card_hmac, bank_card_no_cipher, bank_name, card_bin, created_at, updated_at)
    VALUES (${randomUUID()}, ${f.actor.appId}, ${input.userId}, ${input.method}, '合成姓名', false,
      ${alipay ? input.hmac : null}, ${alipay ? cipher : null},
      ${alipay ? null : input.hmac}, ${alipay ? null : cipher},
      ${alipay ? null : '合成银行'}, ${alipay ? null : '622202'},
      ${input.boundAt}, ${input.changedAt})`.execute(f.h.db);
  await sql`INSERT INTO app.payout_account_changes
    (app_id, user_id, old_payout_method, new_payout_method, old_hmac, new_hmac, operator, changed_at)
    VALUES (${f.actor.appId}, ${input.userId}, ${input.method}, 'alipay', ${input.hmac},
      ${randomBytes(32).toString('hex')}, 'user', ${input.changedAt})`.execute(f.h.db);
}

/** One attributed (or not) sub-order with its key; `rights` adds one order_rights row per status. */
export async function seedOrder(
  f: Fixture,
  input: {
    paidAt: Date;
    buyType: 'self' | 'share';
    rebateStatus: 'ESTIMATED' | 'WAITING' | 'CREDITED' | 'VOID' | 'CLAWED_BACK';
    userId?: string;
    rights?: readonly ('PROCESSING' | 'WAIT_COMMISSION' | 'SUCCEEDED' | 'FAILED')[];
  },
): Promise<string> {
  const orderId = randomUUID();
  const sub = `synthetic-${orderId}`;
  await sql`INSERT INTO app.order_keys (platform, sub_order_id, order_id, app_id, attr_at)
    VALUES ('taobao', ${sub}, ${orderId}, ${f.actor.appId}, ${input.paidAt})`.execute(f.h.db);
  await sql`INSERT INTO app.orders
    (order_id, app_id, platform, sub_order_id, raw_item_id, user_id, buy_type, platform_status,
     rebate_status, attr_at, paid_at, pay_amount_fen, est_commission_fen)
    VALUES (${orderId}, ${f.actor.appId}, 'taobao', ${sub}, 'synthetic-item',
      ${input.userId ?? f.actor.userId}, ${input.buyType}, 'PAID', ${input.rebateStatus},
      ${input.paidAt}, ${input.paidAt}, 10000, 100)`.execute(f.h.db);
  for (const status of input.rights ?? []) {
    await sql`INSERT INTO app.order_rights (id, app_id, order_id, source, type, status, occurred_at)
      VALUES (${randomUUID()}, ${f.actor.appId}, ${orderId}, 'API', 'RIGHTS', ${status},
        ${input.paidAt})`.execute(f.h.db);
  }
  return orderId;
}

/**
 * ④ fixture at t (task 9.3 #2, windows closed): ten counted self-purchase sub-orders, four of them
 * invalid (VOID, VOID at exactly t − 60 d, CLAWED_BACK, CREDITED with a SUCCEEDED right), and
 * three that must not count (paid 1 ms before the window, a share order, another member's order).
 * ⑤ has no high-commission order (1%), ⑥ no received order.
 */
export async function seedSelfOrders(f: Fixture): Promise<void> {
  const other = await seedUser(f.h.db, f.actor.appId);
  const sixty = 60 * DAY;
  await seedOrder(f, { paidAt: ago(DAY), buyType: 'self', rebateStatus: 'VOID' });
  await seedOrder(f, { paidAt: ago(sixty), buyType: 'self', rebateStatus: 'VOID' });
  await seedOrder(f, { paidAt: ago(2 * DAY), buyType: 'self', rebateStatus: 'CLAWED_BACK' });
  await seedOrder(f, {
    paidAt: ago(3 * DAY),
    buyType: 'self',
    rebateStatus: 'CREDITED',
    rights: ['SUCCEEDED'],
  });
  await seedOrder(f, {
    paidAt: ago(4 * DAY),
    buyType: 'self',
    rebateStatus: 'WAITING',
    rights: ['PROCESSING'],
  });
  await seedOrder(f, {
    paidAt: ago(5 * DAY),
    buyType: 'self',
    rebateStatus: 'WAITING',
    rights: ['FAILED'],
  });
  await seedOrder(f, { paidAt: ago(6 * DAY), buyType: 'self', rebateStatus: 'ESTIMATED' });
  await seedOrder(f, { paidAt: ago(7 * DAY), buyType: 'self', rebateStatus: 'CREDITED' });
  await seedOrder(f, { paidAt: ago(8 * DAY), buyType: 'self', rebateStatus: 'ESTIMATED' });
  await seedOrder(f, { paidAt: T, buyType: 'self', rebateStatus: 'WAITING' });
  // Not counted.
  await seedOrder(f, { paidAt: ago(sixty + 1), buyType: 'self', rebateStatus: 'VOID' });
  await seedOrder(f, { paidAt: ago(DAY), buyType: 'share', rebateStatus: 'VOID' });
  await seedOrder(f, { paidAt: ago(DAY), buyType: 'self', rebateStatus: 'VOID', userId: other });
}

/** One login of `userId` on `deviceHash` at `at` (identity's login_logs; BR-ID-37 reads it). */
export async function seedLogin(
  f: Fixture,
  userId: string,
  deviceHash: string,
  at: Date,
): Promise<void> {
  await sql`INSERT INTO app.login_logs
    (app_id, user_id, device_hash, device_id_hash, ip, method, created_at)
    VALUES (${f.actor.appId}, ${userId}, ${deviceHash}, ${randomBytes(32).toString('hex')},
      '192.0.2.37', 'sms', ${at})`.execute(f.h.db);
}

/** txid_current() of `handle`'s transaction. */
export async function txid(handle: Kysely<DB>): Promise<string> {
  const { rows } = await sql<{ txid: string }>`SELECT txid_current()::text AS txid`.execute(handle);
  return rows[0]!.txid;
}
