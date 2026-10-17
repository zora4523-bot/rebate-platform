import type { components, UserLevel } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';
import type { Logger } from 'pino';
import type { Clock } from '../../platform/index.ts';
import { planSnapshot, selectSnapshotRuleVersion } from '../domain/snapshot.ts';
import {
  findSplit,
  insertSnapshot,
  readPublishedVersionsForShare,
} from '../infra/snapshot-store.ts';

export interface SnapshotBeneficiary {
  readonly userId: string;
  readonly level: UserLevel;
  readonly status: 'active' | 'forfeited';
  readonly forfeitReason: string | null;
}

export interface SnapshotBeneficiaries {
  readonly owner: SnapshotBeneficiary;
  readonly direct: SnapshotBeneficiary | null;
  readonly indirect: SnapshotBeneficiary | null;
  readonly warnings: readonly { readonly code: string; readonly userId?: string }[];
}

// TODO(规划/11 §4.2): 实现 paid_at 历史等级与关系解析器 — blocked on B1-11a
export interface SnapshotBeneficiaryResolver {
  resolve(
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly ownerUserId: string; readonly paidAt: Date },
  ): Promise<SnapshotBeneficiaries>;
}

export interface CreateCommissionSnapshotInput {
  readonly appId: string;
  readonly orderId: string;
  readonly platform: components['schemas']['PlatformCode'];
  readonly paidAt: Date;
  readonly paidAtSource: 'platform' | 'platform_modified' | 'observed';
  readonly orderType: 'self' | 'share';
  readonly activityType: string | null;
  /** 非淘礼金为 null；红包已净扣时调用方传 tljRedpacketFen=0。 */
  readonly rebateMode: 'none' | 'normal' | null;
  readonly nBaseFen: bigint;
  readonly subsidyCommissionFen: bigint;
  readonly tljDeductFen: bigint;
  readonly tljRedpacketFen: bigint | null;
  readonly ownerUserId: string;
}

export interface CommissionSnapshotDependencies {
  readonly clock: Clock;
  readonly logger: Pick<Logger, 'warn'>;
  readonly beneficiaries: SnapshotBeneficiaryResolver;
}

export type CommissionSnapshot = Selectable<DB['commission_splits']>;

export type CreateCommissionSnapshotResult =
  | { readonly kind: 'created' | 'existing'; readonly split: CommissionSnapshot }
  | { readonly kind: 'pending'; readonly reason: string };

/**
 * BR-CALC-10/11/12/13/27：只使用调用方事务，读取本 app 已发布未撤销版本并 FOR SHARE。
 * 按秒选 paidAt 版本，早于首版告警回退；缺版本/所需规则/预留返回 pending 且零写入。
 * 四表同事务写 v1；唯一键竞争须保留调用方事务可用性，重放原样返回已有快照。
 */
export async function createCommissionSnapshot(
  trx: Transaction<DB>,
  input: CreateCommissionSnapshotInput,
  deps: CommissionSnapshotDependencies,
): Promise<CreateCommissionSnapshotResult> {
  const { clock, logger, beneficiaries } = deps;
  const ctx = { app_id: input.appId, order_id: input.orderId };

  // BR-CALC-10: a replay never rebuilds the snapshot, whatever the new input says.
  const existing = await findSplit(trx, input.appId, input.orderId);
  if (existing !== undefined) return { kind: 'existing', split: existing };

  const versions = await readPublishedVersionsForShare(trx, input.appId);
  const choice = selectSnapshotRuleVersion(versions, input.paidAt);
  if (choice.kind === 'none') {
    const reason = 'no published rule version';
    logger.warn(
      { ...ctx, code: 'COMMISSION_SNAPSHOT_PENDING', reason },
      'commission snapshot pending',
    );
    return { kind: 'pending', reason };
  }
  const { version } = choice;
  if (choice.beforeFirst) {
    logger.warn(
      {
        ...ctx,
        code: 'PAID_AT_BEFORE_FIRST_RULE_VERSION',
        rule_version_id: version.rule_version_id,
      },
      'paid_at is earlier than the first rule version; using the first version',
    );
  }

  const people = await beneficiaries.resolve(trx, {
    appId: input.appId,
    ownerUserId: input.ownerUserId,
    paidAt: input.paidAt,
  });
  if (people.owner.userId !== input.ownerUserId) {
    throw new Error('commission: beneficiary resolver returned a different owner');
  }
  for (const warning of people.warnings) {
    logger.warn(
      { ...ctx, code: warning.code, user_id: warning.userId ?? null },
      'commission snapshot beneficiary warning',
    );
  }

  const plan = planSnapshot({
    version,
    platform: input.platform,
    orderType: input.orderType,
    rebateMode: input.rebateMode,
    nBaseFen: input.nBaseFen,
    subsidyCommissionFen: input.subsidyCommissionFen,
    tljDeductFen: input.tljDeductFen,
    tljRedpacketFen: input.tljRedpacketFen,
    people,
  });
  if (plan.kind === 'pending') {
    logger.warn(
      {
        ...ctx,
        code: 'COMMISSION_SNAPSHOT_PENDING',
        rule_version_id: version.rule_version_id,
        reason: plan.reason,
      },
      'commission snapshot pending',
    );
    return { kind: 'pending', reason: plan.reason };
  }
  for (const code of plan.warnings) {
    logger.warn(
      { ...ctx, code, rule_version_id: version.rule_version_id },
      'commission snapshot warning',
    );
  }

  const written = await insertSnapshot(trx, {
    appId: input.appId,
    orderId: input.orderId,
    ruleVersionId: version.rule_version_id,
    orderType: input.orderType,
    activityType: input.activityType,
    rebateMode: input.rebateMode,
    paidAt: input.paidAt,
    paidAtSource: input.paidAtSource,
    rawNFen: input.nBaseFen,
    subsidyCommissionFen: input.subsidyCommissionFen,
    tljDeductFen: input.tljDeductFen,
    plan,
    createdAt: clock.now(),
  });
  if (written.kind === 'inserted') return { kind: 'created', split: written.split };
  // A concurrent writer committed the same order first; its snapshot is the snapshot.
  const winner = await findSplit(trx, input.appId, input.orderId);
  if (winner === undefined) {
    throw new Error('commission: snapshot key taken but no snapshot of this app is readable');
  }
  return { kind: 'existing', split: winner };
}
