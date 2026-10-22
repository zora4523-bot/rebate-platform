import type { DB } from '@couli/db';
import type { ReconDiffType } from '@couli/contracts-ts';
import type { BillValidationResult, OrderRebateState, SettlementBillStatus } from '@couli/domain';
import type { Kysely, Transaction, Selectable } from 'kysely';
import type { Clock, JobPayload } from '../../platform/index.ts';

export interface BillJobInput {
  readonly appId: string;
  readonly platform: string;
  /** 名义账单日时刻；补跑保留原值，实际截点取 Clock。 */
  readonly runAt: Date;
}

export interface BillSourceSelection extends BillJobInput {
  readonly billId: string;
  readonly generationStartedAt: Date;
}

export interface BillSourceOrder {
  readonly orderId: string;
  readonly rebateStatus: Exclude<OrderRebateState, 'UNATTRIBUTED'>;
  readonly settlePeriod: string | null;
  readonly hold: boolean;
  readonly rightsPending: boolean;
  readonly commissionVersion: number;
  /** 由差错单结论读口提供，不以 closed 状态冒充「以联盟为准」。 */
  readonly unionAuthoritative: boolean;
}

export interface BillSourceSettlement {
  readonly seq: number;
  readonly source: 'API' | 'STATEMENT';
  readonly createdAt: Date;
  readonly settledAt: Date;
  readonly commissionFen: bigint;
}

/** 来源端口提供本 app/platform 的事实，范围、截点及最大 seq 由账单任务校验。 */
export interface BillSourceRow {
  readonly orderKey: string;
  readonly order: BillSourceOrder | null;
  readonly settlements: readonly BillSourceSettlement[];
}

export interface BillValidation {
  readonly orderKey: string;
  readonly orderId: string | null;
  readonly result: BillValidationResult;
  readonly settleSeq: number | null;
}

/** 消费方结构类型，与 B2-04i 公开读口兼容；不把 Nest 模块图引入纯服务测试。 */
export interface BillSnapshotSelection {
  readonly appId: string;
  readonly orderId: string;
  readonly commissionVersion: number;
}

export interface BillSnapshot {
  readonly baseFen: bigint;
  readonly reserveBp: number;
  readonly beneficiaries: readonly {
    readonly userId: string;
    readonly role: 'self' | 'share' | 'direct' | 'indirect';
    readonly ratioBp: number;
    readonly initialStatus: 'active' | 'forfeited';
  }[];
  readonly forfeitedEvents: readonly {
    readonly userId: string;
    readonly role: 'self' | 'share' | 'direct' | 'indirect';
  }[];
}

/** 与 ledger.registerReconDiff 兼容的登记输入；金额含义由发现差异的调用方给出。 */
export interface BillReconDiffInput {
  readonly appId: string;
  readonly type: ReconDiffType;
  readonly source: 'R1' | 'R2' | 'R3' | 'R4';
  readonly period: string;
  readonly refType: string;
  readonly refId: string;
  readonly expectedFen: bigint;
  readonly actualFen: bigint;
  readonly diffFen: bigint;
  readonly dedupeKey: string | null;
  readonly resolution: JobPayload | null;
}

export interface BillJobDependencies {
  readonly clock: Clock;
  readonly config: { get(appId: string, key: string): Promise<unknown> };
  readSource(trx: Transaction<DB>, input: BillSourceSelection): Promise<readonly BillSourceRow[]>;
  readSnapshot(trx: Transaction<DB>, input: BillSnapshotSelection): Promise<BillSnapshot | null>;
  /** 不可变快照里的淘礼金扣减；现有 B2-04i 尚未导出此字段。 */
  readTljDeductFen(trx: Transaction<DB>, input: BillSnapshotSelection): Promise<bigint>;
  snapshotStatus(
    db: Kysely<DB>,
    input: { readonly appId: string; readonly accountingDate: string },
    clock: Clock,
  ): Promise<{
    readonly state: 'pending' | 'complete' | 'timed_out';
    readonly snapshotId: string | null;
    readonly waitingComparable: boolean | null;
  }>;
  registerDiff(
    trx: Transaction<DB>,
    input: BillReconDiffInput,
    dependencies: { readonly clock: Clock },
  ): Promise<Selectable<DB['recon_diffs']>>;
  /** 同事务保存逐单结果，包括 off 平台；不写入 settle_batch_items 冒充候选。 */
  saveValidations(
    trx: Transaction<DB>,
    input: BillSourceSelection,
    rows: readonly BillValidation[],
  ): Promise<void>;
}

export interface BillJobResult {
  readonly outcome: 'generated' | 'duplicate' | 'deferred' | 'not_due';
  readonly billId: string;
  readonly status: SettlementBillStatus | null;
}

export interface BillJob {
  run(db: Kysely<DB>, input: BillJobInput): Promise<BillJobResult>;
}

// TODO(规划/11 §7.1): 编排补 settle_jobs 的生成状态机及逐单校验结果持久化接线 — blocked on 当前依赖未提供。
// TODO(规划/11 §7.1): orders 事实、淘礼金扣减及本入口的模块导出由编排接线 — blocked on 任务允许路径之外。
export function createBillJob(dependencies: BillJobDependencies): BillJob {
  void dependencies;
  throw new Error('NotImplemented: createBillJob');
}
