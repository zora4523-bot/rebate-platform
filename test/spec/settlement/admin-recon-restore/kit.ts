// B2-09g rule-test kit (claude-independent, SPEC_REF 81273415): contracts/openapi.yaml
// restoreAdminReconDiff (POST /admin/v1/recon-diffs/{recon_diff_id}/restore: order.restore, step-up
// tier totp, Idempotency-Key; checks in the contract's order; effects in one transaction for each
// role of resolution.shares: an active beneficiary event, floor(booked_base_fen × ratio / 10000)
// less the role's net as ADMIN_ADJUST:RESTORE:APPEAL; the difference adjusted with resolution.restore
// and note; audit recon_diff_restore) and 08 BR-FUND-22 ③, BR-CALC-09, BR-CALC-13; 编排裁定 D10-468 ①,
// D10-469 ① ② ③.
// Real pieces: the admin entry (createHttpApp('admin'): admin token, session and permission checks,
// the step-up gate over Redis, contract validation, PostgreSQL idempotency, admin's audit writer),
// ledger, PostgreSQL through @couli/db/testing as couli_app, Redis for the admin sessions
// (../../payment/orders/kit.ts suite).
// Synthetic: the difference as risk's producer registers it (resolution of
// apps/api/src/modules/risk/application/appeal-restore.ts), a CREDITED order with its commission
// snapshot and the vouchers its credit left (optionally the later vouchers of a role key, a newer
// settled amount still waiting for approval, or a full clawback for PUNISH), members, risk and
// deletion rows, admin accounts, and a one-shot fault in the entry's database handle for the
// roll-back cases. The totp step-up token is issued the way POST /admin/v1/auth/step-up issues it
// after a correct authenticator code. No real user or merchant data. Expected amounts are written
// by hand in the tests; the seeds derive their own vouchers from the BR-CALC-02 / BR-CALC-04
// formulas.
//
// Default order: N = 1000, reserve_bp 1500 → booked_base_fen 850, reserve 150; self 5000 / direct
// 1000 / indirect 500 → 425 / 85 / 42. Direct was forfeited for banned at the credit: no credit, a
// FORFEIT voucher of 85. PLATFORM:CREDIT is the rest, 1000 − 425 − 42 − 85 = 448, so that the
// order's receivable is N. The snapshot was taken on the estimate N + 3333: its base_fen and
// amounts are never what a restore pays.
// Missing pieces fail as assertions (an unregistered admin route answers 404).
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { addFen, mulDivFloor, subFen } from '@couli/money';
import { PostgresQueryCompiler, sql, type KyselyPlugin, type Selectable } from 'kysely';
import { expect } from 'vitest';
import { createAdminTokens } from '../../../../apps/api/src/modules/admin/application/admin-tokens.ts';
import {
  ADMIN_STEP_UP_NAMESPACE,
  createAdminStepUpTokens,
} from '../../../../apps/api/src/modules/admin/application/permission-guard.ts';
import { createAdminSessions } from '../../../../apps/api/src/modules/admin/infra/admin-sessions.ts';
import {
  createLedger,
  getOrderNets,
  type Ledger,
  type OrderNets,
  type PostingEntry,
  type PostingVoucher,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  createWrappedKeyring,
  LocalKeyProvider,
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
import { createValidatorCompiler } from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  diffNow,
  fixture as appFixture,
  type HeldLock,
} from '../../ledger/admin-recon-close/kit.ts';
import {
  contractPaths,
  normalize,
  seedDiff,
  type DiffRow,
  type DiffSeed,
  type Fixture,
} from '../../ledger/admin-recon-diffs/kit.ts';
import type { Suite } from '../../payment/orders/kit.ts';

export {
  audits,
  chars,
  diffNow,
  holdNow,
  holdRow,
  idempotencyRows,
  seedHold,
  sourceOf,
  suite,
  track,
  waiting,
} from '../../ledger/admin-recon-close/kit.ts';
export {
  DETAIL_KEYS,
  detailView,
  normalize,
  seedDiff,
  type DiffRow,
} from '../../ledger/admin-recon-diffs/kit.ts';

export const RESTORE_PATH = '/admin/v1/recon-diffs/{recon_diff_id}/restore';
export const DETAIL_PATH = '/admin/v1/recon-diffs/{recon_diff_id}';
/** specs/permissions.yaml: order.restore (step-up tier totp) restores; fund.* only read / close. */
export const RESTORE = 'order.restore';
export const RECON = 'fund.recon';
export const VIEW = 'fund.view';
/** The audit action of the contract (restoreAdminReconDiff). */
export const RESTORE_ACTION = 'recon_diff_restore';

/** The commission snapshot and the orders of the fixture. */
const ATTR_AT = new Date('2026-08-20T00:00:00.000Z');
/** The batch that credited the order. */
const CREDITED_AT = new Date('2026-09-10T00:00:00.000Z');
/** The forfeiture of a banned share (BR-CALC-13). */
export const FORFEITED_AT = new Date('2026-09-10T00:00:01.000Z');
const SETTLE_PERIOD = '2026-08';
/** The month the appeal closed (risk's producer: chinaMonth(appeals.closed_at)). */
const RESTORE_PERIOD = '2026-10';
/** The snapshot's estimate is N + this, so its amounts never equal the booked ones. */
const SNAPSHOT_DRIFT_FEN = 3333n;
const SUBSIDY_FEN = 111n;
/** The rights_event_id of the fixture's PUNISH clawback (platform ref: `P{row_version}`). */
const PUNISH_EVENT = 'P1';

const ROOT = new URL('../../../../', import.meta.url);

export type Role = 'self' | 'share' | 'direct' | 'indirect';
export type MemberStatus = 'normal' | 'deleting' | 'deleted';

/** BR-FUND-05 entry types of a beneficiary CREDIT per role. */
const CREDIT_TYPES: Readonly<Record<Role, { type: string; sub: string | null }>> = {
  self: { type: 'REBATE_CREDIT', sub: null },
  share: { type: 'SHARE_CREDIT', sub: null },
  direct: { type: 'REFERRAL_CREDIT', sub: 'DIRECT' },
  indirect: { type: 'REFERRAL_CREDIT', sub: 'INDIRECT' },
};

// ---------------------------------------------------------------------------------------------
// One app on the suite's database. Every value below is synthetic.

export interface RestoreFixture extends Fixture {
  /** The ledger of the seeds. */
  readonly ledger: Ledger;
  readonly ruleVersionId: string;
  /** user id → balance account id. */
  readonly accounts: Map<string, string>;
}

export async function fixture(s: Suite): Promise<RestoreFixture> {
  const base = appFixture(s);
  const ruleVersionId = randomUUID();
  await base.db
    .insertInto('commission_rule_versions')
    .values({
      app_id: base.appId,
      rule_version_id: ruleVersionId,
      status: 'published',
      effective_from: ATTR_AT,
      indirect_enabled: true,
      created_at: ATTR_AT,
    })
    .execute();
  return {
    ...base,
    ledger: createLedger({ clock: base.clock }),
    ruleVersionId,
    accounts: new Map(),
  };
}

/** A synthetic member of the fixture's app with a balance account (BR-FUND-13). */
export async function memberOf(
  f: RestoreFixture,
  status: MemberStatus = 'normal',
): Promise<string> {
  const id = randomUUID();
  await f.db
    .insertInto('users')
    .values({
      id,
      app_id: f.appId,
      nickname: 'synthetic',
      avatar: '',
      invite_code: randomUUID(),
      attr_code: randomUUID(),
      level: 'L1',
      status,
      register_method: 'phone',
    })
    .execute();
  const account = await f.db
    .transaction()
    .execute((trx) => f.ledger.openUserAccount(trx, { appId: f.appId, userId: id }));
  f.accounts.set(id, account.account_id);
  return id;
}

/** The member's account state now (user_risk_state). */
export async function setRisk(
  f: RestoreFixture,
  userId: string,
  state: 'frozen' | 'appealing' | 'banned',
): Promise<void> {
  await f.db
    .insertInto('user_risk_state')
    .values({
      user_id: userId,
      app_id: f.appId,
      state,
      reason: null,
      reason_category: 'other',
      frozen_until: null,
      changed_by: 'test',
      changed_at: f.clock.now(),
    })
    .execute();
}

/** An open deletion request inside its cooling-off window: users.status stays normal (BR-ID-28). */
export async function setCooling(f: RestoreFixture, userId: string): Promise<void> {
  await f.db
    .insertInto('deletion_requests')
    .values({
      id: randomUUID(),
      app_id: f.appId,
      user_id: userId,
      status: 'cooling',
      apply_at: new Date(f.clock.now().getTime() - 86_400_000),
      cooling_until: new Date(f.clock.now().getTime() + 30 * 86_400_000),
      balance_snapshot_fen: 0n,
    })
    .execute();
}

export interface PersonSpec {
  readonly role: Role;
  readonly ratioBp: number;
  /** An existing member; a new one when omitted. */
  readonly userId?: string;
  /** Forfeited for banned at the credit: a forfeited event after the active one. */
  readonly forfeited?: boolean;
  /** Net booked for the role (default: nothing when forfeited, else the whole share). */
  readonly creditedFen?: bigint;
  /** What the role's FORFEIT voucher booked (default: the share less creditedFen). */
  readonly forfeitFen?: bigint;
  /** Vouchers of the role's key after its credit, in order. */
  readonly steps?: readonly NetStep[];
}

/** One voucher of a role's key after its credit (BR-FUND-08): the signed change of the net. */
export interface NetStep {
  readonly kind: 'SETTLE_ADJUST' | 'CLAWBACK' | 'REASSIGN_REV' | 'REASSIGN_CREDIT';
  readonly fen: bigint;
}

export interface OrderSpec {
  readonly people?: readonly PersonSpec[];
  /** N: booked_n_fen and, without newSettleFen, orders.settle_commission_fen. */
  readonly settleFen?: bigint;
  /**
   * A newer settled amount whose positive difference waits for approval (BR-FUND-09):
   * orders.settle_commission_fen and a second order_settlements row; the booked pair stays at N.
   */
  readonly newSettleFen?: bigint;
  readonly reserveBp?: number;
  /** Clawed back in full for PUNISH after the credit (R8): booked pair 0, settled amount kept. */
  readonly punished?: boolean;
}

export interface SeededPerson {
  readonly userId: string;
  readonly role: Role;
  readonly ratioBp: number;
  readonly forfeited: boolean;
  readonly creditedFen: bigint;
  readonly forfeitFen: bigint;
  readonly steps: readonly NetStep[];
}

export interface SeededOrder {
  readonly orderId: string;
  readonly platform: string;
  readonly subOrderId: string;
  readonly orderKey: string;
  readonly bookedBaseFen: bigint;
  readonly people: readonly SeededPerson[];
  user(role: Role): string;
}

export const DEFAULT_PEOPLE: readonly PersonSpec[] = [
  { role: 'self', ratioBp: 5000 },
  { role: 'direct', ratioBp: 1000, forfeited: true },
  { role: 'indirect', ratioBp: 500 },
];

/** BR-CALC-02 (no tlj): floor(N × (10000 − reserve_bp) / 10000). */
function baseAt(n: bigint, reserveBp: number): bigint {
  return mulDivFloor(n, BigInt(10000 - reserveBp), 10000n);
}

/** BR-CALC-04: floor(B × ratio / 10000). */
function shareAt(base: bigint, ratioBp: number): bigint {
  return mulDivFloor(base, BigInt(ratioBp), 10000n);
}

function platformLine(subject: string, amount: bigint, type: string, sub: string | null) {
  const entry: PostingEntry = {
    account: { ownerType: 'platform', subject },
    sub_account: 'available',
    amount_fen: amount,
    ledger_type: type,
    sub_type: sub,
    income_type: null,
  };
  return entry;
}

/** One voucher on its own transaction, its beneficiary's balance row locked first. */
async function post(f: RestoreFixture, voucher: PostingVoucher): Promise<void> {
  await f.db.transaction().execute(async (trx) => {
    if (voucher.beneficiaryUserId !== null) {
      await f.ledger.lockBalances(trx, { appId: f.appId, userIds: [voucher.beneficiaryUserId] });
    }
    await f.ledger.post(trx, voucher);
  });
}

/** Debit UNION_RECEIVABLE:{platform}, credit COMMISSION_REVENUE (PLATFORM:CREDIT and FORFEIT). */
function platformVoucher(
  f: RestoreFixture,
  order: { readonly platform: string; readonly orderKey: string },
  uniqKey: string,
  kind: string,
  amount: bigint,
  memo: string | null,
): PostingVoucher {
  return {
    appId: f.appId,
    uniqKey,
    bizType: 'ORDER_CREDIT',
    bizId: order.orderKey,
    operator: 'system',
    memo,
    orderKey: order.orderKey,
    beneficiaryUserId: null,
    role: null,
    voucherKind: kind,
    entries: [
      platformLine(`UNION_RECEIVABLE:${order.platform}`, amount, 'REBATE_CREDIT', null),
      platformLine('COMMISSION_REVENUE', -amount, 'REBATE_CREDIT', null),
    ],
  };
}

/** Debit UNION_RECEIVABLE:{platform}, credit the member's available (CREDIT). */
function creditVoucher(
  f: RestoreFixture,
  order: { readonly platform: string; readonly orderKey: string },
  person: SeededPerson,
): PostingVoucher {
  const accountId = f.accounts.get(person.userId);
  if (accountId === undefined) throw new Error('fixture: the member has no account');
  const { type, sub } = CREDIT_TYPES[person.role];
  return {
    appId: f.appId,
    uniqKey: `${order.orderKey}:${person.userId}:${person.role}:CREDIT`,
    bizType: 'ORDER_CREDIT',
    bizId: order.orderKey,
    operator: 'system',
    memo: null,
    orderKey: order.orderKey,
    beneficiaryUserId: person.userId,
    role: person.role,
    voucherKind: 'CREDIT',
    entries: [
      platformLine(`UNION_RECEIVABLE:${order.platform}`, person.creditedFen, type, sub),
      {
        account: { ownerType: 'user', accountId },
        sub_account: 'available',
        amount_fen: -person.creditedFen,
        ledger_type: type,
        sub_type: sub,
        income_type: null,
      },
    ],
  };
}

const STEP_KEYS: Readonly<Record<NetStep['kind'], string>> = {
  SETTLE_ADJUST: 'ADJ',
  CLAWBACK: 'CLAWBACK',
  REASSIGN_REV: 'REASSIGN_REV',
  REASSIGN_CREDIT: 'REASSIGN_CREDIT',
};

/**
 * A later voucher of the member's key between UNION_RECEIVABLE:{platform} and the member's
 * available, in the BR-FUND-05 types of its kind (R14 keeps the types of the credit).
 */
function stepVoucher(
  f: RestoreFixture,
  order: { readonly platform: string; readonly orderKey: string },
  person: SeededPerson,
  step: NetStep,
  event: string,
  clawbackSub = 'RIGHTS',
): PostingVoucher {
  const accountId = f.accounts.get(person.userId);
  if (accountId === undefined) throw new Error('fixture: the member has no account');
  const { type, sub } =
    step.kind === 'SETTLE_ADJUST'
      ? { type: 'SETTLE_ADJUST', sub: 'SETTLE_DIFF' }
      : step.kind === 'CLAWBACK'
        ? { type: 'CLAWBACK', sub: clawbackSub }
        : CREDIT_TYPES[person.role];
  return {
    appId: f.appId,
    uniqKey: `${order.orderKey}:${person.userId}:${person.role}:${STEP_KEYS[step.kind]}:${event}`,
    bizType: `ORDER_${step.kind}`,
    bizId: order.orderKey,
    operator: 'system',
    memo: null,
    orderKey: order.orderKey,
    beneficiaryUserId: person.userId,
    role: person.role,
    voucherKind: step.kind,
    entries: [
      platformLine(`UNION_RECEIVABLE:${order.platform}`, step.fen, type, sub),
      {
        account: { ownerType: 'user', accountId },
        sub_account: 'available',
        amount_fen: -step.fen,
        ledger_type: type,
        sub_type: sub,
        income_type: null,
      },
    ],
  };
}

/** Debit COMMISSION_REVENUE, credit UNION_RECEIVABLE:{platform}: the platform's PUNISH clawback. */
function punishPlatformVoucher(
  f: RestoreFixture,
  order: { readonly platform: string; readonly orderKey: string },
  amount: bigint,
): PostingVoucher {
  return {
    appId: f.appId,
    uniqKey: `${order.orderKey}:PLATFORM:CLAWBACK:${PUNISH_EVENT}`,
    bizType: 'ORDER_CLAWBACK',
    bizId: order.orderKey,
    operator: 'system',
    memo: null,
    orderKey: order.orderKey,
    beneficiaryUserId: null,
    role: null,
    voucherKind: 'CLAWBACK',
    entries: [
      platformLine('COMMISSION_REVENUE', amount, 'CLAWBACK', 'PUNISH'),
      platformLine(`UNION_RECEIVABLE:${order.platform}`, -amount, 'CLAWBACK', 'PUNISH'),
    ],
  };
}

/**
 * A CREDITED order with its snapshot, share events and the vouchers of its credit, plus the steps
 * of each role; CLAWED_BACK with the vouchers of the clawback when `punished`.
 */
export async function seedOrder(f: RestoreFixture, spec: OrderSpec = {}): Promise<SeededOrder> {
  const orderId = randomUUID();
  const platform = 'taobao';
  const subOrderId = `restore-${orderId}`;
  const orderKey = `${platform}:${subOrderId}`;
  const n = spec.settleFen ?? 1000n;
  const reserveBp = spec.reserveBp ?? 1500;
  const punished = spec.punished === true;
  // The base of the credit; R8 leaves booked_base_fen 0 on a punished order.
  const creditBaseFen = baseAt(n, reserveBp);
  const bookedBaseFen = punished ? 0n : creditBaseFen;

  const people: SeededPerson[] = [];
  for (const p of spec.people ?? DEFAULT_PEOPLE) {
    const shareFen = shareAt(creditBaseFen, p.ratioBp);
    const forfeited = p.forfeited === true;
    const creditedFen = p.creditedFen ?? (forfeited ? 0n : shareFen);
    people.push({
      userId: p.userId ?? (await memberOf(f)),
      role: p.role,
      ratioBp: p.ratioBp,
      forfeited,
      creditedFen,
      forfeitFen: forfeited ? (p.forfeitFen ?? subFen(shareFen, creditedFen)) : 0n,
      steps: p.steps ?? [],
    });
  }

  // The immutable snapshot (version 1), taken on the estimate rawN, not on any settled N.
  const rawN = addFen(n, SNAPSHOT_DRIFT_FEN);
  const nTotal = addFen(rawN, SUBSIDY_FEN);
  const snapBase = baseAt(rawN, reserveBp);
  const snapAmounts = people.map((p) => shareAt(snapBase, p.ratioBp));
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
      platform_status: 'SETTLED',
      rebate_status: punished ? 'CLAWED_BACK' : 'CREDITED',
      reason: punished ? 'PUNISH' : null,
      hold: false,
      rights_pending: false,
      commission_version: 1,
      est_commission_fen: rawN,
      settle_commission_fen: spec.newSettleFen ?? n,
      subsidy_commission_fen: SUBSIDY_FEN,
      initial_est_fen: rawN,
      n_total_fen: nTotal,
      pre_base_deduct_fen: subFen(nTotal, snapBase),
      base_fen: snapBase,
      platform_est_profit_fen: subFen(nTotal, snapUserTotal),
      activity_type: null,
      paid_at: ATTR_AT,
      received_at: ATTR_AT,
      settle_period: SETTLE_PERIOD,
      booked_base_fen: bookedBaseFen,
      booked_n_fen: punished ? 0n : n,
      credited_at: CREDITED_AT,
      quantity: 1,
      refunded_quantity: 0,
      created_at: ATTR_AT,
      updated_at: CREDITED_AT,
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
      reserve_bp: reserveBp,
      reserve_fen: subFen(rawN, snapBase),
      tlj_deduct_fen: 0n,
      base_fen: snapBase,
      platform_retain_fen: subFen(snapBase, snapUserTotal),
      beneficiaries: JSON.stringify(
        people.map((p) => ({
          user_id: p.userId,
          role: p.role,
          ratio_bp: p.ratioBp,
          level: 'L1',
          initial_status: 'active',
          forfeit_reason: null,
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
      people.map((p, i) => ({
        app_id: f.appId,
        order_id: orderId,
        commission_version: 1,
        user_id: p.userId,
        role: p.role,
        base_fen: snapBase,
        amount_fen: snapAmounts[i] ?? 0n,
        created_at: ATTR_AT,
      })),
    )
    .execute();
  await f.db
    .insertInto('order_settlements')
    .values({
      app_id: f.appId,
      order_id: orderId,
      seq: 1,
      source: 'STATEMENT',
      settle_commission_fen: n,
      settled_at: ATTR_AT,
      content_hash: randomUUID(),
      created_at: ATTR_AT,
    })
    .execute();
  if (spec.newSettleFen !== undefined) {
    await f.db
      .insertInto('order_settlements')
      .values({
        app_id: f.appId,
        order_id: orderId,
        seq: 2,
        source: 'STATEMENT',
        settle_commission_fen: spec.newSettleFen,
        settled_at: CREDITED_AT,
        content_hash: randomUUID(),
        created_at: CREDITED_AT,
      })
      .execute();
  }
  for (const p of people) {
    await f.db
      .insertInto('commission_split_beneficiary_events')
      .values({
        app_id: f.appId,
        order_id: orderId,
        user_id: p.userId,
        role: p.role,
        status: 'active',
        reason: null,
        created_at: ATTR_AT,
      })
      .execute();
    if (p.forfeited) {
      await f.db
        .insertInto('commission_split_beneficiary_events')
        .values({
          app_id: f.appId,
          order_id: orderId,
          user_id: p.userId,
          role: p.role,
          status: 'forfeited',
          reason: 'banned',
          created_at: FORFEITED_AT,
        })
        .execute();
    }
  }

  const ref = { platform, orderKey };
  let platformFen = n;
  for (const p of people) {
    platformFen = subFen(subFen(platformFen, p.creditedFen), p.forfeitFen);
    if (p.creditedFen > 0n) await post(f, creditVoucher(f, ref, p));
    if (p.forfeitFen > 0n) {
      await post(
        f,
        platformVoucher(
          f,
          ref,
          `${orderKey}:PLATFORM:FORFEIT:${p.userId}:${p.role}`,
          'FORFEIT',
          p.forfeitFen,
          'forfeit_reason=banned',
        ),
      );
    }
  }
  if (platformFen < 0n) throw new Error('fixture: the shares exceed N');
  if (platformFen > 0n) {
    await post(
      f,
      platformVoucher(f, ref, `${orderKey}:PLATFORM:CREDIT`, 'CREDIT', platformFen, null),
    );
  }
  for (const p of people) {
    for (const [index, step] of p.steps.entries()) {
      await post(f, stepVoucher(f, ref, p, step, String(index + 1)));
    }
  }
  if (punished) {
    let revenueFen = n;
    for (const p of people) {
      const net = p.steps.reduce((sum, step) => addFen(sum, step.fen), p.creditedFen);
      revenueFen = subFen(revenueFen, net);
      if (net > 0n) {
        const step: NetStep = { kind: 'CLAWBACK', fen: subFen(0n, net) };
        await post(f, stepVoucher(f, ref, p, step, PUNISH_EVENT, 'PUNISH'));
      }
    }
    if (revenueFen > 0n) await post(f, punishPlatformVoucher(f, ref, revenueFen));
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

/** The resolution risk's producer stores for `shares` of one member on one sub-order. */
export function restoreResolution(
  order: SeededOrder,
  userId: string,
  shares: readonly SeededPerson[],
  appealId = randomUUID(),
): Record<string, unknown> {
  return {
    reason_code: 'APPEAL_RESTORE',
    appeal_id: appealId,
    order_id: order.orderId,
    order_key: order.orderKey,
    user_id: userId,
    forfeit_reason: 'banned',
    shares: shares.map((p) => ({
      role: p.role,
      amount_fen: p.forfeitFen.toString(),
      forfeited_at: FORFEITED_AT.toISOString(),
    })),
  };
}

/**
 * The appeal_restore difference of the order's forfeited shares of one member (default: the first
 * forfeited person), as the producer registers it; `roles` narrows the shares it lists.
 */
export function seedRestoreDiff(
  f: RestoreFixture,
  order: SeededOrder,
  options: {
    readonly userId?: string;
    readonly roles?: readonly Role[];
    readonly patch?: DiffSeed;
  } = {},
): Promise<DiffRow> {
  const userId = options.userId ?? order.people.find((p) => p.forfeited)?.userId;
  if (userId === undefined) throw new Error('fixture: the order has no forfeited share');
  const shares = order.people.filter(
    (p) =>
      p.userId === userId &&
      (options.roles === undefined ? p.forfeited : options.roles.includes(p.role)),
  );
  const expectedFen = shares.reduce((sum, p) => addFen(sum, p.forfeitFen), 0n);
  const appealId = randomUUID();
  const roles = shares.map((p) => p.role).sort();
  return seedDiff(f, {
    source: 'R3',
    type: 'appeal_restore',
    period: RESTORE_PERIOD,
    ref_type: 'order',
    ref_id: order.orderKey,
    expected_fen: expectedFen,
    actual_fen: 0n,
    diff_fen: expectedFen,
    dedupe_key: `appeal_restore:${f.appId}:${appealId}:${order.orderId}:${userId}:${roles.join('+')}`,
    resolution: restoreResolution(order, userId, shares, appealId),
    ...options.patch,
  });
}

export interface Case {
  readonly order: SeededOrder;
  readonly diff: DiffRow;
  /** The member of the difference. */
  readonly userId: string;
}

/** The default order and the difference of its forfeited direct share (85 fen). */
export async function seedCase(f: RestoreFixture, spec: OrderSpec = {}): Promise<Case> {
  const order = await seedOrder(f, spec);
  const diff = await seedRestoreDiff(f, order);
  return { order, diff, userId: order.people.find((p) => p.forfeited)!.userId };
}

// ---------------------------------------------------------------------------------------------
// What a restore may change.

/** The uniq_key of the role's restore voucher (BR-FUND-22 ③, specs/ledger-templates.csv). */
export function restoreKey(orderKey: string, userId: string, role: Role, diffId: string): string {
  return `${orderKey}:${userId}:${role}:RESTORE:${diffId}`;
}

/** Everything of the fixture's app a restore may write, for before / after comparisons. */
export async function everything(f: RestoreFixture) {
  return {
    diffs: await f.db
      .selectFrom('recon_diffs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    orders: await f.db
      .selectFrom('orders')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('order_id')
      .execute(),
    shareEvents: await f.db
      .selectFrom('commission_split_beneficiary_events')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('event_seq')
      .execute(),
    vouchers: await f.db
      .selectFrom('ledger_vouchers')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('uniq_key')
      .execute(),
    entries: await f.db
      .selectFrom('ledger_entries')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    balances: await f.db
      .selectFrom('account_balances')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('account_id')
      .execute(),
    holds: await f.db
      .selectFrom('withdraw_holds')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
    risk: await f.db
      .selectFrom('user_risk_state')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('user_id')
      .execute(),
    audits: await f.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', f.appId)
      .orderBy('id')
      .execute(),
  };
}

/** Every voucher of the app whose uniq_key marks a restore. */
export async function restoreVouchers(f: RestoreFixture) {
  const rows = await f.db
    .selectFrom('ledger_vouchers')
    .selectAll()
    .where('app_id', '=', f.appId)
    .orderBy('uniq_key')
    .execute();
  return rows.filter((row) => row.uniq_key.includes(':RESTORE:'));
}

/** The entries of one voucher as sorted `subject|owner|sub_account|amount|type|sub_type`. */
export async function voucherLines(f: RestoreFixture, uniqKey: string): Promise<string[]> {
  const rows = await f.db
    .selectFrom('ledger_entries as e')
    .innerJoin('ledger_vouchers as v', (join) =>
      join.onRef('v.id', '=', 'e.voucher_id').onRef('v.app_id', '=', 'e.app_id'),
    )
    .innerJoin('ledger_accounts as a', (join) =>
      join.onRef('a.id', '=', 'e.account_id').onRef('a.app_id', '=', 'e.app_id'),
    )
    .select([
      'a.subject',
      'a.owner_id',
      'e.sub_account',
      'e.amount_fen',
      'e.ledger_type',
      'e.sub_type',
    ])
    .where('e.app_id', '=', f.appId)
    .where('v.uniq_key', '=', uniqKey)
    .execute();
  return rows
    .map(
      (r) =>
        `${r.subject}|${r.owner_id ?? ''}|${r.sub_account ?? ''}|${String(r.amount_fen)}|${r.ledger_type ?? ''}|${r.sub_type ?? ''}`,
    )
    .sort();
}

/** The two entries of a restore of `amount` to `userId` (debit positive). */
export function restoreLines(userId: string, amount: bigint): string[] {
  return [
    `COMMISSION_REVENUE|platform|available|${String(amount)}|ADMIN_ADJUST|RESTORE`,
    `USER_BALANCE|${userId}|available|${String(-amount)}|ADMIN_ADJUST|RESTORE`,
  ].sort();
}

/** The member's available balance. */
export async function available(f: RestoreFixture, userId: string): Promise<bigint> {
  const [row] = await f.ledger.getBalances(f.db, { appId: f.appId, userIds: [userId] });
  expect(row, `balance of ${userId}`).toBeDefined();
  return row!.available_fen;
}

/** ledger's BR-FUND-08 / BR-FUND-19 ④⑤ nets of the order, read on a fresh transaction. */
export function netsOf(f: RestoreFixture, orderKey: string): Promise<OrderNets> {
  return f.db.transaction().execute((trx) => getOrderNets(trx, { appId: f.appId, orderKey }));
}

/** The net of one beneficiary key (0 when the key has no voucher). */
export function netOf(nets: OrderNets, userId: string, role: Role): bigint {
  const found = nets.beneficiaries.find((b) => b.beneficiary_user_id === userId && b.role === role);
  return found?.net_fen ?? 0n;
}

export type ShareEventRow = Selectable<DB['commission_split_beneficiary_events']>;

/** The order's share events, oldest first. */
export function shareEvents(f: RestoreFixture, orderId: string): Promise<ShareEventRow[]> {
  return f.db
    .selectFrom('commission_split_beneficiary_events')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('order_id', '=', orderId)
    .orderBy('event_seq')
    .execute();
}

/** Holds the order key's advisory lock (orders' lockOrderKey) from the suite's second pool. */
export async function holdOrderKey(f: RestoreFixture, orderKey: string): Promise<HeldLock> {
  const text = `orders.order_key:${orderKey}`;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = f.s
    .holder()
    .transaction()
    .execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${text}, 0))`.execute(trx);
      locked();
      await gate;
    });
  await Promise.race([ready, done]);
  return {
    async release() {
      open();
      await done;
    },
  };
}

/**
 * Holds the member's users row from the suite's second pool; release() sets users.status to
 * deleting on that transaction and commits, as deletion-expiry does under the same row lock
 * (identity/application/deletion-expiry.ts ① ⑥).
 */
export async function holdUserIntoDeleting(f: RestoreFixture, userId: string): Promise<HeldLock> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = f.s
    .holder()
    .transaction()
    .execute(async (trx) => {
      const rows = await sql`SELECT id FROM app.users
        WHERE app_id = ${f.appId} AND id = ${userId} FOR UPDATE`.execute(trx);
      expect(rows.rows, `users ${userId}`).toHaveLength(1);
      locked();
      await gate;
      const moved = await sql`UPDATE app.users
        SET status = 'deleting', row_version = row_version + 1, updated_at = ${f.clock.now()}
        WHERE app_id = ${f.appId} AND id = ${userId} AND status = 'normal'
        RETURNING id`.execute(trx);
      expect(moved.rows, `users ${userId}`).toHaveLength(1);
    });
  await Promise.race([ready, done]);
  return {
    async release() {
      open();
      await done;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// A one-shot fault in the entry's database handle.

/**
 * Where the next failure is thrown: the INSERT of the recon_diff_restore audit record, the UPDATE
 * of recon_diffs, the INSERT of a ledger voucher, or the INSERT of a share event.
 */
export type FaultPoint = 'audit' | 'diff_update' | 'voucher' | 'share_event';
export const FAULT_POINTS: readonly FaultPoint[] = [
  'audit',
  'diff_update',
  'voucher',
  'share_event',
];

export interface Fault {
  /** One-shot: set it, the next matching statement fails and it goes back to null. */
  point: FaultPoint | null;
  tripped: number;
}

function faultHit(point: FaultPoint, text: string, parameters: readonly unknown[]): boolean {
  const table = String.raw`(?:"?app"?\s*\.\s*)?"?`;
  if (point === 'audit') {
    return (
      new RegExp(String.raw`\binsert\s+into\s+${table}audit_logs\b`, 'i').test(text) &&
      (text.includes(RESTORE_ACTION) || JSON.stringify(parameters).includes(RESTORE_ACTION))
    );
  }
  if (point === 'diff_update') {
    return new RegExp(String.raw`\bupdate\s+${table}recon_diffs\b`, 'i').test(text);
  }
  const into = point === 'voucher' ? 'ledger_vouchers' : 'commission_split_beneficiary_events';
  return new RegExp(String.raw`\binsert\s+into\s+${table}${into}\b`, 'i').test(text);
}

function faultPlugin(fault: Fault): KyselyPlugin {
  const compiler = new PostgresQueryCompiler();
  return {
    transformQuery({ node, queryId }) {
      const point = fault.point;
      if (point === null) return node;
      const compiled = compiler.compileQuery(node, queryId);
      if (faultHit(point, compiled.sql, compiled.parameters)) {
        fault.point = null;
        fault.tripped += 1;
        throw new Error(`synthetic failure at ${point}`);
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The admin entry.

export type Operation = 'restore' | 'detail';

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
  readonly sessionId: string;
}

export interface RestoreOptions {
  /** Idempotency-Key: a fresh one by default; null sends none. */
  readonly key?: string | null;
  /** The caller: `operator` by default; null sends no token. */
  readonly caller?: AdminCaller | null;
  /** X-Step-Up-Token: a fresh totp-tier token of the caller by default; null sends none. */
  readonly stepUp?: string | null;
}

export interface RestoreAdmin {
  readonly fault: Fault;
  /** An admin account of the fixture app with these permission points (or a super admin). */
  caller(
    permissions: readonly string[],
    options?: { readonly superAdmin?: boolean },
  ): Promise<AdminCaller>;
  /** A step-up token of the caller's account and admin session (tier totp by default). */
  stepUp(caller: AdminCaller, tier?: 'totp' | 'sms'): Promise<string>;
  /** POST /admin/v1/recon-diffs/{recon_diff_id}/restore with the JSON body ({} by default). */
  restore(reconDiffId: string, body?: unknown, options?: RestoreOptions): Promise<AdminSent>;
  /** GET /admin/v1/recon-diffs/{recon_diff_id} as `viewer`. */
  detail(reconDiffId: string): Promise<AdminSent>;
  /** An account with order.restore only. */
  readonly operator: AdminCaller;
  /** An account with fund.recon and fund.view (closes and reads, cannot restore). */
  readonly viewer: AdminCaller;
}

interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(token: unknown): T;
  inject(input: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<{ statusCode: number; body: string }>;
}

/** A fresh Idempotency-Key of the contract format (8–64 of [A-Za-z0-9_-]). */
export function newKey(): string {
  return `rs_${randomBytes(12).toString('hex')}`;
}

/** The concrete path of the restore of a difference (also the idempotency scope's path). */
export function restorePath(reconDiffId: string): string {
  return `/admin/v1/recon-diffs/${encodeURIComponent(reconDiffId)}/restore`;
}

/**
 * Runs `run` against a started admin entry on the fixture's database (through the fault plugin),
 * clock and Redis.
 */
export async function withRestoreAdmin(
  f: RestoreFixture,
  run: (h: RestoreAdmin) => Promise<void>,
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
  const dir = mkdtempSync(join(base, 'b2-09g-'));
  const master = randomBytes(32);
  const keyring = await createWrappedKeyring(new LocalKeyProvider(master));
  writeFileSync(join(dir, 'master.hex'), master.toString('hex'), { mode: 0o600 });
  writeFileSync(join(dir, 'keyring.json'), JSON.stringify(keyring), { mode: 0o600 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tokenKey = randomBytes(32);
  const fault: Fault = { point: null, tripped: 0 };
  const store = f.db.withPlugin(faultPlugin(fault));
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
        JWT_KEY_ID: 'b2_09g_test',
        JWT_PRIVATE_KEY_PEM: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'admin', appEnv: 'test', level: 'silent' },
        { write: () => undefined },
      ),
      dbHandles: { db: store, dbRead: null, close: async () => undefined },
      redisUrl: loadConnectionConfig('admin', {
        DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        DATABASE_READ_URL: 'postgres://couli_app@127.0.0.1:1/unused',
        REDIS_URL: f.s.redisUrl(),
      }).redisUrl,
    });
    await app.init();
    const server = app;
    const redis = server.get<RedisHandle>(REDIS);
    const caller: RestoreAdmin['caller'] = async (permissions, options = {}) => {
      const id = randomUUID();
      await f.db
        .insertInto('admin_users')
        .values({
          id,
          app_id: f.appId,
          login_name: `restore_${id}`,
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
      return { id, token, sessionId: claims.sessionId };
    };
    const stepUp: RestoreAdmin['stepUp'] = async (who, tier = 'totp') => {
      const grant = await createAdminStepUpTokens({
        clock: f.clock,
        redis: redis.namespace(ADMIN_STEP_UP_NAMESPACE),
      }).issue({ appId: f.appId, adminId: who.id, sessionId: who.sessionId, tier });
      return grant.step_up_token;
    };
    const operator = await caller([RESTORE]);
    const viewer = await caller([RECON, VIEW]);
    const sent = (op: Operation, response: { statusCode: number; body: string }): AdminSent => ({
      op,
      statusCode: response.statusCode,
      body: response.body,
      json: () => JSON.parse(response.body) as Envelope,
    });
    await run({
      fault,
      caller,
      stepUp,
      operator,
      viewer,
      async restore(reconDiffId, body = {}, options = {}) {
        const who = options.caller === undefined ? operator : options.caller;
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-trace-id': randomUUID(),
        };
        if (who !== null) headers['authorization'] = `Bearer ${who.token}`;
        if (options.key !== null) headers['idempotency-key'] = options.key ?? newKey();
        const token =
          options.stepUp !== undefined ? options.stepUp : who === null ? null : await stepUp(who);
        if (token !== null) headers['x-step-up-token'] = token;
        const response = await server.inject({
          method: 'POST',
          url: restorePath(reconDiffId),
          headers,
          payload: JSON.stringify(body),
          remoteAddress: '127.0.0.1',
        });
        return sent('restore', response);
      },
      async detail(reconDiffId) {
        const response = await server.inject({
          method: 'GET',
          url: `/admin/v1/recon-diffs/${encodeURIComponent(reconDiffId)}`,
          headers: { authorization: `Bearer ${viewer.token}`, 'x-trace-id': randomUUID() },
          remoteAddress: '127.0.0.1',
        });
        return sent('detail', response);
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

const PATHS: Record<Operation, { path: string; method: 'get' | 'post' }> = {
  restore: { path: RESTORE_PATH, method: 'post' },
  detail: { path: DETAIL_PATH, method: 'get' },
};

const HTTP_STATUS: Record<number, number> = {
  0: 200,
  10001: 401,
  10003: 403,
  10403: 403,
  20001: 400,
  20901: 409,
  20902: 409,
  40901: 409,
  50001: 500,
};

/** The response body conforms to its operation's schema of its status class. */
export async function conforms(sent: AdminSent): Promise<void> {
  const { path, method } = PATHS[sent.op];
  const status = sent.statusCode < 400 ? '200' : sent.statusCode < 500 ? '4XX' : '5XX';
  const schema = (await contractPaths())[path]?.[method]?.responses[status]?.content?.[
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

export interface Restored {
  /** data.recon_diff, its instants as epoch milliseconds. */
  readonly recon_diff: Record<string, unknown>;
  readonly restored_fen: unknown;
}

/** The data of a successful restore: exactly recon_diff and restored_fen. */
export async function restored(sent: AdminSent): Promise<Restored> {
  const body = await answer(sent, 0);
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data).sort(), sent.body).toEqual(['recon_diff', 'restored_fen']);
  return { recon_diff: normalize(data['recon_diff']), restored_fen: data['restored_fen'] };
}

/** The 20902 of a difference that is no longer open or processing. */
export function conflict(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20902, { resource: 'recon_diff' });
}

/** The 20001 of an id that names no restorable difference of the app (no reason). */
export function unknownDiff(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 20001, { fields: ['recon_diff_id'] });
}

/** The 20001 of a difference this operation does not handle, with its reason. */
export function refused(
  sent: AdminSent,
  reason: 'restore_not_supported' | 'restore_user_deleted',
): Promise<Envelope> {
  return answer(sent, 20001, { fields: ['recon_diff_id'], reason });
}

/** The 10403 of an account without order.restore. */
export function denied(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10403, { reason: 'admin_permission_denied' });
}

/** The 10003 of a missing or wrong totp-tier step-up token. */
export function stepUpRequired(sent: AdminSent): Promise<Envelope> {
  return answer(sent, 10003, { tier: 'totp' });
}

/**
 * The difference after a restore by `adminId` at the fixture's clock: status adjusted, handler,
 * both instants the clock, the three amounts as registered, resolution the stored keys plus
 * restore { shares [{ role, restored_fen }], restored_fen, operator, restored_at } (the amounts as
 * strings, like the producer's amount_fen) and (when given) the trimmed note; every other column
 * as it was. Returns the row.
 */
export async function expectRestored(
  f: RestoreFixture,
  before: DiffRow,
  expected: {
    readonly adminId: string;
    /** The amount paid for each role listed in the difference. */
    readonly paid: Readonly<Record<string, bigint>>;
    readonly note?: string;
  },
): Promise<DiffRow> {
  const now = await diffNow(f, before.id);
  const resolution = now.resolution as Record<string, unknown> | null;
  expect(typeof resolution === 'object' && resolution !== null, JSON.stringify(resolution)).toBe(
    true,
  );
  const restore = resolution!['restore'] as Record<string, unknown> | undefined;
  expect(Object.keys(restore ?? {}).sort(), JSON.stringify(resolution)).toEqual([
    'operator',
    'restored_at',
    'restored_fen',
    'shares',
  ]);
  const paid = Object.entries(expected.paid).sort(([a], [b]) => (a < b ? -1 : 1));
  const total = paid.reduce((sum, [, fen]) => addFen(sum, fen), 0n);
  const shares = [...(restore!['shares'] as { role: string }[])].sort((a, b) =>
    a.role < b.role ? -1 : 1,
  );
  expect(shares).toEqual(paid.map(([role, fen]) => ({ role, restored_fen: fen.toString() })));
  expect(restore!['restored_fen']).toBe(total.toString());
  expect(restore!['operator']).toBe(expected.adminId);
  expect(typeof restore!['restored_at']).toBe('string');
  expect(Date.parse(restore!['restored_at'] as string)).toBe(f.clock.now().getTime());
  expect(resolution).toEqual({
    ...(before.resolution as Record<string, unknown>),
    restore,
    ...(expected.note === undefined ? {} : { note: expected.note }),
  });
  expect(now).toEqual({
    ...before,
    status: 'adjusted',
    handler_id: expected.adminId,
    closed_at: f.clock.now(),
    updated_at: f.clock.now(),
    resolution: now.resolution,
  });
  return now;
}
