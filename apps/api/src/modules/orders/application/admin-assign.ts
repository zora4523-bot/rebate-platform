// B1-10f：后台未归因订单指派的用例（POST /admin/v1/orders/{order_id}/reassign；契约 adminReassignOrder，
// 权限点 order.assign、动态码档；BR-ATTR-31、BR-ATTR-20 ①③、BR-FUND-01 R3 / R3b）。路由仍为 planned、
// 不挂载（J-1：settlement 的 rebate.onAdminAssigned 有真实实现前不上线，挂载并入找回通过的挂载任务）；
// 本文件只给应用服务。
// 事务（一次指派一个事务）：
//   ① 首句取子订单 advisory 锁（与同步、找回同一把，order-lock.ts），再 SELECT … FOR UPDATE 重读订单；
//   ② 复查：user_id 非空、或 locked 与 expected_locked 不符 → 20902（resource=order_attribution），不做
//      任何修改；同一事务里读目标用户的风控状态（banned → target_banned）与注销阶段（cooling /
//      processing → target_deleting，done → target_deleted），拒绝为 20001 data.fields=[user_id]
//      与 data.reason，不写订单、不生成快照，写审计（被拒原因）；冻结、申诉中照常指派；
//   ③ 复查通过：来源回填（BR-ATTR-15）→ 分佣快照（UNATTRIBUTED 走 R3 时经 runCommissionSnapshot；
//      VOID 走 R3b 不生成）→ settlement 端口 rebate.onAdminAssigned（入参是写前快照；locked 与
//      rebate_status 由端口按 R3 / R3b 写）→ orders 写 user_id、user_basis=admin → order_status_history
//      （field=rebate、source=admin）→ order_assignments（只插入，source=admin）→ 该子订单其他用户的
//      待审找回子项 rejected NOT_IN_POOL → 审计 → 本事务内入队 order.reassigned。
// 端口、审计、事件任一失败都原样抛出，整事务回滚。响应是提交后 B1-10i 的订单详情读取。
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { AuditPort, Clock, EventBus } from '../../platform/index.ts';
import type { AdminOrderPorts } from './admin-orders.ts';
import type { CommissionSnapshotPort, SnapshotOutcome } from './commission-snapshot-step.ts';
import type { OrderSourcePorts } from './source-backfill.ts';

export interface AdminAssignActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface AdminAssignCommand {
  readonly orderId: string;
  /** 目标用户。 */
  readonly user_id: string;
  /** 操作员看到的订单 user_id：只能为空（未归因订单）。 */
  readonly expected_user_id: null;
  /** 操作员看到的 flags.locked。 */
  readonly expected_locked: boolean;
  /** 指派原因（5～200 字，BR-ATTR-20 ③），写进审计。 */
  readonly reason: string;
}

/** settlement 端口的入参（claim-review 的 ClaimApprovedInput 同形）。 */
export interface AdminAssignedInput {
  /** SELECT … FOR UPDATE 重读到的整行，orders 写归属之前。 */
  readonly before: Selectable<DB['orders']>;
  readonly userId: string;
  readonly now: Date;
  /** R3 的快照结果；R3b（VOID）不生成快照，为 none。 */
  readonly snapshot: SnapshotOutcome;
}

/** settlement 的返利端口：只有它写 locked 与 rebate_status（R3：UNATTRIBUTED → ESTIMATED / WAITING；R3b：VOID 不变）。 */
export interface AdminAssignRebatePort {
  onAdminAssigned(trx: Transaction<DB>, input: AdminAssignedInput): Promise<void>;
}

export interface AdminAssignTargetInput {
  readonly appId: string;
  readonly userIds: readonly string[];
}

/** risk 的批量风控状态读取（createRiskStateBatchReader 同形）；只在调用方事务上执行。 */
export interface AdminAssignRiskReader {
  read(
    executor: Transaction<DB>,
    input: AdminAssignTargetInput,
  ): Promise<ReadonlyMap<string, { readonly state: string }>>;
}

/** identity 的注销阶段读取（createDeletionStageReader 同形：none / cooling / processing / done）。 */
export interface AdminAssignDeletionReader {
  read(
    executor: Transaction<DB>,
    input: AdminAssignTargetInput,
  ): Promise<ReadonlyMap<string, string>>;
}

export interface AdminAssignTargetReaders {
  readonly risk: AdminAssignRiskReader;
  readonly deletion: AdminAssignDeletionReader;
}

/** 目标用户不能作为归属对象时的 data.reason（契约 adminReassignOrder）。 */
export type AdminAssignTargetRefusal = 'target_banned' | 'target_deleting' | 'target_deleted';

/** 审计 action（指派成功与目标被拒都记，target 为 `orders:<order_id>`）。 */
export type AdminAssignAuditAction = 'order_assign';

export interface AdminAssignDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  readonly events: Pick<EventBus, 'publish'>;
  readonly rebate: AdminAssignRebatePort;
  readonly targets: AdminAssignTargetReaders;
  readonly snapshots?: CommissionSnapshotPort;
  readonly sources?: OrderSourcePorts;
  readonly pidScene?: (order: Selectable<DB['orders']>) => Promise<string | null>;
  /** B1-10i 的详情端口，供响应。 */
  readonly details: AdminOrderPorts;
}

export type AdminAssignOutcome =
  | { readonly code: 0; readonly data: Schema<'AdminOrderDetail'> }
  | {
      readonly code: 20001;
      readonly data: {
        readonly fields: readonly string[];
        readonly reason?: AdminAssignTargetRefusal;
      };
    }
  | { readonly code: 20902; readonly data: { readonly resource: 'order_attribution' } };

/** 运行时故障（端口、审计、事件、数据库）原样抛出并整事务回滚。 */
export async function assignOrder(
  deps: AdminAssignDeps,
  actor: AdminAssignActor,
  command: AdminAssignCommand,
): Promise<AdminAssignOutcome> {
  void deps;
  void actor;
  void command;
  throw new Error('NotImplemented: assignOrder');
}
