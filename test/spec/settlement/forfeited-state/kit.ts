// B2-09ga rule-test kit (claude-independent, SPEC_REF 9ab94dc0): the one judgement of a forfeited
// share (编排裁定 D10-481 ②) and the restore of an identified minor (D10-482), over 08 BR-FUND-22 ③,
// BR-CALC-09, BR-CALC-13 and BR-ID-26.
// Real pieces: the admin entry (createHttpApp('admin')), the credit, beneficiary-credit, clawback and
// pending-earnings services wired as the worker and app.module wire them, commission's public reads
// and event writer, the snapshot writer's row shape, the BeneficiaryGate with identity's minor port
// over real field ciphers (the admin entry opens the same keys), ledger, PostgreSQL as couli_app.
// Synthetic: orders, members and realname rows, the differences as risk's producer registers them,
// one order_rights row, an obligation left open by hand where the test says so. No real user or
// merchant data. Expected amounts are written by hand in the tests.
//
// seedShareOrder writes what snapshot-store writes: beneficiaries[].initial_status and forfeit_reason
// in commission_splits and, for each beneficiary, one first event with that status and reason.
// Default order: N = 1000, reserve_bp 1500 → B 850; self 5000 / direct 1000 / indirect 500 → 425 / 85
// / 42. The snapshot itself was taken on N + 3333, so its amounts are never the ones paid.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { addFen, mulDivFloor, subFen } from '@couli/money';
import type { Transaction } from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import {
  isShareForfeited,
  type ShareEventStatus,
  type ShareInitialStatus,
} from '../../../../apps/api/src/modules/commission/application/forfeited-state.ts';
import { insertSnapshot } from '../../../../apps/api/src/modules/commission/infra/snapshot-store.ts';
import { getOrderNets } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
  openFieldCrypto,
  type FieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import {
  REDIS,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type DbHandles,
  type FixedClock,
  type RedisHandle,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createRiskStateBatchReader } from '../../../../apps/api/src/modules/risk/index.ts';
import {
  createClawbackOrder,
  type ClawbackOrder,
} from '../../../../apps/api/src/modules/settlement/clawback/index.ts';
import {
  createBeneficiaryCredit,
  type BeneficiaryCredit,
  type BeneficiaryCreditResult,
} from '../../../../apps/api/src/modules/settlement/credit/beneficiary/index.ts';
import {
  createBeneficiaryGate,
  createCreditOrder,
  type BeneficiaryGate,
  type CreditOrder,
  type CreditOrderResult,
  type CreditSnapshot,
  type CreditSnapshotSelection,
} from '../../../../apps/api/src/modules/settlement/credit/index.ts';
import {
  createPendingEarningsSource,
  type PendingEarningsSource,
} from '../../../../apps/api/src/modules/settlement/reads/pending-earnings.ts';
import {
  RESTORE,
  fixture as restoreFixture,
  memberOf,
  newKey,
  restorePath,
  restored,
  seedRestoreDiff,
  shareEvents,
  voucherLines,
  type AdminCaller,
  type AdminSent,
  type Envelope,
  type RestoreFixture,
  type Role,
  type SeededOrder,
  type SeededPerson,
} from '../admin-recon-restore/kit.ts';
import { realname, type RealnameSeed } from '../../identity/minor-status/kit.ts';
import type { Suite } from '../../payment/orders/kit.ts';

export {
  RESTORE_ACTION,
  audits,
  available,
  expectRestored,
  memberOf,
  netOf,
  netsOf,
  restoreKey,
  restoreLines,
  restoreVouchers,
  restored,
  seedCase,
  seedRestoreDiff,
  setRisk,
  shareEvents,
  suite,
  voucherLines,
  type Case as SeededCase,
  type Role,
} from '../admin-recon-restore/kit.ts';
export { ADULT_BIRTH, MINOR_BIRTH } from '../../identity/minor-status/kit.ts';

// Loaded at run time like the other settlement rule tests do: identity/index.ts re-exports Nest
// modules the `test` project cannot compile. The type queries are erased.
const {
  createMinorStatusBatchReader,
  createRealnameStatusBatchReader,
  createUserDeletionStatusReader,
  lockUsersForUpdate,
} = (await import(
  new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/identity/ports/realname-status-batch.ts') &
  typeof import('../../../../apps/api/src/modules/identity/ports/user-deletion-status.ts') &
  typeof import('../../../../apps/api/src/modules/identity/ports/lock-users.ts') &
  typeof import('../../../../apps/api/src/modules/identity/ports/minor-status-batch.ts');

export type Reason = 'banned' | 'deleted' | 'minor';

/** One event appended after the snapshot. */
export interface ShareStep {
  readonly status: ShareEventStatus;
  readonly reason: Reason | null;
}

interface ShareEventInput extends ShareStep {
  readonly appId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly role: Role;
}

export interface ForfeitedEvent {
  readonly eventSeq: bigint;
  readonly userId: string;
  readonly role: Role;
  readonly reason: string | null;
}

/** The two public reads, as far as these tests look at them. */
export type Snapshot = Omit<CreditSnapshot, 'beneficiaries' | 'forfeitedEvents'> & {
  readonly beneficiaries: readonly (CreditSnapshot['beneficiaries'][number] & {
    readonly forfeitReason: string | null;
  })[];
  readonly forfeitedEvents: readonly ForfeitedEvent[];
};

// Through commission's public entry.
const commission = (await import(
  new URL('../../../../apps/api/src/modules/commission/index.ts', import.meta.url).href
)) as {
  readCommissionSnapshot(
    trx: Transaction<DB>,
    input: CreditSnapshotSelection,
  ): Promise<Snapshot | null>;
  readCommissionAttribution(
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly orderId: string },
  ): Promise<Snapshot>;
  readTljDeductFen(
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly orderId: string },
  ): Promise<bigint>;
  appendBeneficiaryEvent(
    trx: Transaction<DB>,
    input: ShareEventInput,
    dependencies: { readonly clock: FixedClock },
  ): Promise<void>;
};

const ROOT = new URL('../../../../', import.meta.url);
const ATTR_AT = new Date('2026-08-20T00:00:00.000Z');
const SETTLE_PERIOD = '2026-08';
const RESERVE_BP = 1500;
/** N of every order of seedShareOrder. */
const N_FEN = 1000n;
/** The snapshot's estimate is N + this, so its amounts never equal the booked ones. */
const SNAPSHOT_DRIFT_FEN = 3333n;
const SUBSIDY_FEN = 111n;

export interface StateFixture extends RestoreFixture {
  readonly master: Buffer;
  readonly keyring: Awaited<ReturnType<typeof createWrappedKeyring>>;
  readonly crypto: FieldCrypto;
  readonly gate: BeneficiaryGate;
  readonly credit: CreditOrder;
  readonly beneficiaryCredit: BeneficiaryCredit;
  readonly clawback: ClawbackOrder;
  readonly pending: PendingEarningsSource;
}

/** One app on the suite's database with its keys and the four services on the real gate. */
export async function fixture(s: Suite): Promise<StateFixture> {
  const base = await restoreFixture(s);
  const { clock, db, ledger } = base;
  const master = randomBytes(32);
  const provider = new LocalKeyProvider(master);
  const keyring = await createWrappedKeyring(provider);
  const crypto = await openFieldCrypto(keyring, provider);
  const logger = createRootLogger(
    { entry: 'test', appEnv: 'test', level: 'silent' },
    { write: () => undefined },
  );
  const gate = createBeneficiaryGate({
    clock,
    lockUsers: (trx, input) => lockUsersForUpdate(trx, input),
    deletionStatus: createUserDeletionStatusReader({ db }),
    realnameStatus: createRealnameStatusBatchReader({ db }),
    riskState: createRiskStateBatchReader({ db }),
    minors: createMinorStatusBatchReader({ crypto }),
  });
  const readSnapshot = (trx: Transaction<DB>, input: CreditSnapshotSelection) =>
    commission.readCommissionSnapshot(trx, input);
  const readAttribution = (
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly orderId: string },
  ) => commission.readCommissionAttribution(trx, input);
  const readTljDeductFen = (
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly orderId: string },
  ) => commission.readTljDeductFen(trx, input);
  const appendBeneficiaryEvent = (trx: Transaction<DB>, input: ShareEventInput) =>
    commission.appendBeneficiaryEvent(trx, input, { clock });
  return {
    ...base,
    master,
    keyring,
    crypto,
    gate,
    credit: createCreditOrder({
      clock,
      logger,
      ledger,
      gate,
      readAttribution,
      readSnapshot,
      readTljDeductFen,
      appendBeneficiaryEvent,
      events: { publish: () => Promise.resolve({ eventId: randomUUID(), duplicate: false }) },
    }),
    beneficiaryCredit: createBeneficiaryCredit({
      clock,
      logger,
      ledger,
      gate,
      readAttribution,
      readSnapshot,
      readOrderNets: (trx, input) => getOrderNets(trx, input),
      appendBeneficiaryEvent,
    }),
    clawback: createClawbackOrder({
      clock,
      logger,
      ledger,
      gate,
      readSnapshot,
      appendBeneficiaryEvent,
      pending: {
        open: () => Promise.reject(new Error('a clawback with a new commission does not wait')),
      },
      config: { get: () => Promise.resolve(undefined) },
      events: {
        publish: () => Promise.reject(new Error('a partial clawback publishes nothing')),
      },
    }),
    pending: createPendingEarningsSource({
      clock,
      config: { get: () => Promise.resolve(undefined) },
      readSnapshot,
      readTljDeductFen,
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Orders.

export interface SharePerson {
  readonly role: Role;
  readonly ratioBp: number;
  /** An existing member; a new one when omitted. */
  readonly userId?: string | undefined;
  /** beneficiaries[].initial_status forfeited with this forfeit_reason (BR-CALC-13). */
  readonly initial?: Reason | null | undefined;
}

export interface ShareOrderSpec {
  /** ESTIMATED (PAID, no settled amount) or WAITING (settled at N, order_settlements seq 1). */
  readonly status: 'ESTIMATED' | 'WAITING';
  readonly people: readonly SharePerson[];
}

/** Self, direct and indirect of the default order; `direct` is the share under test. */
export function threePeople(direct: {
  readonly userId?: string | undefined;
  readonly initial?: Reason | null | undefined;
}): SharePerson[] {
  return [
    { role: 'self', ratioBp: 5000 },
    { role: 'direct', ratioBp: 1000, ...direct },
    { role: 'indirect', ratioBp: 500 },
  ];
}

/** BR-CALC-02 (no tlj): floor(N × (10000 − reserve_bp) / 10000). */
function baseAt(n: bigint): bigint {
  return mulDivFloor(n, BigInt(10000 - RESERVE_BP), 10000n);
}

/** BR-CALC-04: floor(B × ratio / 10000). */
function shareAt(base: bigint, ratioBp: number): bigint {
  return mulDivFloor(base, BigInt(ratioBp), 10000n);
}

/**
 * An order with its snapshot as snapshot-store writes it. The people carry what seedRestoreDiff
 * reads: every share's forfeitFen is its amount on the default order.
 */
export async function seedShareOrder(f: StateFixture, spec: ShareOrderSpec): Promise<SeededOrder> {
  const orderId = randomUUID();
  const platform = 'taobao';
  const subOrderId = `state-${orderId}`;
  const orderKey = `${platform}:${subOrderId}`;
  const waiting = spec.status === 'WAITING';
  const bookedBaseFen = baseAt(N_FEN);

  const seats: { readonly person: SeededPerson; readonly initial: Reason | null }[] = [];
  for (const p of spec.people) {
    const initial = p.initial ?? null;
    seats.push({
      initial,
      person: {
        userId: p.userId ?? (await memberOf(f)),
        role: p.role,
        ratioBp: p.ratioBp,
        forfeited: initial !== null,
        creditedFen: 0n,
        forfeitFen: shareAt(bookedBaseFen, p.ratioBp),
        steps: [],
      },
    });
  }
  const people = seats.map((seat) => seat.person);

  const rawN = addFen(N_FEN, SNAPSHOT_DRIFT_FEN);
  const nTotal = addFen(rawN, SUBSIDY_FEN);
  const snapBase = baseAt(rawN);
  const snapAmounts = seats.map((seat) =>
    seat.initial === null ? shareAt(snapBase, seat.person.ratioBp) : 0n,
  );
  const snapUserTotal = snapAmounts.reduce((sum, a) => addFen(sum, a), 0n);
  const owner = people.find((p) => p.role === 'self' || p.role === 'share') ?? people[0];
  const orderType = people.some((p) => p.role === 'share') ? 'share' : 'self';

  await f.db
    .insertInto('order_keys')
    .values({
      app_id: f.appId,
      order_id: orderId,
      platform,
      sub_order_id: subOrderId,
      attr_at: ATTR_AT,
      created_at: ATTR_AT,
    })
    .execute();
  await f.db
    .insertInto('orders')
    .values({
      app_id: f.appId,
      order_id: orderId,
      platform,
      sub_order_id: subOrderId,
      attr_at: ATTR_AT,
      raw_item_id: 'synthetic',
      user_id: owner?.userId ?? null,
      user_basis: 'param',
      buy_type: orderType,
      platform_status: waiting ? 'SETTLED' : 'PAID',
      rebate_status: spec.status,
      hold: false,
      rights_pending: false,
      commission_version: 1,
      est_commission_fen: waiting ? rawN : N_FEN,
      settle_commission_fen: waiting ? N_FEN : null,
      subsidy_commission_fen: SUBSIDY_FEN,
      initial_est_fen: rawN,
      n_total_fen: nTotal,
      pre_base_deduct_fen: subFen(nTotal, snapBase),
      base_fen: snapBase,
      platform_est_profit_fen: subFen(nTotal, snapUserTotal),
      activity_type: null,
      paid_at: ATTR_AT,
      received_at: waiting ? ATTR_AT : null,
      settle_period: waiting ? SETTLE_PERIOD : null,
      quantity: 1,
      refunded_quantity: 0,
      created_at: ATTR_AT,
      updated_at: ATTR_AT,
    })
    .execute();
  await f.db
    .insertInto('commission_splits')
    .values({
      app_id: f.appId,
      order_id: orderId,
      rule_version_id: f.ruleVersionId,
      order_type: orderType,
      activity_type: null,
      rebate_mode: null,
      paid_at: ATTR_AT,
      paid_at_source: 'platform',
      raw_n_fen: rawN,
      subsidy_commission_fen: SUBSIDY_FEN,
      reserve_bp: RESERVE_BP,
      reserve_fen: subFen(rawN, snapBase),
      tlj_deduct_fen: 0n,
      base_fen: snapBase,
      platform_retain_fen: subFen(snapBase, snapUserTotal),
      beneficiaries: JSON.stringify(
        seats.map(({ person, initial }) => ({
          user_id: person.userId,
          role: person.role,
          ratio_bp: person.ratioBp,
          level: 'L1',
          initial_status: initial === null ? 'active' : 'forfeited',
          forfeit_reason: initial,
        })),
      ),
      created_at: ATTR_AT,
    })
    .execute();
  await f.db
    .insertInto('commission_split_totals')
    .values({
      app_id: f.appId,
      order_id: orderId,
      commission_version: 1,
      n_total_fen: nTotal,
      pre_base_deduct_fen: subFen(nTotal, snapBase),
      base_fen: snapBase,
      user_share_total_fen: snapUserTotal,
      tlj_redpacket_fen: 0n,
      platform_est_profit_fen: subFen(nTotal, snapUserTotal),
      created_at: ATTR_AT,
    })
    .execute();
  await f.db
    .insertInto('commission_split_amounts')
    .values(
      seats.map(({ person }, i) => ({
        app_id: f.appId,
        order_id: orderId,
        commission_version: 1,
        user_id: person.userId,
        role: person.role,
        base_fen: snapBase,
        amount_fen: snapAmounts[i] ?? 0n,
        created_at: ATTR_AT,
      })),
    )
    .execute();
  await f.db
    .insertInto('commission_split_beneficiary_events')
    .values(
      seats.map(({ person, initial }) => ({
        app_id: f.appId,
        order_id: orderId,
        user_id: person.userId,
        role: person.role,
        status: initial === null ? 'active' : 'forfeited',
        reason: initial,
        created_at: ATTR_AT,
      })),
    )
    .execute();
  if (waiting) {
    await f.db
      .insertInto('order_settlements')
      .values({
        app_id: f.appId,
        order_id: orderId,
        seq: 1,
        source: 'STATEMENT',
        settle_commission_fen: N_FEN,
        settled_at: ATTR_AT,
        content_hash: randomUUID(),
        created_at: ATTR_AT,
      })
      .execute();
  }
  return {
    orderId,
    platform,
    subOrderId,
    orderKey,
    bookedBaseFen,
    people,
    user(role: Role): string {
      const found = people.find((p) => p.role === role);
      if (found === undefined) throw new Error(`no ${role} beneficiary in this order`);
      return found.userId;
    },
  };
}

/**
 * A snapshot written by commission's own writer (insertSnapshot): the direct beneficiary is
 * forfeited at the snapshot for `reason`. Returns the order and its two beneficiaries.
 */
export async function writtenSnapshot(f: StateFixture, reason: Reason) {
  const orderId = randomUUID();
  const owner = await memberOf(f);
  const direct = await memberOf(f);
  await f.db
    .insertInto('order_keys')
    .values({
      app_id: f.appId,
      order_id: orderId,
      platform: 'taobao',
      sub_order_id: `written-${orderId}`,
      attr_at: ATTR_AT,
      created_at: ATTR_AT,
    })
    .execute();
  await f.db.transaction().execute(async (trx) => {
    const written = await insertSnapshot(trx, {
      appId: f.appId,
      orderId,
      ruleVersionId: f.ruleVersionId,
      orderType: 'self',
      activityType: null,
      rebateMode: null,
      paidAt: ATTR_AT,
      paidAtSource: 'platform',
      rawNFen: N_FEN,
      subsidyCommissionFen: 0n,
      tljDeductFen: 0n,
      plan: {
        kind: 'plan',
        reserve_bp: 1500n,
        reserve_fen: 150n,
        base_fen: 850n,
        platform_retain_fen: 425n,
        beneficiaries: [
          {
            user_id: owner,
            role: 'self',
            ratio_bp: 5000n,
            level: 'L1',
            initial_status: 'active',
            forfeit_reason: null,
            amount_fen: 425n,
          },
          {
            user_id: direct,
            role: 'direct',
            ratio_bp: 1000n,
            level: 'L1',
            initial_status: 'forfeited',
            forfeit_reason: reason,
            amount_fen: 0n,
          },
        ],
        n_total_fen: 1000n,
        pre_base_deduct_fen: 150n,
        user_share_total_fen: 425n,
        tlj_redpacket_fen: 0n,
        platform_est_profit_fen: 575n,
        warnings: [],
      },
      createdAt: ATTR_AT,
    });
    expect(written.kind).toBe('inserted');
  });
  return { orderId, owner, direct };
}

/** Appends one event through commission's writer, as the restore and the credits do. */
export function appendShareEvent(
  f: StateFixture,
  orderId: string,
  userId: string,
  role: Role,
  step: ShareStep,
): Promise<void> {
  return f.db
    .transaction()
    .execute((trx) =>
      commission.appendBeneficiaryEvent(
        trx,
        { appId: f.appId, orderId, userId, role, ...step },
        { clock: f.clock },
      ),
    );
}

/** The member's account state now, replacing the one before (user_risk_state). */
export async function setRiskState(
  f: StateFixture,
  userId: string,
  state: 'normal' | 'frozen',
): Promise<void> {
  const reasonCategory = state === 'normal' ? null : 'other';
  await f.db
    .insertInto('user_risk_state')
    .values({
      user_id: userId,
      app_id: f.appId,
      state,
      reason: null,
      reason_category: reasonCategory,
      frozen_until: null,
      changed_by: 'test',
      changed_at: f.clock.now(),
    })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({
        state,
        reason_category: reasonCategory,
        changed_at: f.clock.now(),
      }),
    )
    .execute();
}

/** One realname row of the member, enciphered with the fixture's keys (minor by default). */
export function identify(f: StateFixture, userId: string, seed: RealnameSeed = {}): Promise<void> {
  return realname(f.db, f.crypto, f.appId, userId, seed);
}

// ---------------------------------------------------------------------------------------------
// The judgement and the reads.

/** commission's reads of the order, on a fresh transaction. */
export function attributionOf(f: StateFixture, orderId: string): Promise<Snapshot> {
  return f.db
    .transaction()
    .execute((trx) => commission.readCommissionAttribution(trx, { appId: f.appId, orderId }));
}

/** The order's forfeited events as both public reads answer them (settlement uses both). */
export function forfeitedOf(f: StateFixture, orderId: string): Promise<readonly ForfeitedEvent[]> {
  return f.db.transaction().execute(async (trx) => {
    const selection = { appId: f.appId, orderId };
    const snapshot = await commission.readCommissionSnapshot(trx, {
      ...selection,
      commissionVersion: 1,
    });
    const attribution = await commission.readCommissionAttribution(trx, selection);
    expect(snapshot, orderId).not.toBeNull();
    expect(attribution.forfeitedEvents, orderId).toEqual(snapshot?.forfeitedEvents);
    return attribution.forfeitedEvents;
  });
}

/** The judgement over the stored rows of one share: the snapshot's status and its events. */
export async function judged(
  f: StateFixture,
  orderId: string,
  userId: string,
  role: Role,
): Promise<boolean> {
  const { beneficiaries } = await attributionOf(f, orderId);
  const beneficiary = beneficiaries.find((b) => b.userId === userId && b.role === role);
  expect(beneficiary, `${role} of ${orderId}`).toBeDefined();
  const initial: ShareInitialStatus = beneficiary!.initialStatus;
  const rows = await shareEvents(f, orderId);
  return isShareForfeited(
    initial,
    rows
      .filter((row) => row.user_id === userId && row.role === role)
      .map((row) => ({ eventSeq: row.event_seq, status: row.status as ShareEventStatus })),
  );
}

// ---------------------------------------------------------------------------------------------
// The four funds paths, through their entries.

/** R5 through credit-order on a transaction of its own. */
export function creditOf(f: StateFixture, order: SeededOrder): Promise<CreditOrderResult> {
  return f.db.transaction().execute((trx) =>
    f.credit.credit(trx, {
      appId: f.appId,
      orderId: order.orderId,
      expectedSettleSeq: 1,
      openedRef: `batch-item-${order.orderId}`,
    }),
  );
}

/** One R5a item through beneficiary-credit on a transaction of its own. */
export function executeItem(
  f: StateFixture,
  order: SeededOrder,
  beneficiaryCreditId: string,
): Promise<BeneficiaryCreditResult> {
  return f.db.transaction().execute((trx) =>
    f.beneficiaryCredit.execute(trx, {
      appId: f.appId,
      orderId: order.orderId,
      beneficiaryCreditId,
      expectedSettleSeq: 1,
      closedRef: `batch-item-${beneficiaryCreditId}`,
    }),
  );
}

export function obligationsOf(f: StateFixture, order: SeededOrder, role: Role) {
  return f.db
    .selectFrom('beneficiary_credits')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('order_id', '=', order.orderId)
    .where('role', '=', role)
    .execute();
}

/** An open first_credit obligation of a share that has none: synthetic, see the tests. */
export async function leaveObligationOpen(
  f: StateFixture,
  order: SeededOrder,
  userId: string,
  role: Role,
): Promise<string> {
  const beneficiaryCreditId = randomUUID();
  await f.db
    .insertInto('beneficiary_credits')
    .values({
      beneficiary_credit_id: beneficiaryCreditId,
      app_id: f.appId,
      order_id: order.orderId,
      user_id: userId,
      role,
      kind: 'first_credit',
      opened_by: 'R5',
      opened_ref: `batch-item-${order.orderId}`,
      origin_ledger_type: null,
      origin_sub_type: null,
      split_ref: 'commission_version:1',
      status: 'open',
      closed_by: null,
      closed_ref: null,
      voucher_id: null,
      opened_at: f.clock.now(),
      closed_at: null,
    })
    .execute();
  return beneficiaryCreditId;
}

/** A partial rights clawback bringing the union's new commission (BR-FUND-08 ①, R9). */
export async function partialRights(f: StateFixture, order: SeededOrder, newCommissionFen: bigint) {
  const orderRightsId = randomUUID();
  await f.db
    .insertInto('order_rights')
    .values({
      id: orderRightsId,
      app_id: f.appId,
      order_id: order.orderId,
      source: 'API',
      type: 'RIGHTS',
      status: 'SUCCEEDED',
      amount_fen: null,
      deduction_commission_fen: null,
      occurred_at: f.clock.now(),
      platform_rights_no: `rights-${orderRightsId}`,
    })
    .execute();
  const result = await f.db.transaction().execute((trx) =>
    f.clawback.apply(trx, {
      appId: f.appId,
      orderId: order.orderId,
      cause: 'RIGHTS',
      ref: { kind: 'rights', orderRightsId },
      newCommissionFen,
      rightsDeductFen: null,
    }),
  );
  return { result, eventId: `R${orderRightsId}` };
}

/** Every voucher key of the order, sorted. */
export async function voucherKeysOf(f: StateFixture, order: SeededOrder): Promise<string[]> {
  const rows = await f.db
    .selectFrom('ledger_vouchers')
    .select('uniq_key')
    .where('app_id', '=', f.appId)
    .where('order_key', '=', order.orderKey)
    .execute();
  return rows.map((row) => row.uniq_key).sort();
}

/**
 * The order's CLAWBACK vouchers are exactly these: a debit of each member's available and, when
 * `platformFen` is positive, a debit of COMMISSION_REVENUE, each against UNION_RECEIVABLE.
 */
export async function expectClawbacks(
  f: StateFixture,
  order: SeededOrder,
  eventId: string,
  members: readonly (readonly [string, Role, bigint])[],
  platformFen: bigint,
): Promise<void> {
  const credit = (fen: bigint) =>
    `UNION_RECEIVABLE:${order.platform}|platform|available|${String(-fen)}|CLAWBACK|RIGHTS`;
  const expected = new Map<string, string[]>();
  for (const [userId, role, fen] of members) {
    expected.set(`${order.orderKey}:${userId}:${role}:CLAWBACK:${eventId}`, [
      `USER_BALANCE|${userId}|available|${String(fen)}|CLAWBACK|RIGHTS`,
      credit(fen),
    ]);
  }
  expected.set(`${order.orderKey}:PLATFORM:CLAWBACK:${eventId}`, [
    `COMMISSION_REVENUE|platform|available|${String(platformFen)}|CLAWBACK|RIGHTS`,
    credit(platformFen),
  ]);
  const keys = (await voucherKeysOf(f, order)).filter((key) => key.includes(':CLAWBACK:'));
  expect(keys).toEqual([...expected.keys()].sort());
  for (const [key, lines] of expected) {
    expect(await voucherLines(f, key), key).toEqual([...lines].sort());
  }
}

// ---------------------------------------------------------------------------------------------
// The admin entry, on the fixture's keys.

export interface AdminEntry {
  /** An account with order.restore only. */
  readonly operator: AdminCaller;
  /** POST /admin/v1/recon-diffs/{recon_diff_id}/restore with a fresh key and totp step-up. */
  restore(reconDiffId: string, body?: unknown): Promise<AdminSent>;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload: string;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** Runs `run` against a started admin entry on the fixture's database, clock, keys and Redis. */
export async function withAdmin(
  f: StateFixture,
  run: (h: AdminEntry) => Promise<void>,
): Promise<void> {
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
  const dir = mkdtempSync(join(base, 'b2-09ga-'));
  writeFileSync(join(dir, 'master.hex'), f.master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(f.keyring), { mode: 0o600 });
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
        JWT_KEY_ID: 'b2_09ga_test',
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
    const id = randomUUID();
    await f.db
      .insertInto('admin_users')
      .values({
        id,
        app_id: f.appId,
        login_name: `restore_${id}`,
        password_hash: 'unused-test-login',
        is_super: false,
        status: 'active',
        password_must_change: false,
        totp_bound_at: f.clock.now(),
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      })
      .execute();
    await f.db
      .insertInto('admin_permissions')
      .values({
        app_id: f.appId,
        admin_id: id,
        permission_key: RESTORE,
        granted_by: id,
        granted_at: f.clock.now(),
      })
      .execute();
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
    const operator: AdminCaller = { id, token, sessionId: claims.sessionId };
    await run({
      operator,
      async restore(reconDiffId, body = {}) {
        const grant = await createAdminStepUpTokens({
          clock: f.clock,
          redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
        }).issue({ appId: f.appId, adminId: id, sessionId: claims.sessionId, tier: 'totp' });
        const response = await server.inject({
          method: 'POST',
          url: restorePath(reconDiffId),
          headers: {
            'content-type': 'application/json',
            'x-trace-id': randomUUID(),
            authorization: `Bearer ${token}`,
            'idempotency-key': newKey(),
            'x-step-up-token': grant.step_up_token,
          },
          payload: JSON.stringify(body),
          remoteAddress: '127.0.0.1',
        });
        return {
          op: 'restore',
          statusCode: response.statusCode,
          body: response.body,
          json: () => JSON.parse(response.body) as Envelope,
        };
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

/** The restore of one role of the member through the admin entry; it pays `paid` fen. */
export async function restoreShare(
  f: StateFixture,
  order: SeededOrder,
  userId: string,
  role: Role,
  paid: number,
): Promise<void> {
  const diff = await seedRestoreDiff(f, order, { userId, roles: [role] });
  await withAdmin(f, async (h) => {
    expect((await restored(await h.restore(diff.id))).restored_fen).toBe(paid);
  });
}
