// Database fixtures of the B1-03z rule tests: synthetic rows only (users, order_keys, the split
// snapshot of commission, its share events, the FORFEIT vouchers of the forfeitures, appeals). No
// implementation code computes an expected value. Each test makes its own app_id, so tests sharing
// one database never see each other.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { PostgresQueryCompiler, type Kysely, type KyselyPlugin } from 'kysely';
import { expect } from 'vitest';
// By file path, not commission/index.ts: the index reaches identity's decorated controllers.
import {
  findBannedRunStart,
  listBannedForfeitedShares,
} from '../../../../apps/api/src/modules/commission/application/forfeited-shares.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { ReceivedEvent } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createAppealRestoreHandler,
  type AppealRestoreLogger,
  type ForfeitedAmountPort,
} from '../../../../apps/api/src/modules/risk/application/appeal-restore.ts';
import {
  APPEAL_AT,
  CLOSED_AT,
  DEADLINE_AT,
  NOW,
  ORDER_AT,
  PENALTY_AT,
  PERIOD,
  REF_ID_MAX,
  RESTORE_SOURCES,
  forfeitKey,
  resolvedEvent,
  type AppealResolvedData,
  type ShareRole,
} from './kit.ts';

/**
 * Test double of the ledger read the producer is given (ForfeitedAmountPort, review S0): what the
 * share's FORFEIT voucher `{order_key}:PLATFORM:FORFEIT:{uid}:{role}` booked to COMMISSION_REVENUE
 * (its credit line, stored negative: debit positive), read from the rows the fixture wrote; null
 * when there is no such voucher. Runs on the handle it is given (the consumer's transaction).
 */
export const voucherForfeitedAmount: ForfeitedAmountPort = async (trx, input) => {
  const voucher = await trx
    .selectFrom('ledger_vouchers')
    .select('id')
    .where('app_id', '=', input.appId)
    .where('uniq_key', '=', `${input.orderKey}:PLATFORM:FORFEIT:${input.userId}:${input.role}`)
    .executeTakeFirst();
  if (voucher === undefined) return null;
  const lines = await trx
    .selectFrom('ledger_entries')
    .innerJoin('ledger_accounts', 'ledger_accounts.id', 'ledger_entries.account_id')
    .select('ledger_entries.amount_fen')
    .where('ledger_entries.app_id', '=', input.appId)
    .where('ledger_entries.voucher_id', '=', voucher.id)
    .where('ledger_accounts.subject', '=', 'COMMISSION_REVENUE')
    .execute();
  return lines.reduce((sum, line) => sum - line.amount_fen, 0n);
};

/** The ports the worker assembly gives the producer (RiskScanModule.forWorker). */
export const PORTS = {
  shares: listBannedForfeitedShares,
  bannedRunStart: findBannedRunStart,
  forfeitedAmount: voucherForfeitedAmount,
} as const;

/** The China (+08:00) calendar date of an instant, for ledger_vouchers.accounting_date. */
function chinaDate(at: Date): string {
  return new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

// Structural type instead of importing @couli/db/testing: only *.int.test.ts may import it
// (.dependency-cruiser.cjs testcontainers-only-in-int-tests); the int test passes its factory.
interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export async function openSuite(createTestDatabase: () => Promise<TestDatabase>) {
  const database = await createTestDatabase();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  return {
    db,
    async close() {
      try {
        await destroyDb(db);
      } finally {
        await database.drop();
      }
    },
  };
}
export type Suite = Awaited<ReturnType<typeof openSuite>>;

export interface SharePerson {
  readonly userId: string;
  readonly role: ShareRole;
  /** commission_split_amounts.amount_fen of the only commission version (1). */
  readonly amountFen: bigint;
}

export interface OrderOptions {
  /** created_at of the snapshot and of its initial active events (default ORDER_AT). */
  readonly at?: Date;
  /** order_keys.sub_order_id (default `appeal-restore-<order_id>`). */
  readonly subOrderId?: string;
}

export interface AppealInput {
  readonly userId: string | null;
  readonly targetType?: 'account' | 'order' | 'blocked_request';
  readonly status?: 'revoked' | 'upheld';
  readonly prev?: 'banned' | 'frozen';
  /** Account appeals only; null: a row from before the column (B1-03v). */
  readonly penaltyStartedAt?: Date | null;
  readonly requestType?: 'register' | 'withdraw';
  readonly targetId?: string;
  /** appeals.created_at (default APPEAL_AT). */
  readonly createdAt?: Date;
  /** appeals.closed_at (default CLOSED_AT). */
  readonly closedAt?: Date;
}

export interface Appeal {
  readonly id: string;
  readonly data: AppealResolvedData;
}

/**
 * The restore difference expected for one (sub-order, member) of one appeal (task brief 9.2 ④;
 * attempt 4, review S2: the member's roles on that sub-order are one difference).
 */
export interface ExpectedRestore {
  readonly appealId: string;
  readonly orderId: string;
  readonly userId: string;
  /** The member's forfeited role(s) on the sub-order. */
  readonly role: ShareRole | readonly ShareRole[];
  /** Σ of what the member's FORFEIT vouchers on the sub-order booked to the platform. */
  readonly amountFen: bigint;
  /**
   * 'order_key' (default): ref_id is the order key. 'member': another difference already holds
   * the order key in the period, so ref_id is the order key with a member-specific `#` suffix.
   */
  readonly ref?: 'order_key' | 'member';
}

/** A short sub_order_id (order_keys' primary key is (platform, sub_order_id), across apps). */
export function shortSubOrderId(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

const N_FEN = 1000n;
const BASE_FEN = 850n;

export async function scenario(suite: Suite) {
  const db = suite.db;
  const appId = `appeal-restore-${randomUUID()}`;
  const ruleVersionId = randomUUID();
  await db
    .insertInto('commission_rule_versions')
    .values({
      app_id: appId,
      rule_version_id: ruleVersionId,
      status: 'published',
      effective_from: ORDER_AT,
      indirect_enabled: true,
      created_at: ORDER_AT,
    })
    .execute();
  const clock = new FixedClock(NOW);
  /** order_id → order key `{platform}:{sub_order_id}`. */
  const orderKeys = new Map<string, string>();
  /** `${order_id}:${user_id}:${role}` → the snapshot's amount_fen. */
  const snapshotFen = new Map<string, bigint>();
  /** subject → the platform ledger account of this app. */
  const platformAccounts = new Map<string, string>();
  /** uniq_key of every FORFEIT voucher written in this app. */
  const bookedForfeits = new Set<string>();

  function keyOf(orderId: string): string {
    const key = orderKeys.get(orderId);
    if (key === undefined) throw new Error(`fixture: unknown order ${orderId}`);
    return key;
  }

  async function platformAccount(subject: string): Promise<string> {
    const known = platformAccounts.get(subject);
    if (known !== undefined) return known;
    const id = randomUUID();
    await db
      .insertInto('ledger_accounts')
      .values({
        id,
        app_id: appId,
        owner_type: 'platform',
        owner_id: 'platform',
        subject,
        created_at: ORDER_AT,
      })
      .execute();
    platformAccounts.set(subject, id);
    return id;
  }

  /**
   * The FORFEIT voucher of one forfeited share as settlement's first credit books it
   * (specs/ledger-templates.csv FORFEIT: debit UNION_RECEIVABLE:{platform}, credit
   * COMMISSION_REVENUE, REBATE_CREDIT; memo forfeit_reason=<reason>; debit positive).
   */
  async function forfeitVoucher(
    orderId: string,
    userId: string,
    role: ShareRole,
    reason: 'banned' | 'deleted' | 'minor',
    amountFen: bigint,
    at: Date,
  ): Promise<void> {
    const orderKey = keyOf(orderId);
    const uniqKey = forfeitKey(orderKey, userId, role);
    // The ledger books one FORFEIT voucher per share (UNIQUE (app_id, uniq_key)): a later
    // forfeiture of the same share books nothing, the first voucher stands.
    if (bookedForfeits.has(uniqKey)) return;
    bookedForfeits.add(uniqKey);
    const voucherId = randomUUID();
    await db
      .insertInto('ledger_vouchers')
      .values({
        id: voucherId,
        app_id: appId,
        biz_type: 'ORDER_CREDIT',
        biz_id: orderKey,
        uniq_key: uniqKey,
        accounting_date: chinaDate(at),
        operator: 'system',
        memo: `forfeit_reason=${reason}`,
        order_key: orderKey,
        beneficiary_user_id: null,
        role: null,
        voucher_kind: 'FORFEIT',
        created_at: at,
      })
      .execute();
    const receivable = await platformAccount('UNION_RECEIVABLE:taobao');
    const revenue = await platformAccount('COMMISSION_REVENUE');
    await db
      .insertInto('ledger_entries')
      .values(
        [
          { account_id: receivable, amount_fen: amountFen },
          { account_id: revenue, amount_fen: -amountFen },
        ].map((line) => ({
          app_id: appId,
          voucher_id: voucherId,
          account_id: line.account_id,
          sub_account: 'available',
          amount_fen: line.amount_fen,
          ledger_type: 'REBATE_CREDIT',
          sub_type: null,
          income_type: null,
          balance_after_fen: null,
          account_version: null,
          booked_at: at,
          created_at: at,
        })),
      )
      .execute();
  }

  async function user(): Promise<string> {
    const id = randomUUID();
    await db
      .insertInto('users')
      .values({
        id,
        app_id: appId,
        nickname: 'fixture',
        avatar: 'fixture',
        invite_code: randomUUID(),
        attr_code: randomUUID(),
        level: 'L1',
        register_method: 'sms',
      })
      .execute();
    return id;
  }

  /** One sub-order with its split snapshot (version 1) and an initial active event per person. */
  async function order(
    people: readonly SharePerson[],
    options: OrderOptions = {},
  ): Promise<string> {
    const orderId = randomUUID();
    const at = options.at ?? ORDER_AT;
    const subOrderId = options.subOrderId ?? `appeal-restore-${orderId}`;
    await db
      .insertInto('order_keys')
      .values({
        app_id: appId,
        order_id: orderId,
        platform: 'taobao',
        sub_order_id: subOrderId,
        attr_at: at,
      })
      .execute();
    orderKeys.set(orderId, `taobao:${subOrderId}`);
    for (const p of people) snapshotFen.set(`${orderId}:${p.userId}:${p.role}`, p.amountFen);
    const userTotal = people.reduce((sum, p) => sum + p.amountFen, 0n);
    await db
      .insertInto('commission_splits')
      .values({
        app_id: appId,
        order_id: orderId,
        rule_version_id: ruleVersionId,
        order_type: people.some((p) => p.role === 'share') ? 'share' : 'self',
        activity_type: null,
        rebate_mode: null,
        paid_at: at,
        paid_at_source: 'platform',
        raw_n_fen: N_FEN,
        subsidy_commission_fen: 0n,
        reserve_bp: 1500,
        reserve_fen: N_FEN - BASE_FEN,
        tlj_deduct_fen: 0n,
        base_fen: BASE_FEN,
        platform_retain_fen: BASE_FEN - userTotal,
        beneficiaries: JSON.stringify(
          people.map((p) => ({
            user_id: p.userId,
            role: p.role,
            ratio_bp: 1000,
            level: 'L1',
            initial_status: 'active',
            forfeit_reason: null,
          })),
        ),
        created_at: at,
      })
      .execute();
    await db
      .insertInto('commission_split_totals')
      .values({
        app_id: appId,
        order_id: orderId,
        commission_version: 1,
        n_total_fen: N_FEN,
        pre_base_deduct_fen: N_FEN - BASE_FEN,
        base_fen: BASE_FEN,
        user_share_total_fen: userTotal,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: N_FEN - userTotal,
        created_at: at,
      })
      .execute();
    await db
      .insertInto('commission_split_amounts')
      .values(
        people.map((p) => ({
          app_id: appId,
          order_id: orderId,
          commission_version: 1,
          user_id: p.userId,
          role: p.role,
          base_fen: BASE_FEN,
          amount_fen: p.amountFen,
          created_at: at,
        })),
      )
      .execute();
    for (const p of people) {
      await shareEvent(orderId, p.userId, p.role, 'active', null, at);
    }
    return orderId;
  }

  async function shareEvent(
    orderId: string,
    userId: string,
    role: ShareRole,
    status: 'active' | 'held' | 'forfeited',
    reason: 'banned' | 'deleted' | 'minor' | null,
    at: Date,
  ): Promise<void> {
    await db
      .insertInto('commission_split_beneficiary_events')
      .values({
        app_id: appId,
        order_id: orderId,
        user_id: userId,
        role,
        status,
        reason,
        created_at: at,
      })
      .execute();
  }

  /**
   * A forfeiture of one share as settlement's first credit records it (BR-CALC-13): the forfeited
   * event with its forfeit_reason and the FORFEIT voucher booking `bookedFen` to the platform.
   * bookedFen: undefined → the snapshot's amount of the share; null → no voucher (a forfeiture
   * whose voucher the ledger does not have).
   */
  async function forfeit(
    orderId: string,
    p: Pick<SharePerson, 'userId' | 'role'>,
    reason: 'banned' | 'deleted' | 'minor',
    at: Date,
    bookedFen?: bigint | null,
  ): Promise<void> {
    await shareEvent(orderId, p.userId, p.role, 'forfeited', reason, at);
    if (bookedFen === null) return;
    const snapshot = snapshotFen.get(`${orderId}:${p.userId}:${p.role}`);
    const amount = bookedFen ?? snapshot;
    if (amount === undefined) throw new Error('fixture: forfeiture of a share not in the snapshot');
    await forfeitVoucher(orderId, p.userId, p.role, reason, amount, at);
  }

  /** A closed appeal row (risk's appeals) and the appeal.resolved data of its closing. */
  async function appeal(input: AppealInput): Promise<Appeal> {
    const id = randomUUID();
    const targetType = input.targetType ?? 'account';
    const status = input.status ?? 'revoked';
    const account = targetType === 'account';
    const requestType = targetType === 'blocked_request' ? (input.requestType ?? 'withdraw') : null;
    const targetId =
      input.targetId ?? (account && input.userId !== null ? input.userId : randomUUID());
    await db
      .insertInto('appeals')
      .values({
        id,
        app_id: appId,
        user_id: input.userId,
        target_type: targetType,
        request_type: requestType,
        target_id: targetId,
        // Low-entropy placeholder: never a real HMAC.
        related_phone_hmac: requestType === 'register' ? 'plain-plain-plain-plain' : null,
        prev_risk_state: account ? (input.prev ?? 'banned') : null,
        status,
        content: 'fixture appeal content',
        deadline_at: DEADLINE_AT,
        handler_id: 'fixture-admin',
        closed_at: input.closedAt ?? CLOSED_AT,
        created_at: input.createdAt ?? APPEAL_AT,
        updated_at: input.closedAt ?? CLOSED_AT,
        penalty_started_at: account
          ? input.penaltyStartedAt === undefined
            ? PENALTY_AT
            : input.penaltyStartedAt
          : null,
      })
      .execute();
    return {
      id,
      data: {
        app_id: appId,
        appeal_id: id,
        user_id: input.userId,
        target_type: targetType,
        target_id: targetId,
        status,
        need_reauth: false,
      },
    };
  }

  /**
   * The SUT, created in the test body so that every case fails on the skeleton. Its ports are the
   * worker assembly's (RiskScanModule.forWorker): commission's listBannedForfeitedShares and
   * findBannedRunStart, and the FORFEIT voucher amount (test double over the fixture's vouchers).
   */
  function handler(logger?: AppealRestoreLogger) {
    return createAppealRestoreHandler({
      clock,
      ...PORTS,
      ...(logger === undefined ? {} : { logger }),
    });
  }

  return {
    db,
    appId,
    clock,
    user,
    order,
    shareEvent,
    forfeit,
    appeal,
    /** The order key `{platform}:{sub_order_id}` of a fixture order. */
    orderKey: keyOf,
    event(a: Appeal, eventId?: string): ReceivedEvent {
      const received = resolvedEvent(a.data);
      return eventId === undefined ? received : { ...received, eventId };
    },
    handler,
    /** Delivers one event directly to a new handler on one transaction of the suite. */
    async deliver(received: ReceivedEvent): Promise<void> {
      const handle = handler();
      await db.transaction().execute((trx) => handle(received, trx));
    },
    /** recon_diffs of this app, smallest expected amount first. */
    async diffs(handle: Kysely<DB> = db) {
      return handle
        .selectFrom('recon_diffs')
        .selectAll()
        .where('app_id', '=', appId)
        .orderBy('expected_fen')
        .orderBy('id')
        .execute();
    },
    /** Everything the producer must never write: ledger, share events, obligations, appeals. */
    async untouched() {
      return {
        accounts: await db
          .selectFrom('ledger_accounts')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('id')
          .execute(),
        balances: await db
          .selectFrom('account_balances')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('account_id')
          .execute(),
        vouchers: await db
          .selectFrom('ledger_vouchers')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('id')
          .execute(),
        entries: await db
          .selectFrom('ledger_entries')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('id')
          .execute(),
        events: await db
          .selectFrom('commission_split_beneficiary_events')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('event_seq')
          .execute(),
        credits: await db
          .selectFrom('beneficiary_credits')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('beneficiary_credit_id')
          .execute(),
        appeals: await db
          .selectFrom('appeals')
          .selectAll()
          .where('app_id', '=', appId)
          .orderBy('id')
          .execute(),
      };
    },
  };
}
export type Scenario = Awaited<ReturnType<typeof scenario>>;

type DiffRow = Awaited<ReturnType<Scenario['diffs']>>[number];

/**
 * One appeal_restore row of a (sub-order, member) (task brief 9.2 ④; contracts AdminReconDiff:
 * diff_fen = expected_fen − actual_fen; attempt 4, review S0 / S2): registered open, ref_type
 * order and ref_id the order key (or, when another difference holds it in the period, the order
 * key with a member-specific `#` suffix, at most 64 characters), expected = what the member's
 * FORFEIT vouchers booked, actual 0, dedupe key naming app, order, user, every role and appeal.
 * Source and period are the implementation's (written down there): only their shapes are checked.
 */
export function expectRestore(
  row: DiffRow | undefined,
  f: { readonly appId: string; orderKey(orderId: string): string },
  share: ExpectedRestore,
) {
  expect(row).toMatchObject({
    app_id: f.appId,
    type: 'appeal_restore',
    ref_type: 'order',
    expected_fen: share.amountFen,
    actual_fen: 0n,
    diff_fen: share.amountFen,
    status: 'open',
    handler_id: null,
    closed_at: null,
  });
  const orderKey = f.orderKey(share.orderId);
  if ((share.ref ?? 'order_key') === 'order_key') {
    expect(row?.ref_id).toBe(orderKey);
  } else {
    expect(row?.ref_id.startsWith(`${orderKey}#`)).toBe(true);
    expect(row?.ref_id.length).toBeLessThanOrEqual(REF_ID_MAX);
  }
  expect(RESTORE_SOURCES).toContain(row?.source);
  expect(row?.period).toMatch(PERIOD);
  const key = row?.dedupe_key;
  expect(typeof key).toBe('string');
  const roles: readonly ShareRole[] = typeof share.role === 'string' ? [share.role] : share.role;
  for (const part of [f.appId, share.orderId, share.userId, ...roles, share.appealId]) {
    expect(key).toContain(part);
  }
}

/** Real database error on an insert into `table`, with no DDL or privileged connection. */
export function failInsert(table: 'recon_diffs') {
  let fired = false;
  // Kysely forbids a plugin from changing the node kind, so the matching insert runs and its
  // result is replaced by PostgreSQL's division-by-zero error (22012): the caller's transaction
  // still fails and rolls back.
  const matched = new Set<unknown>();
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      const statement = new PostgresQueryCompiler().compileQuery(args.node, args.queryId).sql;
      if (new RegExp(`\\binsert\\s+into\\s+(?:"?app"?\\.)?"?${table}"?\\b`, 'i').test(statement)) {
        matched.add(args.queryId);
      }
      return args.node;
    },
    async transformResult(args) {
      if (matched.delete(args.queryId)) {
        fired = true;
        throw Object.assign(new Error('division by zero'), { code: '22012' });
      }
      return args.result;
    },
  };
  return { fired: () => fired, plugin };
}
