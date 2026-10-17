// B1-08i：已有子订单（同 App、未被乱序丢弃、content_hash 变化）的同步更新（BR-FUND-01 / 02 / 03 / 07、
// BR-ATTR-01；规划/02 §11、§18；D10-41）。在 B1-08h 流水线已取 advisory 锁的事务里运行。
// - 判定先于写库（domain/update-plan.ts）：表外事件、P10 倒退（开关开）、表外码且已入账 → 整条不落 orders，
//   只写 order_sync_pending 并告警（order_illegal_transition），结果 pending，不抛错（IllegalTransition 不重试）。
// - 其余：一条 CAS UPDATE（row_version + 当前 platform_status）；影响 0 行 → 重读一次重新判定，仍 0 行抛
//   ORDER_CAS_CONFLICT。写序：UPDATE orders → history（按步序，只插入）→ pending → settlement 端口 → order.updated。
// - 未归因（user_id 为空，含 VOID 的 R3b）每次重跑用户归属：命中且 locked=false 才写 user_id、user_basis=param。
// - 返利状态、hold、order_rights、order_settlements 只由 settlement 经端口决定；本模块不写这些列。
// 日志只打平铺字段（platform、app_id、reason、outcome、rule、event），不打子订单号与买家参数。
import type { DB } from '@couli/db';
import type { OrderPlatformState } from '@couli/domain';
import type { Selectable, Transaction } from 'kysely';
import type { EventBus } from '../../platform/index.ts';
import type { RegisteredPlatform, UnionOrder, UnionOrderAttrParams } from '../../union/index.ts';
import { rawPayloadId } from '../domain/order-fields.ts';
import {
  planOrderSyncColumns,
  planOrderUpdate,
  type OrderUpdatePlan,
} from '../domain/update-plan.ts';
import { casUpdateOrder, type OrderUpdateSet } from '../infra/order-update-store.ts';
import { insertPlatformHistory, readOrder, upsertPending } from '../infra/pipeline-store.ts';
import { attributeOrderUser } from './attribute-user.ts';
import type {
  OrderPipelineContext,
  OrderPipelineDeps,
  OrderPipelineResult,
} from './pipeline-types.ts';

export interface OrderUpdateChange {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
  readonly from_status: string;
  readonly to_status: string;
  readonly rule: string | null;
  readonly received_at: Date | null;
  readonly est_before: bigint | null;
  readonly est_after: bigint | null;
  readonly settle_commission_fen: bigint | null;
  readonly attributed_now: boolean;
}

export interface UnmappedOrderInfo {
  readonly app_id: string;
  readonly order_id: string;
  readonly attr_at: Date;
  readonly rebate_status: string;
}

export interface OrderUpdateDeps extends Pick<
  OrderPipelineDeps,
  'clock' | 'users' | 'bindings' | 'statusMaps' | 'logger'
> {
  readonly rebate: {
    onUpdated(trx: Transaction<DB>, change: OrderUpdateChange): Promise<void>;
    onUnmappedStatus(trx: Transaction<DB>, info: UnmappedOrderInfo): Promise<void>;
  };
  readonly events: Pick<EventBus, 'publish'>;
  readonly regressionHold?: (platform: Parameters<OrderPipelineDeps['statusMaps']>[0]) => boolean;
}

type OrderRow = Selectable<DB['orders']>;

const NO_PARAMS: UnionOrderAttrParams = {
  relation_id: null,
  custom_parameters: null,
  sub_union_id: null,
};

/** 告警级别：08 未写明，order_attr_param_changed 为 P2（BR-ATTR-01），其余订单同步异常按 P1。 */
const ALERT_SYNC = 'P1';
const ALERT_PARAM = 'P2';

function pendingDetail(plan: OrderUpdatePlan, from: string): string | null {
  if (plan.pending !== 'ILLEGAL_TRANSITION') return null;
  return `order_illegal_transition ${plan.rule ?? 'illegal'} ${from}→${plan.event ?? '-'}`;
}

// TODO(规划/11 §4.5): 告警事件入队 — blocked on platform 事件名登记
// TODO(规划/11 §4.5): 来源回填与分佣快照 — blocked on B1-08j、B1-08k
export function createOrderUpdateStep(
  deps: OrderUpdateDeps,
): NonNullable<OrderPipelineDeps['updateStep']> {
  const log = deps.logger;

  /** 整条报文不落 orders：只写待处理并告警；同键 open 记录只刷新 detected_at。 */
  async function reject(
    trx: Transaction<DB>,
    current: OrderRow,
    incoming: UnionOrder,
    platform: RegisteredPlatform,
    plan: OrderUpdatePlan,
  ): Promise<OrderPipelineResult> {
    const reason = plan.pending ?? 'ILLEGAL_TRANSITION';
    await upsertPending(trx, {
      app_id: current.app_id,
      platform,
      sub_order_id: current.sub_order_id,
      order_id: current.order_id,
      reason,
      raw_status: incoming.raw_status ?? null,
      raw_payload_id: rawPayloadId(incoming),
      detected_at: deps.clock.now(),
      detail: pendingDetail(plan, current.platform_status),
    });
    log?.error(
      {
        alert: ALERT_SYNC,
        event: 'order_illegal_transition',
        platform,
        app_id: current.app_id,
        reason,
        rule: plan.rule,
        outcome: 'rejected',
      },
      'order sync update rejected; order columns untouched',
    );
    return { kind: 'pending', order_id: current.order_id, reason };
  }

  type Attempt = OrderPipelineResult | 'conflict';

  async function attempt(
    trx: Transaction<DB>,
    current: OrderRow,
    incoming: UnionOrder,
    ctx: OrderPipelineContext,
  ): Promise<Attempt> {
    const platform = ctx.platform;
    const from = current.platform_status as OrderPlatformState;
    const hold = deps.regressionHold?.(platform) ?? true;
    const plan = planOrderUpdate(
      {
        platform_status: from,
        rebate_status: current.rebate_status,
        received_at: current.received_at,
      },
      incoming,
      deps.statusMaps(platform),
      hold,
    );
    if (plan.kind === 'pending') return reject(trx, current, incoming, platform, plan);

    const columns = planOrderSyncColumns(current, incoming, plan);
    const now = deps.clock.now();
    const set: OrderUpdateSet = {
      ...columns,
      ...(plan.platform_status !== from ? { platform_status: plan.platform_status } : {}),
      row_version: current.row_version + 1,
      updated_at: now,
    };

    // 归属参数（BR-ATTR-01）：已归属不覆盖四项参数，变化只告警；未归因写入参并重跑 ②（BR-ATTR-06 / 07）。
    const params = incoming.attr_params ?? NO_PARAMS;
    const slot = incoming.promotion_slot ?? null;
    const paramsChanged =
      slot !== current.pid ||
      params.relation_id !== current.relation_id ||
      params.sub_union_id !== current.sub_union_id ||
      params.custom_parameters !== current.custom_params;
    const unattributed = current.user_id === null;
    let attributedNow = false;
    let bindingConflict = false;
    if (unattributed) {
      Object.assign(set, {
        pid: slot,
        relation_id: params.relation_id,
        sub_union_id: params.sub_union_id,
        custom_params: params.custom_parameters,
      });
      // 用户归属仍用首次的 attr_at（BR-ATTR-25），不用后来的 paid_at 或同步时间。
      const user = await attributeOrderUser(deps, {
        appId: current.app_id,
        platform,
        unionAccountId: ctx.union_account_id,
        params,
        attrAt: current.attr_at,
      });
      if (user.kind === 'attributed' && !current.locked) {
        // R3a / R3b：只写 user_id、user_basis=param，不置 locked，不碰 rebate_status。
        Object.assign(set, { user_id: user.user_id, user_basis: 'param' });
        attributedNow = true;
      }
      bindingConflict = user.kind === 'unattributed' && user.conflict;
    }

    const updated = await casUpdateOrder(trx, current, set, {
      unattributed,
      attributing: attributedNow,
    });
    if (!updated) return 'conflict';

    await insertPlatformHistory(trx, current, plan.history, now);
    if (plan.pending !== null) {
      await upsertPending(trx, {
        app_id: current.app_id,
        platform,
        sub_order_id: current.sub_order_id,
        order_id: current.order_id,
        reason: plan.pending,
        raw_status: incoming.raw_status ?? null,
        raw_payload_id: columns.raw_payload_id,
        detected_at: now,
        detail: pendingDetail(plan, from),
      });
    }
    if (plan.pending === 'UNMAPPED_STATUS') {
      await deps.rebate.onUnmappedStatus(trx, {
        app_id: current.app_id,
        order_id: current.order_id,
        attr_at: current.attr_at,
        rebate_status: current.rebate_status,
      });
    }
    await deps.rebate.onUpdated(trx, {
      app_id: current.app_id,
      order_id: current.order_id,
      attr_at: current.attr_at,
      from_status: from,
      to_status: plan.platform_status,
      rule: plan.rule,
      received_at: columns.received_at,
      est_before: current.est_commission_fen,
      est_after: columns.est_commission_fen,
      settle_commission_fen: columns.settle_commission_fen,
      attributed_now: attributedNow,
    });
    await deps.events.publish(trx, {
      appId: current.app_id,
      name: 'order.updated',
      payload: {
        order_id: current.order_id,
        platform,
        from_status: from,
        to_status: plan.platform_status,
        rule: plan.rule,
        attributed_now: attributedNow,
      },
    });

    // —— 告警（写库成功后才打，重读重试不重复）——
    const base = { platform, app_id: current.app_id };
    if (plan.pending === 'ILLEGAL_TRANSITION' || plan.pending === 'UNMAPPED_STATUS') {
      log?.error(
        {
          ...base,
          alert: ALERT_SYNC,
          event: 'order_illegal_transition',
          reason: plan.pending,
          rule: plan.rule,
          outcome: 'status_kept',
        },
        'order sync status not moved; other columns updated',
      );
    } else if (plan.pending === 'NO_RECEIVED_AT') {
      log?.warn(
        { ...base, reason: plan.pending, rule: plan.rule, outcome: 'pending' },
        'order receipt without platform received time',
      );
    }
    if (plan.rule === 'P9' && plan.history.length > 0) {
      log?.warn(
        { ...base, alert: ALERT_SYNC, rule: 'P9', outcome: 'invalid_recovered' },
        'invalid order reported active again; rebate status unchanged',
      );
    }
    if (!unattributed && paramsChanged) {
      log?.warn(
        { ...base, alert: ALERT_PARAM, event: 'order_attr_param_changed', outcome: 'params_kept' },
        'attribution parameters changed on an attributed order',
      );
    } else if (unattributed && slot !== current.pid) {
      // 待编排裁定 6：未归因订单写入新参数，不重跑 App 归属；推广位变化只告警。
      log?.warn(
        { ...base, outcome: 'pid_changed' },
        'promotion slot changed on an unattributed order',
      );
    }
    if (bindingConflict) {
      log?.error(
        { ...base, alert: ALERT_SYNC, event: 'attr_binding_conflict', outcome: 'unattributed' },
        'taobao binding conflict',
      );
    }
    log?.info(
      { ...base, outcome: 'updated', rule: plan.rule, attributed_now: attributedNow },
      'order updated',
    );
    return { kind: 'updated', order_id: current.order_id };
  }

  return {
    async apply(trx, current, incoming, ctx) {
      const first = await attempt(trx, current, incoming, ctx);
      if (first !== 'conflict') return first;
      // 02 §18：CAS 影响 0 行 → 重读一次，按迁移表重新判定。
      const reread = await readOrder(trx, current);
      if (reread === undefined) {
        throw new Error('ORDER_ROW_MISSING: CAS 冲突后重读不到订单行');
      }
      const second = await attempt(trx, reread, incoming, ctx);
      if (second !== 'conflict') return second;
      throw new Error('ORDER_CAS_CONFLICT: 订单并发更新，两次 CAS 均未命中');
    },
  };
}
