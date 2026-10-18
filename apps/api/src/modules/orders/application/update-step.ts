// B1-08i：已有子订单（同 App、未被乱序丢弃、content_hash 变化）的同步更新（BR-FUND-01 / 02 / 03 / 07、
// BR-ATTR-01；规划/02 §11、§18；D10-41）。在 B1-08h 流水线已取 advisory 锁的事务里运行。
// - 判定先于写库（domain/update-plan.ts）：表外事件、P10 倒退（开关开）、表外码且已入账 → 整条不落 orders，
//   只写 order_sync_pending 并告警（order_illegal_transition），结果 pending，不抛错（IllegalTransition 不重试）。
// - 其余：一条 CAS UPDATE（row_version + 当前 platform_status）；影响 0 行 → 重读一次重新判定，仍 0 行抛
//   ORDER_CAS_CONFLICT。写序：UPDATE orders → history（按步序，只插入）→ pending → settlement 端口 → order.updated
//   → 告警事件。
// - 告警事件与 order.updated 经同一个注入的 events 总线、与上述写入同一事务入队（application/alert-events.ts），
//   入队抛错整事务回滚：表外事件与 P10 倒退（含开关关）→ order.illegal_transition；已归属订单归因参数变化 →
//   order.attr_param_changed；重跑归属遇淘宝绑定冲突 → order.attr_binding_conflict。映射表外的码
//   （UNMAPPED_STATUS）08 未写该事件，只告警进待处理。
// - 未归因（user_id 为空，含 VOID 的 R3b）每次重跑用户归属：命中且 locked=false 才写 user_id、user_basis=param。
// - ⑤ 来源回填（B1-08j，BR-ATTR-15）：本次写 user_id、库内 source_match 为空且注入 sources 时，按订单推广位
//   （本次 UPDATE 将写入的 pid——未归因重跑写入本次报文的推广位，未改时即原值——经 pids 端口取首行 pid_scene；
//   推广位为空、端口未注入或查不到 → 场景未知：② product / ③ shop 不跨场景匹配，① exact 照常，否则 none，
//   并在写后告警；只有推广位本身是 fallback 才不限场景，D10-60）、current.shop_id 与本次报文匹配，四列并入
//   同一条 CAS UPDATE（WHERE 另加 source_match IS NULL）；端口抛错整事务回滚。不改 product_key / shop_id。
// - 返利状态、hold、order_rights、order_settlements 只由 settlement 经端口决定；本模块不写这些列。
//   端口除 change / info 外另带本次报文的来源（映射事件与原始码），settlement 据此区分维权与处罚（P8）。
// 日志只打平铺字段（platform、app_id、reason、outcome、rule、event），不打子订单号与买家参数。
import type { DB } from '@couli/db';
import type { OrderPlatformState } from '@couli/domain';
import type { Selectable, Transaction } from 'kysely';
import type { EventBus } from '../../platform/index.ts';
import type { RegisteredPlatform, UnionOrder, UnionOrderAttrParams } from '../../union/index.ts';
import { rawPayloadId } from '../domain/order-fields.ts';
import type { PlatformStatusEvent } from '../domain/status-map.ts';
import {
  planOrderSyncColumns,
  planOrderUpdate,
  type OrderUpdatePlan,
} from '../domain/update-plan.ts';
import { casUpdateOrder, type OrderUpdateSet } from '../infra/order-update-store.ts';
import { insertPlatformHistory, readOrder, upsertPending } from '../infra/pipeline-store.ts';
import {
  publishBindingConflict,
  publishIllegalTransition,
  publishParamChanged,
  type OrderAttrParamColumn,
} from './alert-events.ts';
import { attributeOrderUser } from './attribute-user.ts';
import { backfillOrderSource, sourceColumns } from './source-backfill.ts';
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

/**
 * 本次报文的平台状态来源（BR-FUND-01 P7 / P8、BR-FUND-02），作为 onUpdated / onUnmappedStatus 的第三个参数。
 * P8 是 noop：维权与处罚都不改状态、rule 同为 P8，只有 event 能区分。settlement 据 event 选 order_rights 类型：
 * PLATFORM_RIGHTS → RIGHTS，PLATFORM_PUNISH → PUNISH（原因码 PUNISH），P7 的 PLATFORM_INVALID →
 * INVALID_AFTER_SETTLE；R6 / R8 的作废与扣回原因同样据 event 取，不从 rule 或 to_status 推断。
 * 单独成参而不并入 change / info：两者的字段集由冻结规则测试逐字断言（AC-B1-08i#20 / #27）。
 */
export interface OrderStatusSource {
  /** 原始码经映射表得到的内部事件（P5 / P14 补走中间步时仍是报文本身的事件，如 PLATFORM_SETTLED）；表外码为 null。 */
  readonly event: PlatformStatusEvent | null;
  /** 平台原始状态码，入参原样（不 trim、不归一）；平台未给为 null。 */
  readonly raw_status: string | null;
}

export interface OrderUpdateDeps extends Pick<
  OrderPipelineDeps,
  'clock' | 'users' | 'bindings' | 'statusMaps' | 'logger'
> {
  readonly sources?: OrderPipelineDeps['sources'];
  readonly pids?: OrderPipelineDeps['pids'];
  /** settlement 实现（B1-08n 接线）；与本次写库同一事务调用，抛错整事务回滚。 */
  readonly rebate: {
    onUpdated(
      trx: Transaction<DB>,
      change: OrderUpdateChange,
      source: OrderStatusSource,
    ): Promise<void>;
    onUnmappedStatus(
      trx: Transaction<DB>,
      info: UnmappedOrderInfo,
      source: OrderStatusSource,
    ): Promise<void>;
  };
  /** 领域事件 order.updated 与三个告警事件共用的总线；与本次写库同一事务入队，抛错整事务回滚。 */
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

// TODO(规划/11 §4.5): 分佣快照 — blocked on B1-08k
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
    const pendingId = await upsertPending(trx, {
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
    if (reason === 'ILLEGAL_TRANSITION') {
      await publishIllegalTransition(deps.events, trx, {
        appId: current.app_id,
        orderId: current.order_id,
        pendingId,
        platform,
        rule: plan.rule ?? 'illegal',
        fromStatus: current.platform_status,
        event: plan.event ?? null,
        outcome: 'rejected',
      });
    }
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

  /**
   * 订单推广位的 pid_scene（BR-ATTR-15 ②「pid_scene = 订单推广位的 pid_scene」）：pid 是本次 UPDATE 写入后
   * 订单的推广位（不是库内旧值），取 pids 端口的首行；端口未注入、无 pid 或查无 → null。
   */
  async function orderPidScene(
    current: OrderRow,
    pid: string | null,
    ctx: OrderPipelineContext,
    platform: RegisteredPlatform,
  ): Promise<string | null> {
    if (deps.pids === undefined || pid === null || pid === '') return null;
    const rows = await deps.pids.find({
      appId: current.app_id,
      platform,
      unionAccountId: ctx.union_account_id,
      pid,
    });
    return rows[0]?.pid_scene ?? null;
  }

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
    const changedParams: OrderAttrParamColumn[] = [
      ...(slot !== current.pid ? (['pid'] as const) : []),
      ...(params.relation_id !== current.relation_id ? (['relation_id'] as const) : []),
      ...(params.sub_union_id !== current.sub_union_id ? (['sub_union_id'] as const) : []),
      ...(params.custom_parameters !== current.custom_params ? (['custom_params'] as const) : []),
    ];
    const paramsChanged = changedParams.length > 0;
    const unattributed = current.user_id === null;
    let attributedNow = false;
    let bindingConflict = false;
    let backfilled: string | null = null;
    let pidSceneMissing = false;
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
        // ⑤ 来源回填：只在本次把 user_id 由空写为非空、且尚无 source_match（含 none）时执行。
        if (deps.sources !== undefined && current.source_match === null) {
          // 推广位以本次写入后的为准：set 里有 pid（未归因重跑写入本次报文的推广位）就用它，否则是原值。
          const orderPid = set.pid !== undefined ? set.pid : current.pid;
          const pidScene = await orderPidScene(current, orderPid, ctx, platform);
          pidSceneMissing = pidScene === null;
          const source = await backfillOrderSource(deps.sources, {
            appId: current.app_id,
            platform,
            userId: user.user_id,
            attrAt: current.attr_at,
            // 场景未知传 null：不当作 fallback（BR-ATTR-15 ② 只对 fallback 推广位不限，D10-60）。
            pidScene,
            order: incoming,
            shopId: current.shop_id,
          });
          Object.assign(set, sourceColumns(source));
          backfilled = source.source_match;
        }
      }
      bindingConflict = user.kind === 'unattributed' && user.conflict;
    }

    const updated = await casUpdateOrder(trx, current, set, {
      unattributed,
      attributing: attributedNow,
      backfilling: backfilled !== null,
    });
    if (!updated) return 'conflict';

    await insertPlatformHistory(trx, current, plan.history, now);
    let pendingId: bigint | null = null;
    if (plan.pending !== null) {
      pendingId = await upsertPending(trx, {
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
    const source: OrderStatusSource = {
      event: plan.event ?? null,
      raw_status: incoming.raw_status ?? null,
    };
    if (plan.pending === 'UNMAPPED_STATUS') {
      await deps.rebate.onUnmappedStatus(
        trx,
        {
          app_id: current.app_id,
          order_id: current.order_id,
          attr_at: current.attr_at,
          rebate_status: current.rebate_status,
        },
        source,
      );
    }
    await deps.rebate.onUpdated(
      trx,
      {
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
      },
      source,
    );
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
    // 告警事件与 order.updated 同一总线、同一事务（BR-ATTR-01 ⑦、BR-ATTR-07、BR-FUND-01 P10；02 §11）。
    if (plan.pending === 'ILLEGAL_TRANSITION') {
      // P10 且开关关：状态不迁移、其余列已照写，仍与待处理记录同事务记 order.illegal_transition。
      await publishIllegalTransition(deps.events, trx, {
        appId: current.app_id,
        orderId: current.order_id,
        pendingId,
        platform,
        rule: plan.rule ?? 'illegal',
        fromStatus: from,
        event: plan.event ?? null,
        outcome: 'status_kept',
      });
    }
    if (!unattributed && paramsChanged) {
      await publishParamChanged(deps.events, trx, {
        appId: current.app_id,
        orderId: current.order_id,
        platform,
        changed: changedParams,
      });
    }
    if (bindingConflict) {
      await publishBindingConflict(deps.events, trx, {
        appId: current.app_id,
        orderId: current.order_id,
        platform,
      });
    }

    // —— 告警日志（写库成功后才打，重读重试不重复）——
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
    if (pidSceneMissing) {
      log?.warn(
        { ...base, reason: 'PID_SCENE_NOT_FOUND', outcome: 'source_scene_unknown' },
        'order promotion slot scene unknown; source backfill skipped product / shop matching',
      );
    }
    if (backfilled !== null) {
      log?.info(
        { ...base, source_match: backfilled, outcome: 'backfilled' },
        'order source backfilled',
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
