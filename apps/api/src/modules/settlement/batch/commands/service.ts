import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../../../platform/index.ts';

/** 服务端已鉴权的调用上下文；step-up 与 HTTP 错误映射归 B2-09。 */
export interface CommandActor {
  readonly appId: string;
  readonly adminId: string;
}

export interface BatchVersion {
  readonly batchId: string;
  readonly expectedRowVersion: number;
}

export interface ConfirmBillInput extends CommandActor {
  readonly billId: string;
  /** 本轮全部 DRAFT 的读版本；不能借此挑选部分批次确认。 */
  readonly expectedBatches: readonly BatchVersion[];
  /** 省略时为 IMMEDIATE。 */
  readonly mode?: 'IMMEDIATE' | 'SCHEDULED';
  readonly scheduledAt?: Date;
}

export interface BatchCommandInput extends CommandActor, BatchVersion {}

export interface RejectBatchInput extends BatchCommandInput {
  readonly reason: string;
}

export interface ExecutionReadiness {
  readonly autoEnabled: boolean;
  readonly creditEnabled: boolean;
  readonly snapshotCompleted: boolean;
  readonly snapshotTimedOut: boolean;
}

export interface BatchCommandDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /**
   * settlement 内部端口，由生成流程提供权威的最近一轮成员，包含该轮非 DRAFT。
   * 必须在命令事务内读取；null 表示无法确定，保守拒绝，不能退化成全账单 DRAFT。
   * 现有 schema 无 round 列；不把 settle_run_id 或 created_at 臆定为轮次身份。
   * TODO(规划/11 §4.2): 接入生成流程的轮次成员持久化查询 — blocked on 编排确定轮次存储映射
   */
  readonly currentRound: (
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly billId: string },
  ) => Promise<readonly string[] | null>;
  /** 查询当前平台开关与当日快照；不执行批次，不读写余额。 */
  readonly readiness: (input: {
    readonly appId: string;
    readonly platform: string;
    readonly at: Date;
  }) => Promise<ExecutionReadiness>;
}

/** 内部错误形状；只有并发冲突已有契约码，其余不抢先分配 HTTP 错误码。 */
export interface BatchConflict extends Error {
  readonly code: 20902;
  readonly data: { readonly resource: 'settle_batch' };
}

export interface IllegalTransition extends Error {
  readonly name: 'IllegalTransition';
}

export interface BatchCommandRejected extends Error {
  readonly name: 'BatchCommandRejected';
  readonly reason:
    | 'invalid_schedule'
    | 'reason_required'
    | 'switches_off'
    | 'snapshot_pending'
    | 'round_unavailable'
    | 'batch_not_found'
    | 'bill_not_ready';
}

export interface BatchCommandService {
  /** SB2：同事务确认本轮全部 DRAFT，每批 row_version CAS；只到 CONFIRMED。 */
  confirmBill(input: ConfirmBillInput): Promise<void>;
  /** SB3：仅 CONFIRMED + SCHEDULED 且尚未开始执行。 */
  cancelSchedule(input: BatchCommandInput): Promise<void>;
  /** SB4：仅 DRAFT，原因必填；不处置批内订单。 */
  rejectBatch(input: RejectBatchInput): Promise<void>;
  /** SB8：仅 PARTIAL，两个开关开启且当日快照完成或超时。 */
  resumeBatch(input: BatchCommandInput): Promise<void>;
  /** TODO(规划/11 §4.2): 开放 SB10 手动开始 — blocked on 财务确认 */
  manualStart(input: BatchCommandInput): Promise<void>;
}

export function createBatchCommandService(deps: BatchCommandDeps): BatchCommandService {
  void deps;
  throw new Error('NotImplemented: createBatchCommandService');
}
