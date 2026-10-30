// B2-04la: settlement's attribution ports R3 / R3b (BR-FUND-01 rebate_status table), implementing
// orders' ClaimReviewDeps['rebate'].onClaimApproved (找回审核通过) and
// AdminAssignRebatePort.onAdminAssigned (后台指派).
//
// Contract:
//   - runs on the caller's transaction only; never opens, commits or rolls back one;
//   - lock order as B2-04m: the order_key advisory lock (orders' lockOrderKey, re-entrant) before any
//     read or write of the order row; no users rows, no balances, no ledger (R3 has no entries);
//   - `before` is orders' SELECT … FOR UPDATE row before it writes the attribution; the decision is
//     made on it first, then one CAS (rebate_status AND row_version, row_version + 1);
//   - R3 (UNATTRIBUTED, CLAIM_APPROVED / ADMIN_REASSIGN, guard locked = false): rebate_status ESTIMATED,
//     or WAITING when platform_status is RECEIVED / SETTLED and R4's guard holds (settle_period from
//     received_at, received_synced_at = input.now); locked = true;
//   - R3b (VOID, ADMIN_REASSIGN only, guard user_id empty and locked = false): rebate_status unchanged,
//     locked = true;
//   - anything else (incl. CLAIM_APPROVED on VOID and the closed R14) throws IllegalTransition, writes
//     nothing and logs a warn line with an alert;
//   - user_id, user_basis and the rebate history row stay with orders (it writes them after the port);
//   - time only from input.now (no injected clock, no SQL clock).
import type { DB } from '@couli/db';
import { chinaMonth } from '@couli/domain';
import type { Selectable, Transaction } from 'kysely';
import { lockOrderKey, type SnapshotOutcome } from '../../orders/index.ts';
import type { RootLogger } from '../../platform/index.ts';
import { IllegalTransition, RebateError } from '../rebate/application/errors.ts';
import {
  isCreditablePlatform,
  isReceivedOrSettled,
  periodBasisSupported,
  step,
} from '../rebate/domain/rules.ts';
import { casAttribute, type AttributionSet, type OrderRow } from './attribution-store.ts';
import { decideAttribution, type AttributionEvent } from './decide.ts';

/** Same shape as orders' ClaimApprovedInput and AdminAssignedInput. */
export interface AttributionInput {
  /** orders' SELECT … FOR UPDATE row, read before it writes the attribution. */
  readonly before: Selectable<DB['orders']>;
  /** The user the order is attributed to (orders writes user_id itself). */
  readonly userId: string;
  readonly now: Date;
  /** R3's snapshot outcome; none for R3b. */
  readonly snapshot: SnapshotOutcome;
}

/** Implements both orders ports: ClaimReviewDeps['rebate'] and AdminAssignRebatePort. */
export interface AttributionRebatePort {
  /** R3 with CLAIM_APPROVED (UNATTRIBUTED only; VOID is not accepted, 决-07 A). */
  onClaimApproved(trx: Transaction<DB>, input: AttributionInput): Promise<void>;
  /** R3 (UNATTRIBUTED) or R3b (VOID, status unchanged) with ADMIN_REASSIGN. */
  onAdminAssigned(trx: Transaction<DB>, input: AttributionInput): Promise<void>;
}

export interface AttributionRebateDependencies {
  readonly logger: Pick<RootLogger, 'info' | 'warn' | 'error'>;
  /** settle.period_basis.<platform> for R4's guard (same key as the rebate port). */
  readonly config: {
    get(appId: string, key: string): Promise<unknown>;
  };
}

export function createAttributionRebatePort(
  deps: AttributionRebateDependencies,
): AttributionRebatePort {
  const { logger } = deps;

  function illegal(row: OrderRow, event: AttributionEvent, detail: string): IllegalTransition {
    logger.warn(
      {
        app_id: row.app_id,
        platform: row.platform,
        rebate_status: row.rebate_status,
        event,
        alert: 'rebate_illegal_transition',
        outcome: 'rejected',
      },
      'attribution event outside the transition table or guard failed',
    );
    return new IllegalTransition(row.rebate_status, event, detail);
  }

  /**
   * R4（BR-FUND-04 ②）在 R3 之后同事务判定：平台已收货 / 结算、有 received_at、平台已登记可入账事件、
   * 结算月口径受支持才进 WAITING；守卫不过只停在 ESTIMATED，不抛错。
   */
  async function receive(row: OrderRow, now: Date): Promise<AttributionSet | null> {
    if (!isReceivedOrSettled(row.platform_status)) return null;
    const base = { app_id: row.app_id, platform: row.platform, rebate_status: 'ESTIMATED' };
    if (row.received_at === null) {
      logger.info({ ...base, reason: 'NO_RECEIVED_AT', outcome: 'r4_guard' }, 'waiting held back');
      return null;
    }
    if (!isCreditablePlatform(row.platform)) {
      logger.info(
        { ...base, reason: 'NO_CREDITABLE_EVENT', outcome: 'r4_guard' },
        'platform has no registered creditable event',
      );
      return null;
    }
    const basis = await deps.config.get(row.app_id, `settle.period_basis.${row.platform}`);
    if (!periodBasisSupported(basis)) {
      logger.error(
        { ...base, reason: 'PERIOD_BASIS_UNSUPPORTED', outcome: 'r4_guard' },
        'unsupported settle.period_basis; order kept ESTIMATED',
      );
      return null;
    }
    const next = step('ESTIMATED', 'PLATFORM_RECEIVED_OR_SETTLED');
    if (next === null) return null;
    // settle_period 写入后不重算；received_synced_at 取 input.now，已有值不覆写。
    return {
      rebate_status: next.to,
      ...(row.settle_period === null ? { settle_period: chinaMonth(row.received_at) } : {}),
      ...(row.received_synced_at === null ? { received_synced_at: now } : {}),
    };
  }

  async function run(
    trx: Transaction<DB>,
    input: AttributionInput,
    event: AttributionEvent,
  ): Promise<void> {
    const { before, now } = input;
    // 加锁照 B2-04m：订单键 advisory 锁先于订单行的任何读写（同事务可重入）；R3 / R3b 无分录，不锁 users、不锁余额。
    await lockOrderKey(trx, before.platform, before.sub_order_id);
    const decision = decideAttribution(before, event);
    if (decision.kind === 'illegal') throw illegal(before, event, decision.detail);
    let set: AttributionSet = {};
    if (decision.kind === 'R3') {
      set = (await receive(before, now)) ?? { rebate_status: decision.step.to };
    }
    const hit = await casAttribute(trx, before, set, now);
    if (!hit) {
      // 入参是写前快照：库内已变即不覆盖、不报成功；由调用方回滚。
      logger.warn(
        {
          app_id: before.app_id,
          platform: before.platform,
          rebate_status: before.rebate_status,
          event,
          alert: 'rebate_cas_conflict',
          outcome: 'cas_miss',
        },
        'attribution CAS matched no row; snapshot is stale',
      );
      throw new RebateError('ORDER_CAS_CONFLICT', 'order changed after the write-before snapshot');
    }
    logger.info(
      {
        app_id: before.app_id,
        platform: before.platform,
        event,
        rule: decision.kind,
        rebate_status: set.rebate_status ?? before.rebate_status,
        outcome: 'transitioned',
      },
      'attribution rebate status processed',
    );
  }

  return {
    async onClaimApproved(trx: Transaction<DB>, input: AttributionInput): Promise<void> {
      await run(trx, input, 'CLAIM_APPROVED');
    },
    async onAdminAssigned(trx: Transaction<DB>, input: AttributionInput): Promise<void> {
      await run(trx, input, 'ADMIN_REASSIGN');
    },
  };
}
