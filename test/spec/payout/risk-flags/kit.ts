// B2-11a rule-test kit (BR-WDR-29 审核风险标签快照). Only *.int.test.ts open PG, through the
// B2-05d apply kit (real ledger, payout_accounts and withdrawals). Seeds are synthetic raw SQL; the
// facts and the same-device judgement are injectable ports, so a stub can fail with a real failed
// statement (22012) on the W1 transaction. The skeleton factories (createWithdrawRiskFlags,
// createWithdrawRiskFactsReader) are only called inside a test, never in hooks.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { orderKey } from '@couli/domain';
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
import type { SelfOrderFact } from '../../../../apps/api/src/modules/payout/domain/risk-flags.ts';
import type {
  SameDeviceAccountsCheck,
  SameDeviceAccountsInput,
} from '../../../../apps/api/src/modules/risk/application/same-device-accounts.ts';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import { createPayeeBindingHistoryReader } from '../../../../apps/api/src/modules/identity/ports/payee-prev-other-user.ts';
import { createBeneficiaryShareReader } from '../../../../apps/api/src/modules/commission/ports/withdraw-risk-shares.ts';
import { createWithdrawRiskFactsReader } from '../../../../apps/api/src/modules/payout/infra/withdraw-risk-facts.ts';
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

/**
 * The real facts reader with the commission (⑥ shares) and identity (⑩ binding history) ports
 * injected, as app.module wires it (the reader takes them as ports: modules only via index).
 */
export function realRiskFacts(): WithdrawRiskFactsReader {
  return createWithdrawRiskFactsReader({
    shares: createBeneficiaryShareReader(),
    payeeHistory: createPayeeBindingHistoryReader(),
  });
}

/** createWithdrawRiskFlags with a silent logger; absent ports: no configuration, ③ unmarked. */
export function riskService(input: RiskServiceInput = {}): WithdrawRiskFlags {
  const options: WithdrawRiskFlagsOptions = {
    config: input.config ?? mapConfig(),
    logger: { warn: () => undefined },
    sameDevice: input.sameDevice ?? stubJudge(false),
    facts: input.facts ?? realRiskFacts(),
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
 * Moves the binding time of the fixture member's current payout account (payout_accounts.created_at
 * of the is_current row, as identity writes it) to `at`: ⑩'s anchor (BR-WDR-02 细则).
 */
export async function bindCurrentAt(f: Fixture, at: Date): Promise<void> {
  // couli_app may not update created_at: the current row is retired and re-inserted (same account,
  // new id) with the binding time `at`, in one transaction.
  await f.h.db.transaction().execute(async (trx) => {
    const current = await sql<{ id: string }>`UPDATE app.payout_accounts SET is_current = false
      WHERE app_id = ${f.actor.appId} AND user_id = ${f.actor.userId} AND is_current
      RETURNING id`.execute(trx);
    const id = current.rows[0]?.id;
    if (id === undefined)
      throw new Error('bindCurrentAt: the fixture member has no current account');
    await sql`INSERT INTO app.payout_accounts
      (id, app_id, user_id, payout_method, payee_name, is_current, alipay_hmac, alipay_logon_id_cipher,
       bank_card_hmac, bank_card_no_cipher, bank_name, card_bin, created_at, updated_at)
      SELECT ${randomUUID()}, app_id, user_id, payout_method, payee_name, true, alipay_hmac,
        alipay_logon_id_cipher, bank_card_hmac, bank_card_no_cipher, bank_name, card_bin, ${at}, ${at}
      FROM app.payout_accounts WHERE id = ${id}`.execute(trx);
  });
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

export interface SeededOrder {
  readonly orderId: string;
  /** The ledger order_key of the sub-order (vouchers of its credits carry it). */
  readonly orderKey: string;
}

/**
 * One attributed (or not) sub-order with its key; `rights` adds one order_rights row per status.
 * The union's synced values: 联盟预估佣金 est_commission_fen (default 100) and 计佣金额
 * pay_amount_fen (default 10000, 100 bp) — the only synced amount columns besides
 * settle_commission_fen (orders' OrderSyncColumns). Every derived column that is not a synced value
 * (base_fen, booked_base_fen, settle_commission_fen, commission_rate_bp) gets a distractor that
 * would make every order high-commission if read instead. platform_status follows received_at.
 */
export async function seedOrder(
  f: Fixture,
  input: {
    paidAt: Date;
    buyType: 'self' | 'share';
    rebateStatus: 'ESTIMATED' | 'WAITING' | 'CREDITED' | 'VOID' | 'CLAWED_BACK';
    userId?: string;
    rights?: readonly ('PROCESSING' | 'WAIT_COMMISSION' | 'SUCCEEDED' | 'FAILED')[];
    receivedAt?: Date | null;
    commissionVersion?: number;
    estCommissionFen?: bigint | null;
    payAmountFen?: bigint | null;
  },
): Promise<SeededOrder> {
  const orderId = randomUUID();
  const sub = `synthetic-${orderId}`;
  const received = input.receivedAt ?? null;
  const est = input.estCommissionFen === undefined ? 100n : input.estCommissionFen;
  const pay = input.payAmountFen === undefined ? 10000n : input.payAmountFen;
  await sql`INSERT INTO app.order_keys (platform, sub_order_id, order_id, app_id, attr_at)
    VALUES ('taobao', ${sub}, ${orderId}, ${f.actor.appId}, ${input.paidAt})`.execute(f.h.db);
  await sql`INSERT INTO app.orders
    (order_id, app_id, platform, sub_order_id, raw_item_id, user_id, buy_type, platform_status,
     rebate_status, attr_at, paid_at, received_at, commission_version, pay_amount_fen,
     est_commission_fen, settle_commission_fen, base_fen, booked_base_fen, commission_rate_bp)
    VALUES (${orderId}, ${f.actor.appId}, 'taobao', ${sub}, 'synthetic-item',
      ${input.userId ?? f.actor.userId}, ${input.buyType}, ${received === null ? 'PAID' : 'RECEIVED'},
      ${input.rebateStatus}, ${input.paidAt}, ${input.paidAt}, ${received},
      ${input.commissionVersion ?? 1}, ${pay?.toString() ?? null}, ${est?.toString() ?? null},
      9000000, 1, 1, 9999)`.execute(f.h.db);
  for (const status of input.rights ?? []) {
    // A distinct platform_rights_no per row (order_rights_dedupe_key is NULLS NOT DISTINCT).
    await sql`INSERT INTO app.order_rights
      (id, app_id, order_id, source, type, status, occurred_at, platform_rights_no)
      VALUES (${randomUUID()}, ${f.actor.appId}, ${orderId}, 'API', 'RIGHTS', ${status},
        ${input.paidAt}, ${`synthetic-${randomUUID()}`})`.execute(f.h.db);
  }
  return { orderId, orderKey: orderKey('taobao', sub) };
}

export type ShareRole = 'self' | 'share' | 'direct';

/** commission's split amount of one beneficiary at one commission_version of the order. */
export async function seedSplit(
  f: Fixture,
  order: SeededOrder,
  input: { version: number; userId: string; role: ShareRole; amountFen: bigint },
): Promise<void> {
  await sql`INSERT INTO app.commission_split_amounts
    (app_id, order_id, commission_version, user_id, role, base_fen, amount_fen)
    VALUES (${f.actor.appId}, ${order.orderId}, ${input.version}, ${input.userId}, ${input.role},
      1000000000000, ${input.amountFen.toString()})`.execute(f.h.db);
}

const CREDIT_TYPES: Readonly<Record<ShareRole, string>> = {
  self: 'REBATE_CREDIT',
  share: 'SHARE_CREDIT',
  direct: 'REFERRAL_CREDIT',
};

/**
 * One beneficiary voucher of the order through ledger.post (its order_key, beneficiary and role):
 * CREDIT credits the member `fen`, CLAWBACK takes `fen` back. The ledger's order nets
 * (BR-FUND-08 已入账净额) are the sum of these per (beneficiary, role).
 */
export async function postOrderVoucher(
  f: Fixture,
  order: SeededOrder,
  input: { userId: string; role: ShareRole; kind: 'CREDIT' | 'CLAWBACK'; fen: bigint },
): Promise<void> {
  const credit = input.kind === 'CREDIT';
  const ledgerType = credit ? CREDIT_TYPES[input.role] : 'CLAWBACK';
  await f.h.db.transaction().execute(async (trx) => {
    await lockUsersForUpdate(trx, { appId: f.actor.appId, userIds: [input.userId] });
    const [balance] = await f.ledger.lockBalances(trx, {
      appId: f.actor.appId,
      userIds: [input.userId],
    });
    if (balance === undefined) throw new Error('kit: the member has no ledger account');
    const base = voucher(f.actor.appId, balance.account_id, credit ? -input.fen : input.fen, {
      bizType: credit ? 'ORDER_CREDIT' : 'ORDER_ADJUST',
      bizId: order.orderKey,
      orderKey: order.orderKey,
      beneficiaryUserId: input.userId,
      role: input.role,
      voucherKind: input.kind,
    });
    await f.ledger.post(trx, {
      ...base,
      entries: base.entries.map((entry) => ({ ...entry, ledger_type: ledgerType })),
    });
  });
}

/**
 * ⑥ denominator fixture at t (BR-WDR-29 ⑥; windows closed): the fixture member's rebate shares as
 * beneficiary on sub-orders received in [t − 60 d, t] with rebate_status WAITING (the split amount
 * at the order's current commission_version) or CREDITED (the ledger net of the member's key, not
 * the split amount). Counted: 300 + 150 + 70 + 480 + 80 + 33 = 1113 fen. Every share that must not
 * count is a distinct large amount, so any one of them changes the sum. Returns the downline buyer
 * and another member, who have shares of their own.
 */
export async function seedReceivedShares(
  f: Fixture,
): Promise<{ readonly buyer: string; readonly stranger: string }> {
  const me = f.actor.userId;
  const buyer = await otherMember(f);
  const stranger = await otherMember(f);
  const sixty = 60 * DAY;
  // ① self, WAITING, paid long before the window: the current version's estimate 300 (v1 999 stale).
  const own = await seedOrder(f, {
    paidAt: ago(90 * DAY),
    receivedAt: ago(DAY),
    buyType: 'self',
    rebateStatus: 'WAITING',
    commissionVersion: 2,
  });
  await seedSplit(f, own, { version: 1, userId: me, role: 'self', amountFen: 999n });
  await seedSplit(f, own, { version: 2, userId: me, role: 'self', amountFen: 300n });
  // ② share, WAITING: 150.
  const shared = await seedOrder(f, {
    paidAt: ago(70 * DAY),
    receivedAt: ago(2 * DAY),
    buyType: 'share',
    rebateStatus: 'WAITING',
  });
  await seedSplit(f, shared, { version: 1, userId: me, role: 'share', amountFen: 150n });
  // ③ direct on the downline's self purchase, WAITING: 70 (the buyer's own 500 is not ours).
  const downline = await seedOrder(f, {
    paidAt: ago(10 * DAY),
    receivedAt: ago(3 * DAY),
    buyType: 'self',
    rebateStatus: 'WAITING',
    userId: buyer,
  });
  await seedSplit(f, downline, { version: 1, userId: buyer, role: 'self', amountFen: 500n });
  await seedSplit(f, downline, { version: 1, userId: me, role: 'direct', amountFen: 70n });
  // ④ self, CREDITED 600 then 120 clawed back: the net 480, not the split's 600.
  const credited = await seedOrder(f, {
    paidAt: ago(80 * DAY),
    receivedAt: ago(4 * DAY),
    buyType: 'self',
    rebateStatus: 'CREDITED',
  });
  await seedSplit(f, credited, { version: 1, userId: me, role: 'self', amountFen: 600n });
  await postOrderVoucher(f, credited, { userId: me, role: 'self', kind: 'CREDIT', fen: 600n });
  await postOrderVoucher(f, credited, { userId: me, role: 'self', kind: 'CLAWBACK', fen: 120n });
  // ⑤ direct, CREDITED, received exactly t − 60 d: the net 80 (split 90; the buyer's 400 is not ours).
  const edge = await seedOrder(f, {
    paidAt: ago(sixty + DAY),
    receivedAt: ago(sixty),
    buyType: 'self',
    rebateStatus: 'CREDITED',
    userId: buyer,
  });
  await seedSplit(f, edge, { version: 1, userId: buyer, role: 'self', amountFen: 400n });
  await seedSplit(f, edge, { version: 1, userId: me, role: 'direct', amountFen: 90n });
  await postOrderVoucher(f, edge, { userId: buyer, role: 'self', kind: 'CREDIT', fen: 400n });
  await postOrderVoucher(f, edge, { userId: me, role: 'direct', kind: 'CREDIT', fen: 80n });
  // ⑥ share, CREDITED, received exactly t: 33.
  const atT = await seedOrder(f, {
    paidAt: ago(5 * DAY),
    receivedAt: T,
    buyType: 'share',
    rebateStatus: 'CREDITED',
  });
  await seedSplit(f, atT, { version: 1, userId: me, role: 'share', amountFen: 33n });
  await postOrderVoucher(f, atT, { userId: me, role: 'share', kind: 'CREDIT', fen: 33n });

  // Not counted (the member's own self-purchase shares).
  const after = new Date(T.getTime() + 1);
  const excluded = [
    // received 1 ms before the window
    { paid: ago(sixty), received: ago(sixty + 1), status: 'WAITING', fen: 10_000n },
    { paid: ago(9 * DAY), received: ago(5 * DAY), status: 'VOID', fen: 20_000n },
    { paid: ago(9 * DAY), received: ago(6 * DAY), status: 'CLAWED_BACK', fen: 40_000n },
    // paid in the window, not received
    { paid: ago(10 * DAY), received: null, status: 'ESTIMATED', fen: 80_000n },
    // paid in the window, received after t
    { paid: ago(10 * DAY), received: after, status: 'WAITING', fen: 160_000n },
    // received in the window, still ESTIMATED
    { paid: ago(10 * DAY), received: ago(7 * DAY), status: 'ESTIMATED', fen: 320_000n },
  ] as const;
  for (const row of excluded) {
    const order = await seedOrder(f, {
      paidAt: row.paid,
      receivedAt: row.received,
      buyType: 'self',
      rebateStatus: row.status,
    });
    await seedSplit(f, order, { version: 1, userId: me, role: 'self', amountFen: row.fen });
  }
  // Another member's own purchase, received and credited in the window.
  const theirs = await seedOrder(f, {
    paidAt: ago(3 * DAY),
    receivedAt: ago(DAY),
    buyType: 'self',
    rebateStatus: 'CREDITED',
    userId: stranger,
  });
  await seedSplit(f, theirs, { version: 1, userId: stranger, role: 'self', amountFen: 640_000n });
  await postOrderVoucher(f, theirs, {
    userId: stranger,
    role: 'self',
    kind: 'CREDIT',
    fen: 640_000n,
  });
  return { buyer, stranger };
}

/**
 * ④⑤ synced values fixture at t: five counted self-purchase sub-orders, each with distinct
 * (est_commission_fen, pay_amount_fen) — nulls and a zero base included — and one share order
 * that must not count. Returns the expected facts (any order).
 */
export async function seedCommissionOrders(f: Fixture): Promise<readonly SelfOrderFact[]> {
  type Row = SelfOrderFact & { readonly status: 'VOID' | 'WAITING' | 'ESTIMATED' };
  const rows: readonly Row[] = [
    { invalid: true, status: 'VOID', est_commission_fen: 6000n, commission_base_fen: 10000n },
    { invalid: false, status: 'WAITING', est_commission_fen: 4999n, commission_base_fen: 10001n },
    { invalid: false, status: 'ESTIMATED', est_commission_fen: null, commission_base_fen: 2500n },
    { invalid: false, status: 'ESTIMATED', est_commission_fen: 777n, commission_base_fen: null },
    { invalid: false, status: 'WAITING', est_commission_fen: 1n, commission_base_fen: 0n },
  ];
  for (const [index, row] of rows.entries()) {
    await seedOrder(f, {
      paidAt: ago((index + 1) * DAY),
      buyType: 'self',
      rebateStatus: row.status,
      estCommissionFen: row.est_commission_fen,
      payAmountFen: row.commission_base_fen,
    });
  }
  await seedOrder(f, {
    paidAt: ago(DAY),
    buyType: 'share',
    rebateStatus: 'WAITING',
    estCommissionFen: 99_999n,
    payAmountFen: 100_000n,
  });
  return rows.map(({ invalid, est_commission_fen, commission_base_fen }) => ({
    invalid,
    est_commission_fen,
    commission_base_fen,
  }));
}

/**
 * ④ order_rights fixture at t: one sub-order per case, two order_rights rows each where the case
 * says so; a reader that joins the rights row by row would count those sub-orders twice. Counted
 * 4, invalid 3.
 */
export async function seedDoubleRights(f: Fixture): Promise<void> {
  await seedOrder(f, {
    paidAt: ago(DAY),
    buyType: 'self',
    rebateStatus: 'WAITING',
    rights: ['FAILED', 'SUCCEEDED'],
  });
  await seedOrder(f, {
    paidAt: ago(2 * DAY),
    buyType: 'self',
    rebateStatus: 'CREDITED',
    rights: ['SUCCEEDED', 'SUCCEEDED'],
  });
  await seedOrder(f, {
    paidAt: ago(3 * DAY),
    buyType: 'self',
    rebateStatus: 'VOID',
    rights: ['SUCCEEDED'],
  });
  await seedOrder(f, {
    paidAt: ago(4 * DAY),
    buyType: 'self',
    rebateStatus: 'WAITING',
    rights: ['FAILED', 'PROCESSING'],
  });
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
