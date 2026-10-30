import type { DB } from '@couli/db';
import {
  SETTLE_BATCH_STATES,
  accountingDate,
  canScheduleSettlement,
  transitionSettleBatch,
  type SettleBatchEvent,
  type SettleBatchState,
} from '@couli/domain';
import type { Kysely, Selectable, Transaction, Updateable } from 'kysely';
import type { Clock } from '../../../platform/index.ts';

/** 服务端已鉴权的调用上下文；step-up 与 HTTP 错误映射在后台入口（B2-09f）。 */
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
  /** 账单下全部 DRAFT 的读版本（D10-444）；不能借此挑选部分批次确认。 */
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
   * settlement 内部端口：本次确认覆盖的批次。一次确认覆盖账单下全部 DRAFT，不分轮次与平台
   * （BR-FUND-04 ⑥，编排裁定 D10-444），生产实现（B2-09f）返回账单下全部 DRAFT 的 batch_id。
   * 必须在命令事务内读取；null 表示无法确定，保守拒绝。
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

/** 批次写成功后、提交前的回调（B2-09f：审计与响应回读同事务）；抛错则整笔回滚。 */
export type AfterBatchWrite<Change> = (trx: Transaction<DB>, change: Change) => Promise<void>;

/** 确认写入的结果：账单、结算方式与每个批次确认前后的状态。 */
export interface ConfirmChange {
  readonly billId: string;
  readonly mode: 'IMMEDIATE' | 'SCHEDULED';
  readonly scheduledAt: Date | null;
  readonly batches: readonly {
    readonly batchId: string;
    readonly from: string;
    readonly to: string;
  }[];
}

export interface BatchFacts {
  readonly status: string;
  readonly settleMode: string;
  readonly scheduledAt: Date | null;
}

/** 单批命令写入的结果：批次所属账单与写入前后的状态、结算方式、定时时刻。 */
export interface BatchChange {
  readonly batchId: string;
  readonly billId: string;
  readonly before: BatchFacts;
  readonly after: BatchFacts;
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
  /** SB2：同事务确认账单下全部 DRAFT，每批 row_version CAS；只到 CONFIRMED。 */
  confirmBill(input: ConfirmBillInput, afterWrite?: AfterBatchWrite<ConfirmChange>): Promise<void>;
  /** SB3：仅 CONFIRMED + SCHEDULED 且尚未开始执行。 */
  cancelSchedule(
    input: BatchCommandInput,
    afterWrite?: AfterBatchWrite<BatchChange>,
  ): Promise<void>;
  /** SB4：仅 DRAFT，原因必填；不处置批内订单。 */
  rejectBatch(input: RejectBatchInput, afterWrite?: AfterBatchWrite<BatchChange>): Promise<void>;
  /** SB8：仅 PARTIAL，两个开关开启且当日快照完成或超时。 */
  resumeBatch(input: BatchCommandInput, afterWrite?: AfterBatchWrite<BatchChange>): Promise<void>;
  /** TODO(规划/11 §4.2): 开放 SB10 手动开始 — blocked on 财务确认 */
  manualStart(input: BatchCommandInput): Promise<void>;
}

/** 20902（data.resource=settle_batch）：读版本过期、DRAFT 集合不符或并发输家。 */
export class BatchConflictError extends Error implements BatchConflict {
  readonly code = 20902 as const;
  readonly data = { resource: 'settle_batch' } as const;
  constructor(message = 'settle_batch row_version conflict') {
    super(message);
    this.name = 'BatchConflict';
  }
}

/** 表外迁移或迁移守卫不成立（BR-FUND-04 结算批次迁移表）。 */
export class IllegalTransitionError extends Error implements IllegalTransition {
  override readonly name = 'IllegalTransition' as const;
  constructor(message: string) {
    super(message);
  }
}

/** 命令前置条件不成立；内部错误，契约码由后台入口映射（B2-09f）。 */
export class BatchCommandRejectedError extends Error implements BatchCommandRejected {
  override readonly name = 'BatchCommandRejected' as const;
  readonly reason: BatchCommandRejected['reason'];
  constructor(reason: BatchCommandRejected['reason']) {
    super(`settle batch command rejected: ${reason}`);
    this.reason = reason;
  }
}

/** SB8 等待期间连续跨会计日的重查上限；超过即保守拒绝，批次保持 PARTIAL。 */
const MAX_DAY_RECHECKS = 2;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stateOf(status: string): SettleBatchState {
  if (!(SETTLE_BATCH_STATES as readonly string[]).includes(status)) {
    throw new IllegalTransitionError(`unknown settle batch status ${JSON.stringify(status)}`);
  }
  return status as SettleBatchState;
}

/** 只经生成的 transition() 判定表内迁移；表外一律 IllegalTransition。 */
function nextState(status: string, event: SettleBatchEvent): SettleBatchState {
  const result = transitionSettleBatch(stateOf(status), event);
  if (!result.ok || result.noop) {
    throw new IllegalTransitionError(`settle batch ${status} --${event}--> not allowed`);
  }
  return result.to;
}

/** SB2 结算方式守卫：立即不得带时间；定时须严格晚于确认时刻且不在名义快照时段（BR-FUND-18）。 */
function settleMode(
  input: ConfirmBillInput,
  now: Date,
): { mode: 'IMMEDIATE' | 'SCHEDULED'; scheduledAt: Date | null } {
  const mode = input.mode ?? 'IMMEDIATE';
  if (mode === 'IMMEDIATE') {
    if (input.scheduledAt !== undefined) throw new BatchCommandRejectedError('invalid_schedule');
    return { mode, scheduledAt: null };
  }
  if (mode !== 'SCHEDULED') throw new BatchCommandRejectedError('invalid_schedule');
  const at = input.scheduledAt;
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new BatchCommandRejectedError('invalid_schedule');
  }
  if (!canScheduleSettlement(now, at)) throw new BatchCommandRejectedError('invalid_schedule');
  return { mode, scheduledAt: at };
}

function statusOnly(row: Selectable<DB['settle_batches']>, status: string): BatchFacts {
  return { status, settleMode: row.settle_mode, scheduledAt: row.scheduled_at };
}

function batchChange(row: Selectable<DB['settle_batches']>, after: BatchFacts): BatchChange {
  return {
    batchId: row.batch_id,
    billId: row.bill_id,
    before: statusOnly(row, row.status),
    after,
  };
}

export function createBatchCommandService(deps: BatchCommandDeps): BatchCommandService {
  const { db, clock } = deps;

  /** 单批命令：按 app_id 加行锁读取，先核 CAS 读版本，再判迁移。 */
  async function lockBatch(trx: Transaction<DB>, input: BatchCommandInput) {
    if (!UUID.test(input.batchId)) throw new BatchCommandRejectedError('batch_not_found');
    const row = await trx
      .selectFrom('settle_batches')
      .selectAll()
      .where('app_id', '=', input.appId)
      .where('batch_id', '=', input.batchId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new BatchCommandRejectedError('batch_not_found');
    if (row.row_version !== input.expectedRowVersion) throw new BatchConflictError();
    return row;
  }

  /** CAS 写：带读版本与源状态，影响行数不为 1 即并发输家（20902）。 */
  async function casUpdate(
    trx: Transaction<DB>,
    input: BatchCommandInput,
    from: string,
    set: Updateable<DB['settle_batches']>,
  ): Promise<void> {
    const result = await trx
      .updateTable('settle_batches')
      .set((eb) => ({ ...set, row_version: eb('row_version', '+', 1) }))
      .where('app_id', '=', input.appId)
      .where('batch_id', '=', input.batchId)
      .where('row_version', '=', input.expectedRowVersion)
      .where('status', '=', from)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new BatchConflictError();
  }

  return {
    async confirmBill(input, afterWrite) {
      // 事务前先按当前时刻快速拒绝明显无效的结算方式；锁后再按锁后时刻复核（见下）。
      settleMode(input, clock.now());
      await db.transaction().execute(async (trx) => {
        // 账单行锁串行化同一账单的确认；生成未完成不得确认（防止只确认部分批次）。
        const bill = await trx
          .selectFrom('settle_bills')
          .select(['generated_at'])
          .where('app_id', '=', input.appId)
          .where('bill_id', '=', input.billId)
          .forUpdate()
          .executeTakeFirst();
        if (bill === undefined || bill.generated_at === null) {
          throw new BatchCommandRejectedError('bill_not_ready');
        }
        const round = await deps.currentRound(trx, { appId: input.appId, billId: input.billId });
        if (round === null) throw new BatchCommandRejectedError('round_unavailable');
        const roundIds = [...new Set(round)];
        if (roundIds.some((id) => !UUID.test(id))) throw new BatchConflictError();
        const members =
          roundIds.length === 0
            ? []
            : await trx
                .selectFrom('settle_batches')
                .selectAll()
                .where('app_id', '=', input.appId)
                .where('batch_id', 'in', roundIds)
                .orderBy('batch_id')
                .forUpdate()
                .execute();
        // 成员必须全部属于本 app、本账单；否则整笔拒绝，不越 app / 越账单确认。
        if (members.length !== roundIds.length || members.some((m) => m.bill_id !== input.billId)) {
          throw new BatchConflictError('settle_batch round membership mismatch');
        }
        const drafts = new Map(
          members.filter((m) => m.status === 'DRAFT').map((m) => [m.batch_id, m]),
        );
        if (drafts.size === 0 && input.expectedBatches.length === 0) {
          throw new IllegalTransitionError('settle bill has no DRAFT batch to confirm');
        }
        // 一次确认全部 DRAFT：读版本集合必须与这些 DRAFT 一一对应，不能挑选、重复或夹带。
        const seen = new Set<string>();
        for (const expected of input.expectedBatches) {
          const draft = drafts.get(expected.batchId);
          if (
            seen.has(expected.batchId) ||
            draft === undefined ||
            draft.row_version !== expected.expectedRowVersion
          ) {
            throw new BatchConflictError();
          }
          seen.add(expected.batchId);
        }
        if (seen.size !== drafts.size) throw new BatchConflictError();
        // 确认时刻取在全部行锁之后：等待连接或行锁期间时钟前进，定时守卫与 confirmed_at 都按锁后时刻。
        const now = clock.now();
        const { mode, scheduledAt } = settleMode(input, now);
        const batches: ConfirmChange['batches'][number][] = [];
        for (const draft of drafts.values()) {
          const to = nextState(draft.status, 'CONFIRM');
          await casUpdate(
            trx,
            {
              appId: input.appId,
              adminId: input.adminId,
              batchId: draft.batch_id,
              expectedRowVersion: draft.row_version,
            },
            draft.status,
            {
              status: to,
              settle_mode: mode,
              scheduled_at: scheduledAt,
              confirmed_by: input.adminId,
              confirmed_at: now,
            },
          );
          batches.push({ batchId: draft.batch_id, from: draft.status, to });
        }
        await afterWrite?.(trx, { billId: input.billId, mode, scheduledAt, batches });
      });
    },

    async cancelSchedule(input, afterWrite) {
      await db.transaction().execute(async (trx) => {
        const row = await lockBatch(trx, input);
        const to = nextState(row.status, 'CANCEL_SCHEDULE');
        // SB3 守卫：定时结算且尚未开始执行。
        if (
          row.settle_mode !== 'SCHEDULED' ||
          row.scheduled_at === null ||
          row.started_at !== null
        ) {
          throw new IllegalTransitionError(
            'only a scheduled batch not yet started can be cancelled',
          );
        }
        // 回到 DRAFT 即未确认：清掉确认信息与定时，须重新确认（SB2）才能执行。
        await casUpdate(trx, input, row.status, {
          status: to,
          settle_mode: 'IMMEDIATE',
          scheduled_at: null,
          confirmed_by: null,
          confirmed_at: null,
        });
        await afterWrite?.(
          trx,
          batchChange(row, { status: to, settleMode: 'IMMEDIATE', scheduledAt: null }),
        );
      });
    },

    async rejectBatch(input, afterWrite) {
      if (typeof input.reason !== 'string' || input.reason.trim() === '') {
        throw new BatchCommandRejectedError('reason_required');
      }
      await db.transaction().execute(async (trx) => {
        const row = await lockBatch(trx, input);
        const to = nextState(row.status, 'REJECT');
        // SB4：批内订单保持 WAITING，明细与账务不动。
        await casUpdate(trx, input, row.status, { status: to, cancelled_reason: input.reason });
        await afterWrite?.(trx, batchChange(row, statusOnly(row, to)));
      });
    },

    async resumeBatch(input, afterWrite) {
      await db.transaction().execute(async (trx) => {
        const row = await lockBatch(trx, input);
        const to = nextState(row.status, 'RESUME');
        // 时刻取在行锁之后：等待连接或行锁跨过午夜时，按新会计日的快照判定，不沿用等待前的日期。
        let at = clock.now();
        for (let recheck = 0; ; recheck += 1) {
          const ready = await deps.readiness({ appId: input.appId, platform: row.platform, at });
          // SB8 守卫：两个开关都为 on；当日快照已完成或已超时。
          if (!ready.autoEnabled || !ready.creditEnabled) {
            throw new BatchCommandRejectedError('switches_off');
          }
          if (!ready.snapshotCompleted && !ready.snapshotTimedOut) {
            throw new BatchCommandRejectedError('snapshot_pending');
          }
          // 查询期间跨会计日：昨日快照结论作废，按新日期重新校验；不满足即拒绝，批次保持 PARTIAL。
          const after = clock.now();
          if (accountingDate(after) === accountingDate(at)) break;
          if (recheck >= MAX_DAY_RECHECKS) throw new BatchCommandRejectedError('snapshot_pending');
          at = after;
        }
        // 只迁移批次；明细由执行器（B2-04p）续跑。
        await casUpdate(trx, input, row.status, { status: to });
        await afterWrite?.(trx, batchChange(row, statusOnly(row, to)));
      });
    },

    async manualStart(input) {
      void input;
      // TODO(规划/11 §4.2): 开放 SB10 手动开始（CONFIRMED + MANUAL_START → EXECUTING） — blocked on 财务确认
      // 迁移表未加 SB10 行，transition('CONFIRMED', 'MANUAL_START') 按表外事件拒绝；不读不写任何表。
      throw new IllegalTransitionError('SB10 manual start is not open before finance confirmation');
    },
  };
}
