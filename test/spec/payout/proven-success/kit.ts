// B2-07e rule-test kit (claude-independent, SPEC_REF 37808a50): W11 of 规划/08 BR-WDR-08 (APPROVED
// → PAID_API, event CHANNEL_SUCCESS_PROVEN; guard: hold_reason payer_side_after_transfer, the one
// transfer attempt result=fail, the channel's proof — here the bill line naming the out_biz_no with
// amount = net_fen — and the switch payout.proven_success_writeoff.enabled = on, default on),
// BR-WDR-09 (WITHDRAW:SUCCESS:CASH_<channel> `wd:{id}:PAID`, one voucher), BR-WDR-07 (users row →
// ledger.lockBalances), BR-WDR-23 ③ 决-08 A; task §9.2 / §9.3 (D10-428: the attempt record of W11
// is appended by the payout process from a job queued on the W11 transaction).
// Real pieces: PostgreSQL through @couli/db/testing (couli_app for the business handle and seeds,
// couli_payout for the attempt rows and the attempt-append handler), ledger (createLedger), the
// event bus, identity's users lock. Synthetic: the withdrawals (INSERT plus their real
// WITHDRAW:FREEZE voucher, as W1 leaves them; W9 is B2-06d's), their attempts, the config rows and
// a recording job queue (the HTTP tests under test/spec/ledger/admin-recon-write-off use the real
// pg-boss). No real payee, merchant or channel data.
// Only *.int.test.ts files import the database parts; the factories under test are called inside
// each test, so red is the skeleton's NotImplemented.
import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { buildVouchers } from '@couli/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import { expect, vi } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import {
  createLedger,
  type Ledger,
  type PostingEntry,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createEventBus } from '../../../../apps/api/src/modules/platform/events/index.ts';
import type {
  JobHandler,
  JobPayload,
  ReceivedJob,
  SendOptions,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  createWithdrawalProvenSuccess,
  type ProveChannelSuccessInput,
  type ProveChannelSuccessResult,
  type ProvenBillLine,
} from '../../../../apps/api/src/modules/payout/application/withdrawal-proven-success.ts';
import type { PayoutConfigPort } from '../../../../apps/api/src/modules/payout/application/withdraw-rules.ts';
import { createAttemptAppendJob } from '../../../../apps/api/src/modules/payout/jobs/attempt-append-job.ts';
import { fund, seedUser } from '../apply/kit.ts';

/** 2026-10-29 16:00 +08:00 (the write-off), the day after the bill day. */
export const NOW = '2026-10-29T08:00:00.000Z';
export const MINUTE = 60_000;
export const TIMEOUT = 60_000;
/** The +08:00 accounting day of the bill that shows the transfer as successful. */
export const BILL_DATE = '2026-10-28';
/** 入账时间 of the bill line (2026-10-28 07:02:11 UTC). */
export const BOOKED_AT = '2026-10-28T15:02:11+08:00';
export const BOOKED_AT_MS = Date.parse(BOOKED_AT);
/** The channel's order id on the bill line (synthetic). */
export const CHANNEL_ORDER = '20261028110070001502110012345678';
export const PAYER_SIDE_HOLD = 'payer_side_after_transfer';
/** content's switch of W11 (BR-WDR-08 细则: default on). */
export const SWITCH = 'payout.proven_success_writeoff.enabled';
/** The payout process's queue of the W11 attempt records (task §9.3). */
export const ATTEMPT_QUEUE = 'payout-attempt-append';
/** Synthetic payee name of every seeded withdrawal (must never reach a log, audit or response). */
export const PAYEE_NAME = '合成姓名';
/** When W9 returned the seeded withdrawals (their hold_at and the failed transfer's time). */
export const RETURNED_AT = new Date(Date.parse(NOW) - 26 * 60 * MINUTE);

// ---------------------------------------------------------------------------------------------
// Database.

interface Database {
  urlFor(role: 'couli_app' | 'couli_payout'): string;
  drop(): Promise<void>;
}

export async function open(create: () => Promise<Database>) {
  const database = await create();
  const app = database.urlFor('couli_app');
  return {
    database,
    /** couli_app: the business handle of W11 and the seeds. */
    db: createDb({ connectionString: app, max: 8 }),
    /** couli_app: observations from another connection. */
    observer: createDb({ connectionString: app, max: 3 }),
    /** couli_payout: attempt seeds and the attempt-append handler. */
    payout: createDb({ connectionString: database.urlFor('couli_payout'), max: 3 }),
  };
}
export type Harness = Awaited<ReturnType<typeof open>>;

export async function close(h: Harness | undefined) {
  if (!h) return;
  await Promise.all([destroyDb(h.db), destroyDb(h.observer), destroyDb(h.payout)]);
  await h.database.drop();
}

// ---------------------------------------------------------------------------------------------
// Seeds shared with the HTTP tests (any couli_app handle `db`, couli_payout handle `payout`).

export interface Handles {
  /** couli_app. */
  readonly db: Kysely<DB>;
  /** couli_payout. */
  readonly payout: Kysely<DB>;
}

/** A synthetic member of `appId` with a ledger account holding `balance` available. */
export async function newMember(
  db: Kysely<DB>,
  ledger: Ledger,
  appId: string,
  balance = 100_000n,
): Promise<string> {
  const userId = await seedUser(db, appId);
  await fund(db, ledger, { appId, userId }, balance);
  return userId;
}

/** A config_items row of `appId` (content's table; couli_app may write it). */
export async function setConfig(db: Kysely<DB>, appId: string, key: string, value: unknown) {
  await sql`INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES (${appId}, ${key}, ${JSON.stringify(value)}::jsonb, 'synthetic')
    ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value,
      version = app.config_items.version + 1`.execute(db);
}

/** content's configuration reader as the payout jobs read it (plain row of config_items). */
export function configPort(): PayoutConfigPort {
  return {
    async configValue(app, key, handle) {
      return (
        (await handle
          .withSchema('app')
          .selectFrom('config_items')
          .select(['value', 'version'])
          .where('app_id', '=', app)
          .where('key', '=', key)
          .executeTakeFirst()) ?? null
      );
    },
  };
}

export type AttemptKind = 'transfer' | 'query';
export type AttemptResult = 'pending' | 'success' | 'fail' | 'unknown';

/** An attempt row as the payout process would have written it (couli_payout). */
export async function seedAttempt(
  payout: Kysely<DB>,
  appId: string,
  withdrawalId: string,
  kind: AttemptKind,
  result: AttemptResult,
  at: Date = RETURNED_AT,
): Promise<void> {
  const failed = result === 'fail';
  await sql`INSERT INTO app.payout_attempts
    (id, app_id, withdrawal_id, kind, request, response, resp_code, resp_sub_code, result, at)
    VALUES (${randomUUID()}, ${appId}, ${withdrawalId}, ${kind},
      ${JSON.stringify({ logon_id: 'log**********26' })}::jsonb,
      ${result === 'pending' ? null : JSON.stringify({ code: failed ? '40004' : '10000' })}::jsonb,
      ${result === 'pending' ? null : failed ? '40004' : '10000'},
      ${failed ? 'TEST_PAYER_SIDE' : null}, ${result}, ${at})`.execute(payout);
}

export type SeedStatus =
  'PENDING_REVIEW' | 'APPROVED' | 'PAYING' | 'PAID_API' | 'FAILED' | 'REJECTED';

export interface ReturnedSeed {
  readonly appId: string;
  readonly userId: string;
  readonly net?: bigint;
  readonly fee?: bigint;
  readonly tax?: bigint;
  /** Default APPROVED (W9 returned it). */
  readonly status?: SeedStatus;
  /** Default payer_side_after_transfer on APPROVED, null otherwise. */
  readonly holdReason?: string | null;
  /** Default one failed transfer (the payer-side failure W9 held). */
  readonly attempts?: readonly (readonly [AttemptKind, AttemptResult])[];
  readonly channel?: 'alipay' | 'bank_card';
}

export interface Seeded {
  readonly id: string;
  readonly appId: string;
  readonly userId: string;
  readonly outBizNo: string;
  readonly net: bigint;
  readonly fee: bigint;
  readonly tax: bigint;
  readonly amount: bigint;
  readonly status: SeedStatus;
}

/**
 * A withdrawal as W9 leaves it (default): APPROVED, hold_reason payer_side_after_transfer with
 * hold_at, executor cleared, batch and execute_seq kept, one failed transfer attempt; its amount
 * frozen by the real WITHDRAW:FREEZE `wd:{id}:FREEZE` (PENDING_REVIEW / APPROVED / PAYING only).
 */
export async function seedReturned(
  handles: Handles,
  ledger: Ledger,
  values: ReturnedSeed,
): Promise<Seeded> {
  const { db, payout } = handles;
  const id = randomUUID();
  const appId = values.appId;
  const net = values.net ?? 1000n;
  const fee = values.fee ?? 0n;
  const tax = values.tax ?? 0n;
  const amount = net + fee + tax;
  const status = values.status ?? 'APPROVED';
  const channel = values.channel ?? 'alipay';
  const holdReason =
    values.holdReason !== undefined
      ? values.holdReason
      : status === 'APPROVED'
        ? PAYER_SIDE_HOLD
        : null;
  const outBizNo = randomBytes(16).toString('hex');
  const batchId = randomUUID();
  const reviewedAt = new Date(RETURNED_AT.getTime() - 30 * MINUTE);
  const executed = status === 'PAYING' || status === 'PAID_API' || status === 'FAILED';
  await sql`INSERT INTO app.payout_batches (id, app_id, kind, created_by, created_at)
    VALUES (${batchId}, ${appId}, 'manual', 'finance:synthetic', ${reviewedAt})`.execute(db);
  await db.transaction().execute(async (trx) => {
    await sql`INSERT INTO app.withdrawals
      (id, app_id, user_id, amount_fen, fee_fen, tax_fen, net_fen, income_type, payout_method,
       payee_name, payee_account_cipher, payee_hmac, bank_name, status, out_biz_no,
       payout_channel, review_mode, reviewer_id, reviewed_at, reject_reason_code, executor_id,
       executed_at, batch_id, execute_seq, hold_reason, hold_at, paid_at, channel_order_id,
       fail_code, row_version, created_at, updated_at)
      VALUES (${id}, ${appId}, ${values.userId}, ${amount}, ${fee}, ${tax}, ${net}, 'SERVICE_FEE',
       ${channel}, ${PAYEE_NAME}, ${Buffer.from('synthetic-encrypted-account')},
       ${randomBytes(32).toString('hex')}, ${channel === 'bank_card' ? '合成银行' : null},
       ${status}, ${outBizNo}, ${channel}, 'manual',
       ${status === 'PENDING_REVIEW' ? null : randomUUID()},
       ${status === 'PENDING_REVIEW' ? null : reviewedAt},
       ${status === 'REJECTED' ? 'OTHER' : null}, ${executed ? randomUUID() : null},
       ${executed ? RETURNED_AT : null}, ${batchId}, ${status === 'PENDING_REVIEW' ? 0 : 1},
       ${holdReason}, ${holdReason === null ? null : RETURNED_AT},
       ${status === 'PAID_API' ? RETURNED_AT : null},
       ${status === 'PAID_API' ? `SEED${randomBytes(8).toString('hex')}` : null},
       ${status === 'FAILED' ? 'SEED_FAIL' : null}, 3, ${reviewedAt}, ${RETURNED_AT})`.execute(trx);
    if (status !== 'PENDING_REVIEW' && status !== 'APPROVED' && status !== 'PAYING') return;
    await lockUsersForUpdate(trx, { appId, userIds: [values.userId] });
    const [balance] = await ledger.lockBalances(trx, { appId, userIds: [values.userId] });
    const [built] = buildVouchers('WITHDRAW:FREEZE', {
      withdrawal_id: id,
      user_id: values.userId,
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
    await ledger.post(trx, {
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
  for (const [kind, result] of values.attempts ?? [['transfer', 'fail'] as const]) {
    await seedAttempt(payout, appId, id, kind, result);
  }
  return { id, appId, userId: values.userId, outBizNo, net, fee, tax, amount, status };
}

/** The bill line of `w` as the R2 reconciliation stored it (resolution.bill_line). */
export function billLineJson(
  w: Pick<Seeded, 'outBizNo' | 'net'>,
  overrides: Record<string, string | null> = {},
): Record<string, string | null> {
  return {
    out_biz_no: w.outBizNo,
    channel_order_id: CHANNEL_ORDER,
    amount_fen: w.net.toString(),
    status: 'SUCCESS',
    booked_at: BOOKED_AT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Observations (any couli_app handle).

export type WithdrawalRow = Awaited<ReturnType<typeof withdrawalRow>>;

export function withdrawalRow(db: Kysely<DB>, appId: string, id: string) {
  return db
    .withSchema('app')
    .selectFrom('withdrawals')
    .selectAll()
    .where('app_id', '=', appId)
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

export function attemptRows(db: Kysely<DB>, appId: string, withdrawalId: string) {
  return db
    .withSchema('app')
    .selectFrom('payout_attempts')
    .selectAll()
    .where('app_id', '=', appId)
    .where('withdrawal_id', '=', withdrawalId)
    .orderBy('at')
    .orderBy('id')
    .execute();
}

/** The uniq keys of the app's withdrawal vouchers. */
export async function withdrawalVouchers(db: Kysely<DB>, appId: string): Promise<string[]> {
  const rows = await db
    .withSchema('app')
    .selectFrom('ledger_vouchers')
    .select('uniq_key')
    .where('app_id', '=', appId)
    .where('uniq_key', 'like', 'wd:%')
    .orderBy('uniq_key')
    .execute();
  return rows.map((row) => row.uniq_key);
}

/** One voucher of the app by its uniq key (operator and biz columns). */
export function voucherOf(db: Kysely<DB>, appId: string, uniqKey: string) {
  return db
    .withSchema('app')
    .selectFrom('ledger_vouchers')
    .select(['uniq_key', 'biz_type', 'biz_id', 'operator'])
    .where('app_id', '=', appId)
    .where('uniq_key', '=', uniqKey)
    .execute();
}

export interface EntryRow {
  owner_type: string;
  subject: string;
  sub_account: string;
  amount_fen: bigint;
  ledger_type: string;
}

/** The entries of the voucher `uniqKey` (by ledger type, then owner, then sign). */
export async function entries(db: Kysely<DB>, appId: string, uniqKey: string): Promise<EntryRow[]> {
  const result = await sql<EntryRow>`
    SELECT a.owner_type, a.subject, e.sub_account, e.amount_fen, e.ledger_type
    FROM app.ledger_vouchers v
    JOIN app.ledger_entries e ON e.voucher_id = v.id AND e.app_id = v.app_id
    JOIN app.ledger_accounts a ON a.id = e.account_id
    WHERE v.app_id = ${appId} AND v.uniq_key = ${uniqKey}
    ORDER BY e.ledger_type, a.owner_type DESC, a.subject, e.amount_fen DESC`.execute(db);
  return result.rows;
}

/** The entries WITHDRAW:SUCCESS:CASH_ALIPAY must post for `w` (zero lines dropped). */
export function paidEntries(w: Pick<Seeded, 'net' | 'fee' | 'tax'>): EntryRow[] {
  const user = (amount: bigint, ledgerType: string): EntryRow => ({
    owner_type: 'user',
    subject: 'USER_BALANCE',
    sub_account: 'frozen',
    amount_fen: amount,
    ledger_type: ledgerType,
  });
  const platform = (subject: string, amount: bigint, ledgerType: string): EntryRow => ({
    owner_type: 'platform',
    subject,
    sub_account: 'available',
    amount_fen: amount,
    ledger_type: ledgerType,
  });
  return [
    ...(w.tax > 0n
      ? [user(w.tax, 'TAX_WITHHOLD'), platform('TAX_PAYABLE', -w.tax, 'TAX_WITHHOLD')]
      : []),
    ...(w.fee > 0n
      ? [user(w.fee, 'WITHDRAW_FEE'), platform('FEE_INCOME', -w.fee, 'WITHDRAW_FEE')]
      : []),
    user(w.net, 'WITHDRAW_PAID'),
    platform('CASH_ALIPAY', -w.net, 'WITHDRAW_PAID'),
  ];
}

export async function balanceOf(db: Kysely<DB>, ledger: Ledger, appId: string, userId: string) {
  const [row] = await ledger.getBalances(db, { appId, userIds: [userId] });
  if (row === undefined) throw new Error('no balance row');
  return { available_fen: row.available_fen, frozen_fen: row.frozen_fen };
}

/** wallet.withdrawal_changed events of the app (the envelope's data only). */
export async function changes(db: Kysely<DB>, appId: string) {
  const rows = await db
    .withSchema('app')
    .selectFrom('event_log')
    .select('payload')
    .where('app_id', '=', appId)
    .where('name', '=', 'wallet.withdrawal_changed')
    .orderBy('id')
    .execute();
  return rows.map((row) => (row.payload as unknown as { data: Record<string, unknown> }).data);
}

/**
 * The frozen invariant (BR-WDR-09: 冻结金额留在 frozen 子户直到终态): for every member of the app,
 * frozen_fen equals the amounts of their withdrawals not yet final (PENDING_REVIEW / APPROVED /
 * PAYING). Returns the members where it does not hold (empty when it holds).
 */
export async function frozenMismatches(db: Kysely<DB>, appId: string) {
  const result = await sql<{ user_id: string; frozen_fen: string; open_fen: string }>`
    SELECT a.owner_id AS user_id, b.frozen_fen::text AS frozen_fen,
      COALESCE((SELECT sum(w.amount_fen) FROM app.withdrawals w
        WHERE w.app_id = a.app_id AND w.user_id::text = a.owner_id
          AND w.status IN ('PENDING_REVIEW', 'APPROVED', 'PAYING')), 0)::text AS open_fen
    FROM app.ledger_accounts a
    JOIN app.account_balances b ON b.app_id = a.app_id AND b.account_id = a.id
    WHERE a.app_id = ${appId} AND a.owner_type = 'user'`.execute(db);
  return result.rows.filter((row) => row.frozen_fen !== row.open_fen);
}

/** Everything W11 may write, for this app (attempts included: W11 itself appends none). */
export async function snapshot(db: Kysely<DB>, appId: string) {
  return {
    withdrawals: await db
      .withSchema('app')
      .selectFrom('withdrawals')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    attempts: await db
      .withSchema('app')
      .selectFrom('payout_attempts')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    vouchers: await withdrawalVouchers(db, appId),
    balances: await db
      .withSchema('app')
      .selectFrom('account_balances')
      .select(['account_id', 'available_fen', 'frozen_fen'])
      .where('app_id', '=', appId)
      .orderBy('account_id')
      .execute(),
    events: await db
      .withSchema('app')
      .selectFrom('event_log')
      .select(['name', 'payload'])
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}

// ---------------------------------------------------------------------------------------------
// One app of the payout-level tests.

export interface Sent {
  readonly queue: string;
  readonly name: string;
  readonly payload: JobPayload;
  readonly options: SendOptions;
}

export interface AppendLogger {
  readonly info: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly error: ReturnType<typeof vi.fn>;
}

export async function setup(h: Harness) {
  const appId = `w11_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const clock = new FixedClock(NOW);
  const ledger = createLedger({ clock });
  const operatorId = randomUUID();
  /** Every send of the recording job queue (the event bus has no subscriptions: sends none). */
  const sent: Sent[] = [];
  const queue = {
    send: vi.fn(async (q: string, name: string, payload: JobPayload, options: SendOptions) => {
      sent.push({ queue: q, name, payload, options });
      return randomUUID();
    }),
  };
  const eventBus = createEventBus({ clock, queue, subscriptions: [] });
  const logger: AppendLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handles: Handles = { db: h.db, payout: h.payout };
  const userId = await newMember(h.db, ledger, appId);

  /** W11's port on the fixture's ledger, users lock, config, recording queue and event bus. */
  function port() {
    return createWithdrawalProvenSuccess({
      ledger,
      lockUsersForUpdate,
      config: configPort(),
      queue,
      eventBus,
    });
  }

  /** The bill line of `w` as the port receives it. */
  function billLine(w: Pick<Seeded, 'outBizNo'>, patch: Partial<ProvenBillLine> = {}) {
    return {
      billDate: BILL_DATE,
      outBizNo: w.outBizNo,
      channelOrderId: CHANNEL_ORDER,
      bookedAt: BOOKED_AT,
      ...patch,
    } satisfies ProvenBillLine;
  }

  function input(
    w: Seeded,
    patch: Partial<Omit<ProveChannelSuccessInput, 'billLine'>> & {
      readonly billLine?: Partial<ProvenBillLine>;
    } = {},
  ): ProveChannelSuccessInput {
    const { billLine: line, ...rest } = patch;
    return {
      appId: w.appId,
      withdrawalId: w.id,
      reconDiffId: randomUUID(),
      expectedFen: w.net,
      operatorId,
      now: clock.now(),
      ...rest,
      billLine: billLine(w, line),
    };
  }

  /**
   * W11 on a transaction of its own (the port is built first: red is the skeleton's
   * NotImplemented). The transaction commits when the port returns, rolls back when it throws.
   */
  async function prove(
    request: ProveChannelSuccessInput,
    built = port(),
  ): Promise<ProveChannelSuccessResult> {
    return h.db
      .transaction()
      .execute((trx: Transaction<DB>) => built.proveChannelSuccess(trx, request));
  }

  /** The payout process's attempt-append handler on couli_payout. */
  function appendJob(): JobHandler {
    return createAttemptAppendJob({ db: h.payout, clock, logger });
  }

  /** The job W11 queued, as the payout process receives it (attempt 1 unless given). */
  function received(item: Sent, attempt = 1): ReceivedJob {
    return Object.freeze({
      id: randomUUID(),
      queue: item.queue,
      name: item.name,
      payload: item.payload,
      attempt,
    });
  }

  return {
    h,
    appId,
    clock,
    ledger,
    operatorId,
    userId,
    sent,
    queue,
    logger,
    handles,
    set: (key: string, value: unknown) => setConfig(h.db, appId, key, value),
    member: (balance?: bigint) => newMember(h.db, ledger, appId, balance),
    seed: (values: Omit<ReturnedSeed, 'appId' | 'userId'> & { readonly userId?: string } = {}) =>
      seedReturned(handles, ledger, { userId, ...values, appId }),
    port,
    billLine,
    input,
    prove,
    appendJob,
    received,
    snapshot: () => snapshot(h.observer, appId),
  };
}
export type Fixture = Awaited<ReturnType<typeof setup>>;

/** The sends of the fixture's queue on the attempt-append queue. */
export function appendSends(f: Fixture): Sent[] {
  return f.sent.filter((item) => item.queue === ATTEMPT_QUEUE);
}

/** `run` rejects with W11's conflict: 20902, data.resource=withdrawal. */
export async function expectWithdrawalConflict(run: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'W11 must throw the withdrawal conflict').toBeInstanceOf(Error);
  expect(caught).toMatchObject({ code: 20902, data: { resource: 'withdrawal' } });
}
