// B2-02p rule-test kit (claude-independent, SPEC_REF 37808a50): the execution step of the daily
// ledger check, 08 BR-FUND-19 (账户级差异：告警、生成差错单、冻结涉及用户提现；全局差异：另将
// settle.auto.enabled 置 off；冻结 = 每个涉及用户新增 1 条 withdraw_holds，reason ledger_mismatch，
// source_ref 差错单；同一差错单对同一用户只新增 1 条) and BR-WDR-05 (R2 与日终校验只追加 withdraw_holds).
// Conventions from the task brief (编排 10-30, ops/tasks/B2-02p.yaml): recon diff type
// ledger_mismatch, source R3, period = the checked day D, status open; ref_type ledger_account
// (account level, ledger_accounts.id) / voucher (②) / order (③④⑤⑧⑨, order_key); ref_id
// `<invariant>:<entity id>`; dedupe_key `R3:<D>:<invariant>:<entity id>`; paired amounts of the
// detail as expected / actual (diff = expected − actual, contract AdminReconDiff), else 0 / 0 / 0;
// the detail kept in resolution; holds only for non pay- differences, in the diff's transaction and
// only when that call inserted the diff, source_ref exactly `recon_diff:<id>`, created_by system;
// settle.auto.enabled switched off once per app with a non pay- global difference, alerted after
// the commit; pay- differences (D10-358 ②) only registered.
// Real pieces: PostgreSQL through @couli/db/testing as couli_app (recon_diffs written through the
// executor, ledger_accounts / vouchers / entries / users as fixtures). Synthetic: the two injected
// ports — the payout hold port writes the withdraw_holds row on the transaction it is given (as
// payout's WithdrawHolds.add does, without its audit) so a roll-back is observable, and records
// whether the diff it points at was visible inside that transaction and from another connection;
// the content switch port records its calls, takes a transaction-scoped advisory lock and, when
// alerted, checks from another connection that the lock (its transaction) is gone. The differences
// are written by hand in the unified invariant output shape of db/invariants/ledger (detail keys
// as the SQL files emit them). No real user data.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely, type Selectable } from 'kysely';
import { expect } from 'vitest';
import {
  createDailyCheckExecutor,
  type AutoSettlementSwitch,
  type AutoSettlementSwitchInput,
  type AutoSettlementSwitchResult,
  type DailyCheckExecution,
  type DailyCheckExecutor,
  type DailyCheckFiledDifference,
  type LedgerMismatchHoldInput,
  type LedgerMismatchHolds,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';

export const DAY = '2032-06-15';
export const NEXT_DAY = '2032-06-16';
export const APP = 'dce-app-a';
export const OTHER = 'dce-app-b';
/** 2032-06-16 01:00 +08:00: the scheduled run for D = 2032-06-15. */
export const NOW = '2032-06-15T17:00:00.000Z';
export const TIMEOUT = 60_000;
export const SWITCH_KEY = 'settle.auto.enabled';

/** content's SystemSwitchWriter source format (F1-02zk): snake case, at most 32 characters. */
export const SWITCH_SOURCE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
export const SWITCH_SOURCE_MAX = 32;
/** content's reason limit (code points) and no control characters. */
export const SWITCH_REASON_MAX = 200;

/** Real file names of db/invariants/ledger (the pay- prefix is decided by the file name). */
export const FILES = {
  '01': '01_user-balances.sql',
  '02': '02_voucher-balanced.sql',
  '03': '09_credit-unique-net.sql',
  '05': '05_union-receivable.sql',
  '07': '07_negative-balance-drops.sql',
  'pay-01': 'pay-01_voucher-no-user-balance.sql',
  'pay-04': 'pay-04_suspense-equals-open-anomalies.sql',
} as const;

export type DiffRow = Selectable<DB['recon_diffs']>;
export type HoldRow = Selectable<DB['withdraw_holds']>;

export interface LogLine {
  readonly level: 'warn' | 'error';
  readonly fields: Record<string, unknown>;
}

export interface HoldCall {
  readonly input: LedgerMismatchHoldInput;
  /** The diff named by sourceRef, read through the transaction the port was given. */
  readonly diffInTransaction: boolean;
  /** The same diff read from another connection at that moment (false while uncommitted). */
  readonly diffOutside: boolean;
}

export interface FakeHolds extends LedgerMismatchHolds {
  readonly calls: HoldCall[];
  /** 0-based index (over all calls) of the call that throws; null: none throws. */
  failAt: number | null;
}

export interface SwitchCall {
  readonly input: AutoSettlementSwitchInput;
  readonly result: AutoSettlementSwitchResult;
}

export interface FakeSwitch extends AutoSettlementSwitch {
  readonly turnOffs: SwitchCall[];
  readonly alerts: SwitchCall[];
  /** `turnOff:<app>` and `alert:<app>` in call order. */
  readonly events: string[];
  /** Per alert: whether the transaction of that app's turnOff had ended when the alert came. */
  readonly alertChecks: Promise<boolean>[];
  /** When true, turnOff throws (nothing switched). */
  fail: boolean;
}

export interface Harness {
  readonly db: Kysely<DB>;
  /** A second pool: reads only committed state while the executor's transaction is open. */
  readonly observer: Kysely<DB>;
  readonly clock: FixedClock;
  readonly logs: LogLine[];
  readonly holds: FakeHolds;
  readonly settle: FakeSwitch;
  readonly executor: DailyCheckExecutor;
  /** Another executor on the same ports (concurrent runs). */
  another(): DailyCheckExecutor;
}

interface Connections {
  observer?: Kysely<DB>;
}

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

function observerOf(connections: Connections): Kysely<DB> {
  const observer = connections.observer;
  if (observer === undefined) throw new Error('observer used before the database exists');
  return observer;
}

async function diffExists(db: Kysely<DB>, appId: string, id: string): Promise<boolean> {
  const result = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.recon_diffs
    WHERE app_id = ${appId} AND id::text = ${id}`.execute(db);
  return result.rows[0]?.n === '1';
}

const HOLD_PREFIX = 'recon_diff:';

function fakeHolds(clock: FixedClock, connections: Connections): FakeHolds {
  const calls: HoldCall[] = [];
  const state: { failAt: number | null } = { failAt: null };
  return {
    calls,
    get failAt() {
      return state.failAt;
    },
    set failAt(value: number | null) {
      state.failAt = value;
    },
    async add(trx, input) {
      const index = calls.length;
      const sourceRef = typeof input.sourceRef === 'string' ? input.sourceRef : '';
      const id = sourceRef.startsWith(HOLD_PREFIX) ? sourceRef.slice(HOLD_PREFIX.length) : null;
      const observer = observerOf(connections);
      const diffInTransaction = id !== null && (await diffExists(trx, input.appId, id));
      const diffOutside = id !== null && (await diffExists(observer, input.appId, id));
      calls.push({ input, diffInTransaction, diffOutside });
      if (state.failAt === index) throw new Error('synthetic hold failure');
      const holdId = randomUUID();
      await sql`INSERT INTO app.withdraw_holds
        (id, app_id, user_id, reason, source_ref, created_by, created_at, hold_until)
        VALUES (${holdId}, ${input.appId}, ${input.userId}, ${input.reason}, ${input.sourceRef},
          ${input.createdBy}, ${clock.now()}, ${input.holdUntil})`.execute(trx);
      return { id: holdId };
    },
  };
}

function lockName(appId: string): string {
  return `b2-02p-switch:${appId}`;
}

function fakeSwitch(connections: Connections): FakeSwitch {
  const turnOffs: SwitchCall[] = [];
  const alerts: SwitchCall[] = [];
  const events: string[] = [];
  const alertChecks: Promise<boolean>[] = [];
  const state = { fail: false };
  return {
    turnOffs,
    alerts,
    events,
    alertChecks,
    get fail() {
      return state.fail;
    },
    set fail(value: boolean) {
      state.fail = value;
    },
    async turnOff(trx, input) {
      events.push(`turnOff:${input.appId}`);
      if (state.fail) throw new Error('synthetic switch failure');
      // Held until the transaction ends (commit or roll-back).
      await sql`SELECT pg_advisory_xact_lock(hashtext(${lockName(input.appId)}))`.execute(trx);
      const result: AutoSettlementSwitchResult = {
        key: SWITCH_KEY,
        changed: true,
        version: turnOffs.length + 2,
        fromValue: true,
      };
      turnOffs.push({ input, result });
      return result;
    },
    alertCommitted(input, result) {
      events.push(`alert:${input.appId}`);
      alerts.push({ input, result });
      alertChecks.push(lockReleased(observerOf(connections), input.appId));
    },
  };
}

/** True when no transaction holds the app's switch lock (one autocommit statement). */
async function lockReleased(observer: Kysely<DB>, appId: string): Promise<boolean> {
  const result = await sql<{ got: boolean }>`
    SELECT pg_try_advisory_xact_lock(hashtext(${lockName(appId)})) AS got`.execute(observer);
  return result.rows[0]?.got === true;
}

/**
 * Builds the ports and the executor first (so a missing implementation is red with its own
 * NotImplemented before any fixture), then a fresh database for `run`.
 */
export async function withHarness(
  create: () => Promise<TestDatabase>,
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const clock = new FixedClock(NOW);
  const logs: LogLine[] = [];
  const logger = {
    warn(fields: Record<string, unknown>) {
      logs.push({ level: 'warn', fields });
    },
    error(fields: Record<string, unknown>) {
      logs.push({ level: 'error', fields });
    },
  };
  const connections: Connections = {};
  const holds = fakeHolds(clock, connections);
  const settle = fakeSwitch(connections);
  const dependencies = { clock, logger, holds, autoSettlement: settle };
  const executor = createDailyCheckExecutor(dependencies);
  const database = await create();
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  const observer = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  connections.observer = observer;
  try {
    await run({
      db,
      observer,
      clock,
      logs,
      holds,
      settle,
      executor,
      another: () => createDailyCheckExecutor(dependencies),
    });
  } finally {
    await Promise.all([destroyDb(db), destroyDb(observer)]);
    await database.drop();
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures (legal INSERTs as couli_app; nothing disabled).

async function insert(db: Kysely<DB>, table: string, row: Record<string, unknown>) {
  await sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((key) => sql.ref(key)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}

/** A synthetic member (users row) of the app. */
export async function member(h: Harness, appId = APP): Promise<string> {
  const id = randomUUID();
  await insert(h.db, 'users', {
    id,
    app_id: appId,
    nickname: 'synthetic member',
    avatar: '',
    invite_code: randomUUID(),
    attr_code: randomUUID(),
    level: 'member',
    register_method: 'synthetic',
    created_at: h.clock.now(),
    updated_at: h.clock.now(),
  });
  return id;
}

export interface UserAccount {
  readonly appId: string;
  readonly userId: string;
  readonly accountId: string;
}

/** A member and their USER_BALANCE account (owner_id = users.id). */
export async function userAccount(h: Harness, appId = APP): Promise<UserAccount> {
  const userId = await member(h, appId);
  const accountId = randomUUID();
  await insert(h.db, 'ledger_accounts', {
    id: accountId,
    app_id: appId,
    owner_type: 'user',
    owner_id: userId,
    subject: 'USER_BALANCE',
  });
  return { appId, userId, accountId };
}

/** A platform account of the app. */
export async function platformAccount(
  h: Harness,
  subject = 'UNION_RECEIVABLE:taobao',
  appId = APP,
): Promise<string> {
  const id = randomUUID();
  await insert(h.db, 'ledger_accounts', {
    id,
    app_id: appId,
    owner_type: 'platform',
    owner_id: 'platform',
    subject,
  });
  return id;
}

export interface VoucherFixture {
  readonly id: string;
  readonly uniqKey: string;
}

/** A voucher of the app (accounting date D unless given). */
export async function voucher(
  h: Harness,
  values: {
    readonly appId?: string;
    readonly orderKey?: string | null;
    readonly beneficiaryUserId?: string | null;
    readonly role?: string | null;
    readonly kind?: string | null;
  } = {},
): Promise<VoucherFixture> {
  const id = randomUUID();
  const uniqKey = `fixture:${id}`;
  await insert(h.db, 'ledger_vouchers', {
    id,
    app_id: values.appId ?? APP,
    biz_type: 'order',
    biz_id: randomUUID(),
    uniq_key: uniqKey,
    accounting_date: DAY,
    operator: 'system',
    order_key: values.orderKey ?? null,
    beneficiary_user_id: values.beneficiaryUserId ?? null,
    role: values.role ?? null,
    voucher_kind: values.kind ?? null,
  });
  return { id, uniqKey };
}

/** One entry of `voucher` on an account (user accounts get balance_after and a version). */
export async function entry(
  h: Harness,
  voucherId: string,
  accountId: string,
  amount: bigint,
  user: boolean,
  appId = APP,
): Promise<void> {
  await insert(h.db, 'ledger_entries', {
    app_id: appId,
    account_id: accountId,
    voucher_id: voucherId,
    sub_account: 'available',
    amount_fen: amount,
    ledger_type: 'REBATE_CREDIT',
    balance_after_fen: user ? -amount : null,
    account_version: user ? 1n : null,
    booked_at: '2032-06-15T08:00:00Z',
  });
}

// ---------------------------------------------------------------------------------------------
// Differences in the unified invariant output shape.

/** ① balance cache difference of one user account (detail as 01_user-balances.sql). */
export function balanceCacheDiff(
  account: UserAccount,
  amounts: { readonly expected: bigint; readonly cache: bigint },
): DailyCheckFiledDifference {
  return {
    file: FILES['01'],
    invariant: '01',
    scope: 'account',
    app_id: account.appId,
    account_id: account.accountId,
    detail: {
      check: 'balance_cache',
      sub_account: 'available',
      cache_present: true,
      cache_fen: amounts.cache.toString(),
      expected_cache_fen: amounts.expected.toString(),
      entries_sum_fen: (-amounts.expected).toString(),
    },
  };
}

/** ⑦ difference of one user account (account level, no amount pair). */
export function negativeDropDiff(account: UserAccount): DailyCheckFiledDifference {
  return {
    file: FILES['07'],
    invariant: '07',
    scope: 'account',
    app_id: account.appId,
    account_id: account.accountId,
    detail: {
      entry_id: '4242',
      ledger_type: 'REWARD',
      voucher_uniq_key: 'fixture:negative-drop',
    },
  };
}

/** pay-01 difference of one user account (collections; account level). */
export function payAccountDiff(account: UserAccount): DailyCheckFiledDifference {
  return {
    file: FILES['pay-01'],
    invariant: 'pay-01',
    scope: 'account',
    app_id: account.appId,
    account_id: account.accountId,
    detail: {
      voucher_id: randomUUID(),
      uniq_key: 'fixture:pay-receipt',
      biz_type: 'pay_order',
      biz_id: 'po-fixture-aaaa',
      voucher_kind: 'PAY_RECEIPT',
      user_entry_count: '1',
    },
  };
}

/** pay-04 global difference (collections suspense). */
export function paySuspenseDiff(appId = APP): DailyCheckFiledDifference {
  return {
    file: FILES['pay-04'],
    invariant: 'pay-04',
    scope: 'global',
    app_id: appId,
    account_id: null,
    detail: {
      anomaly_count: '1',
      suspense_entry_count: '2',
      expected_suspense_fen: '300',
      actual_suspense_fen: '500',
    },
  };
}

/** ② difference of one voucher (detail as 02_voucher-balanced.sql). */
export function voucherDiff(
  v: VoucherFixture,
  actualSum: bigint,
  entryCount: number,
  appId = APP,
): DailyCheckFiledDifference {
  return {
    file: FILES['02'],
    invariant: '02',
    scope: 'global',
    app_id: appId,
    account_id: null,
    detail: {
      voucher_id: v.id,
      uniq_key: v.uniqKey,
      accounting_date: DAY,
      entry_count: String(entryCount),
      expected_sum_fen: '0',
      actual_sum_fen: actualSum.toString(),
    },
  };
}

/** ③ difference of one (order, beneficiary, role) key (detail as 09_credit-unique-net.sql). */
export function creditUniqueDiff(
  orderKey: string,
  userId: string,
  role: string,
  vouchers: readonly VoucherFixture[],
  appId = APP,
): DailyCheckFiledDifference {
  return {
    file: FILES['03'],
    invariant: '03',
    scope: 'global',
    app_id: appId,
    account_id: null,
    detail: {
      order_key: orderKey,
      beneficiary_user_id: userId,
      role,
      reasons: ['multiple_effective_credits'],
      max_effective_credits: '1',
      effective_credits: String(vouchers.length),
      orphan_reversals: '0',
      unoffset_pairs: '0',
      credit_vouchers: String(vouchers.length),
      reversal_vouchers: '0',
      voucher_ids: vouchers.map((v) => v.id),
      uniq_keys: vouchers.map((v) => v.uniqKey),
      effective_uniq_keys: vouchers.map((v) => v.uniqKey),
      orphan_reversal_uniq_keys: [],
      unoffset_pair_details: [],
    },
  };
}

/**
 * ③ fixture: `count` CREDIT vouchers of (orderKey, user, role), each crediting the user's account
 * against UNION_RECEIVABLE; returns the difference the SQL would report.
 */
export async function duplicateCredits(
  h: Harness,
  orderKey: string,
  account: UserAccount,
  role: string,
  receivable: string,
  count = 2,
): Promise<DailyCheckFiledDifference> {
  const vouchers: VoucherFixture[] = [];
  for (let i = 0; i < count; i += 1) {
    const v = await voucher(h, {
      appId: account.appId,
      orderKey,
      beneficiaryUserId: account.userId,
      role,
      kind: 'CREDIT',
    });
    await entry(h, v.id, account.accountId, -100n, true, account.appId);
    await entry(h, v.id, receivable, 100n, false, account.appId);
    vouchers.push(v);
  }
  return creditUniqueDiff(orderKey, account.userId, role, vouchers, account.appId);
}

/** ⑤ difference of one sub-order whose receivable is short (detail as 05_union-receivable.sql). */
export function receivableDiff(
  orderKey: string,
  orderId: string,
  beneficiary: string,
  amounts: { readonly expected: bigint; readonly actual: bigint },
  appId = APP,
): DailyCheckFiledDifference {
  return {
    file: FILES['05'],
    invariant: '05',
    scope: 'global',
    app_id: appId,
    account_id: null,
    detail: {
      order_id: orderId,
      order_key: orderKey,
      rebate_status: 'CREDITED',
      reasons: ['receivable_mismatch'],
      booked_n_fen: amounts.expected.toString(),
      booked_base_fen: '2000',
      union_receivable_net_fen: amounts.actual.toString(),
      pending_credit_fen: '0',
      expected_union_receivable_net_fen: amounts.expected.toString(),
      beneficiary_net_sum_fen: '600',
      beneficiary_net_algebraic_sum_fen: '600',
      beneficiary_keys: '1',
      pending_items: [
        {
          user_id: beneficiary,
          role: 'self',
          ratio_bp: '3000',
          entitled_fen: '600',
          net_fen: '600',
          pending_fen: '0',
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reading back.

/** Every recon_diffs row of the app, by ref_id. */
export function diffsOf(h: Harness, appId = APP): Promise<DiffRow[]> {
  return h.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('ref_id')
    .orderBy('period')
    .execute();
}

/** Every withdraw_holds row of the app, by user then source. */
export function holdsOf(h: Harness, appId = APP): Promise<HoldRow[]> {
  return h.db
    .selectFrom('withdraw_holds')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('user_id')
    .orderBy('source_ref')
    .execute();
}

/** The one recon diff of the app with this ref_id (and period D unless given). */
export async function diffByRef(
  h: Harness,
  refId: string,
  period = DAY,
  appId = APP,
): Promise<DiffRow> {
  const rows = await h.db
    .selectFrom('recon_diffs')
    .selectAll()
    .where('app_id', '=', appId)
    .where('ref_id', '=', refId)
    .where('period', '=', period)
    .execute();
  expect(rows, `recon_diffs ${appId} ${refId} ${period}`).toHaveLength(1);
  return rows[0]!;
}

/** The source_ref of the holds a diff added. */
export function sourceOf(diffId: string): string {
  return `${HOLD_PREFIX}${diffId}`;
}

/** The registration columns every R3 diff of the daily check carries. */
export function expectRegistered(
  row: DiffRow,
  expected: {
    readonly appId?: string;
    readonly period?: string;
    readonly refType: string;
    readonly refId: string;
    readonly expectedFen: bigint;
    readonly actualFen: bigint;
  },
): void {
  const period = expected.period ?? DAY;
  expect(row).toMatchObject({
    app_id: expected.appId ?? APP,
    type: 'ledger_mismatch',
    source: 'R3',
    period,
    ref_type: expected.refType,
    ref_id: expected.refId,
    expected_fen: expected.expectedFen,
    actual_fen: expected.actualFen,
    diff_fen: expected.expectedFen - expected.actualFen,
    status: 'open',
    handler_id: null,
    closed_at: null,
    dedupe_key: `R3:${period}:${expected.refId}`,
  });
}

/** Every leaf of the difference's detail appears in the stored resolution. */
export function expectDetailKept(row: DiffRow, difference: DailyCheckFiledDifference): void {
  function leaves(value: unknown): string[] {
    if (value !== null && typeof value === 'object') return Object.values(value).flatMap(leaves);
    return [String(value)];
  }
  expect(row.resolution, 'resolution').not.toBeNull();
  const stored = JSON.stringify(row.resolution);
  for (const leaf of leaves(difference.detail)) {
    expect(stored, `resolution keeps ${leaf}`).toContain(leaf);
  }
}

/** The hold row a diff added for a user: unreleased, no expiry, created by system at the clock. */
export function expectHold(row: HoldRow | undefined, diff: DiffRow, userId: string, h: Harness) {
  expect(row, `hold of ${userId}`).toBeDefined();
  expect(row).toMatchObject({
    app_id: diff.app_id,
    user_id: userId,
    reason: 'ledger_mismatch',
    source_ref: sourceOf(diff.id),
    created_by: 'system',
    created_at: h.clock.now(),
    hold_until: null,
    released_at: null,
    released_by: null,
  });
}

/** The port input of a hold of `userId` for `diff`. */
export function holdInput(diff: DiffRow, userId: string): LedgerMismatchHoldInput {
  return {
    appId: diff.app_id,
    userId,
    reason: 'ledger_mismatch',
    sourceRef: sourceOf(diff.id),
    createdBy: 'system',
    holdUntil: null,
  };
}

/** A two-digit invariant code appears in `text` as a code of its own (not inside 2032). */
export function mentionsCode(text: string, code: string): boolean {
  return new RegExp(`(^|[^0-9])${code}([^0-9]|$)`).test(text);
}

/** The run's diff entry for a stored diff. */
export function executedOf(execution: DailyCheckExecution, diff: DiffRow) {
  const found = execution.reconDiffs.filter((d) => d.reconDiffId === diff.id);
  expect(found, `execution entry of ${diff.ref_id}`).toHaveLength(1);
  return found[0]!;
}

/** A sub-order key in the voucher format platform:sub_order_id. */
export function orderKey(): string {
  return `taobao:${randomUUID().replaceAll('-', '').slice(0, 18)}`;
}
