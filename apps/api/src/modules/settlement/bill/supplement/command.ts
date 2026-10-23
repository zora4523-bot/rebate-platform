import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { BillJobDependencies } from '../job.ts';

// 补充批次（BR-FUND-04 ⑧⑨⑫）：finance 对同一月结账单发起补充校验与批次，流程同账单日任务
// （逐单校验、差错单经 ledger registerReconDiff、DRAFT 只经 settle-batch transition()、补记项只进
// 其订单平台的批次），kind = supplement，单独确认。step-up、HTTP 与审计归 B2-09。
// 补充批次不是账单生成：不等资产快照（③ 属账单日任务）。

/** 与账单日任务同一组端口（不含资产快照读口）。 */
export type SupplementDependencies = Omit<BillJobDependencies, 'snapshotStatus'>;

export interface SupplementInput {
  readonly appId: string;
  /** 目标月结账单（账单月 YYYY-MM）；范围与差错账期都按它，不按发起时所在月。 */
  readonly billId: string;
  readonly platform: string;
  /**
   * 发起请求的名义时刻，作幂等键：同一 (app, platform, requestedAt) 重放只生成一次
   * （settle_jobs 唯一键）。校验截点取注入的 Clock，不取此值。
   */
  readonly requestedAt: Date;
}

/** credit.enabled.<platform> off → on 后对当期账单（最近一份账单）重校验。 */
export interface RecheckInput {
  readonly appId: string;
  readonly platform: string;
  readonly requestedAt: Date;
}

export interface SupplementResult {
  readonly outcome: 'generated' | 'duplicate';
  readonly billId: string;
  readonly platform: string;
  /** 本轮新生成的补充批次；候选与补记项都为空时为空（SB1 守卫）。重放时为空。 */
  readonly batchIds: readonly string[];
}

export type SupplementRejectReason = 'bill_not_found' | 'bill_not_ready' | 'credit_disabled';

/** 发起前置条件不成立；不写任何表。内部错误，契约码待 B2-09 分配。 */
export interface SupplementRejected extends Error {
  readonly name: 'SupplementRejected';
  readonly reason: SupplementRejectReason;
}

export interface SupplementCommand {
  /** finance 对指定账单、指定平台发起补充校验与批次。 */
  launch(db: Kysely<DB>, input: SupplementInput): Promise<SupplementResult>;
  /** 开关打开后对当期账单重校验并生成补充批次；当期账单 = bill_id 最大的一份账单。 */
  recheckCurrentBill(db: Kysely<DB>, input: RecheckInput): Promise<SupplementResult>;
}

export function createSupplementCommand(dependencies: SupplementDependencies): SupplementCommand {
  void dependencies;
  throw new Error('NotImplemented: createSupplementCommand');
}
