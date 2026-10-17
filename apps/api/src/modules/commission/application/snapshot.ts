import type { components, UserLevel } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';
import type { Logger } from 'pino';
import type { Clock } from '../../platform/index.ts';

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
export function createCommissionSnapshot(
  trx: Transaction<DB>,
  input: CreateCommissionSnapshotInput,
  deps: CommissionSnapshotDependencies,
): Promise<CreateCommissionSnapshotResult> {
  void trx;
  void input;
  void deps;
  throw new Error('NotImplemented: createCommissionSnapshot');
}
