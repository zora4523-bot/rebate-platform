// B1-08h：归因流水线主事务（BR-ATTR-01；规划/02 §7.3、§18；D10-35）。每个子订单一个事务：
// 第一句取该子订单的 advisory 锁，锁后重读 order_keys；判定全部完成后才写库。
// - 已存在：app 不同 → 零写入、P1 告警；同 App → 乱序（可选）→ content_hash 短路 → updateStep（B1-08i）。
// - 新子订单：① App 归属（推广位白名单）→ attr_at（定金优先）→ 同步起点 → 首态（表外码 / 非法首态只写
//   pending，不建行）→ ② 用户归属 → ④ buy_type → 写 order_keys、orders、history（+ NO_RECEIVED_AT）、
//   未归因计数 → rebate.onImported（同事务）。①、无付款时间、同步起点之前 → 只记丢弃计数。
// 日志只打平铺字段（platform、app_id、reason、outcome），不打子订单号与买家参数。
import { accountingDate } from '@couli/domain';
import type { DB } from '@couli/db';
import type { Insertable, Transaction } from 'kysely';
import { newUuidV7 } from '../../platform/index.ts';
import type { RegisteredPlatform, UnionOrder, UnionOrderAttrParams } from '../../union/index.ts';
import { classifyBuyType, isKnownPidScene } from '../domain/attribution.ts';
import { orderContentHash } from '../domain/content-hash.ts';
import { planImportState } from '../domain/import-state.ts';
import { mapPlatformStatus } from '../domain/status-map.ts';
import { lockOrderKey } from '../infra/order-lock.ts';
import {
  bumpCounter,
  insertImportedOrder,
  readOrder,
  readOrderKey,
  recordDrop,
  upsertPending,
  type OrderKeyRow,
} from '../infra/pipeline-store.ts';
import { attributeOrderUser } from './attribute-user.ts';
import type {
  OrderPipeline,
  OrderPipelineContext,
  OrderPipelineDeps,
  OrderPipelineResult,
} from './pipeline-types.ts';

export type { OrderPipeline, OrderPipelineContext, OrderPipelinePort } from './pipeline-types.ts';

export type DropReason = 'PID_NOT_OURS' | 'NO_PAY_TIME' | 'BEFORE_SYNC_START';

const NO_PARAMS: UnionOrderAttrParams = {
  relation_id: null,
  custom_parameters: null,
  sub_union_id: null,
};

const DECIMAL = /^[0-9]+$/;

function rawPayloadId(order: UnionOrder): bigint | null {
  const value = order.raw_payload_id ?? null;
  if (value === null) return null;
  if (!DECIMAL.test(value))
    throw new Error('INVALID_RAW_PAYLOAD_ID: raw_payload_id 不是十进制整数');
  return BigInt(value);
}

/** 待编排裁定 8：raw_item_id（NOT NULL）回退顺序；全空写 ''（调用方告警）。 */
function rawItemId(order: UnionOrder): string {
  return order.goods_id ?? order.goods_sign ?? order.item_id ?? order.itemId ?? order.skuId ?? '';
}

// TODO(规划/11 §4.5): 淘宝 SITE_MISMATCH 判定 — blocked on 淘宝订单映射（无 site_id）。
// TODO(规划/11 §4.5): attr_binding_conflict、order_illegal_transition 事件入队 — blocked on B1-08i；本任务只记日志。
export function createOrderPipeline(deps: OrderPipelineDeps): OrderPipeline {
  const log = deps.logger;

  async function drop(
    trx: Transaction<DB>,
    order: UnionOrder & { sub_order_id: string },
    ctx: OrderPipelineContext,
    reason: DropReason,
    attrAt: Date | null,
  ): Promise<OrderPipelineResult> {
    // 待编排裁定 2：无 attr_at 的丢弃按 Clock.now() 的 +08:00 日计数。
    const date = accountingDate(attrAt ?? deps.clock.now());
    await recordDrop(trx, {
      app_id: ctx.app_id,
      platform: order.platform,
      sub_order_id: order.sub_order_id,
      reason,
      date,
    });
    return { kind: 'dropped', reason };
  }

  async function existing(
    trx: Transaction<DB>,
    key: OrderKeyRow,
    order: UnionOrder,
    ctx: OrderPipelineContext,
    platform: RegisteredPlatform,
  ): Promise<OrderPipelineResult> {
    if (key.app_id !== ctx.app_id) {
      // BR-ATTR-22：order_keys 已属其他 App → 不得更新订单，P1 告警。
      log?.error(
        { alert: 'P1', platform, app_id: ctx.app_id, outcome: 'app_conflict' },
        'order key belongs to another app',
      );
      return { kind: 'app_conflict', order_id: key.order_id };
    }
    const current = await readOrder(trx, key);
    if (current === undefined) {
      throw new Error('ORDER_ROW_MISSING: order_keys 有键但 orders 无对应行');
    }
    const ordering = deps.mtimeOrdering?.(platform) ?? false;
    if (ordering) {
      const incomingMtime = order.modified_at ?? null;
      if (incomingMtime === null) {
        await bumpCounter(trx, {
          app_id: ctx.app_id,
          platform,
          date: accountingDate(current.attr_at),
          counter: 'order_sync_no_mtime',
        });
      } else if (
        current.platform_modified_at !== null &&
        incomingMtime.getTime() < current.platform_modified_at.getTime()
      ) {
        log?.info({ platform, app_id: ctx.app_id, outcome: 'stale' }, 'stale order update dropped');
        return { kind: 'stale', order_id: current.order_id };
      }
    }
    if (orderContentHash(order) === current.content_hash) {
      return { kind: 'unchanged', order_id: current.order_id };
    }
    if (deps.updateStep === undefined) {
      throw new Error('NotImplemented: 已有订单的变更（updateStep，B1-08i）');
    }
    return deps.updateStep.apply(trx, current, order, ctx);
  }

  async function fresh(
    trx: Transaction<DB>,
    order: UnionOrder & { sub_order_id: string },
    ctx: OrderPipelineContext,
    platform: RegisteredPlatform,
  ): Promise<OrderPipelineResult> {
    const attrAt = order.deposit_paid_at ?? order.paid_at ?? null;
    // ① App 归属（BR-ATTR-02）：推广位命中本 App 的 union_pids（pending / active / retired 都算）。
    const slot = order.promotion_slot ?? null;
    const pidRows =
      slot === null || slot === ''
        ? []
        : await deps.pids.find({
            appId: ctx.app_id,
            platform,
            unionAccountId: ctx.union_account_id,
            pid: slot,
          });
    const pidRow = pidRows[0];
    if (pidRow === undefined) return drop(trx, order, ctx, 'PID_NOT_OURS', attrAt);
    // 归因时点（BR-ATTR-25）：COALESCE(deposit_paid_at, paid_at)；都空不入库。
    if (attrAt === null) {
      log?.warn(
        { platform, app_id: ctx.app_id, reason: 'NO_PAY_TIME', outcome: 'dropped' },
        'order without pay time dropped',
      );
      return drop(trx, order, ctx, 'NO_PAY_TIME', null);
    }
    const syncStartAt = await deps.accounts.syncStartAt({
      appId: ctx.app_id,
      unionAccountId: ctx.union_account_id,
    });
    if (syncStartAt === null || attrAt.getTime() < syncStartAt.getTime()) {
      return drop(trx, order, ctx, 'BEFORE_SYNC_START', attrAt);
    }
    const now = deps.clock.now();
    const payloadId = rawPayloadId(order);
    const rawStatus = order.raw_status ?? null;
    // 首态（BR-FUND-01 / 02）：表外码与非法首态不建订单行，只写待处理。
    const mapped = mapPlatformStatus(deps.statusMaps(platform), rawStatus);
    const plan =
      mapped.kind === 'event'
        ? planImportState(mapped.event, order.received_at ?? null, order.settled_at ?? null)
        : null;
    if (plan === null || plan.kind === 'pending') {
      const reason = plan === null ? 'UNMAPPED_STATUS' : plan.reason;
      log?.warn(
        { platform, app_id: ctx.app_id, reason, outcome: 'pending' },
        'order status pending',
      );
      await upsertPending(trx, {
        app_id: ctx.app_id,
        platform,
        sub_order_id: order.sub_order_id,
        order_id: null,
        reason,
        raw_status: rawStatus,
        raw_payload_id: payloadId,
        detected_at: now,
      });
      return { kind: 'pending', reason };
    }
    // ② 用户归属（BR-ATTR-06 / 07）。
    const params = order.attr_params ?? NO_PARAMS;
    const user = await attributeOrderUser(deps, {
      appId: ctx.app_id,
      platform,
      unionAccountId: ctx.union_account_id,
      params,
      attrAt,
    });
    if (user.kind === 'unattributed' && user.conflict) {
      log?.error(
        { alert: 'P1', event: 'attr_binding_conflict', platform, app_id: ctx.app_id },
        'taobao binding conflict',
      );
    }
    // ④ buy_type / scene_basis（BR-ATTR-08）；未归因订单也写。
    if (!isKnownPidScene(pidRow.pid_scene)) {
      log?.warn(
        { platform, app_id: ctx.app_id, pid_scene: pidRow.pid_scene, outcome: 'scene_fallback' },
        'pid_scene not in BR-ATTR-08; buy_type falls back to self',
      );
    }
    const scene = classifyBuyType(platform, pidRow.pid_scene, params.custom_parameters);
    const itemId = rawItemId(order);
    if (itemId === '') {
      log?.warn({ platform, app_id: ctx.app_id, outcome: 'no_item_id' }, 'order without item id');
    }

    // —— 判定完成，开始写库 ——
    const orderId = newUuidV7(now);
    const attributed = user.kind === 'attributed';
    const row: Omit<Insertable<DB['orders']>, 'rebate_status'> = {
      order_id: orderId,
      app_id: ctx.app_id,
      platform,
      sub_order_id: order.sub_order_id,
      parent_order_id: order.parent_order_id ?? null,
      raw_item_id: itemId,
      pay_amount_fen: order.paid_fen,
      est_commission_fen: order.est_commission_fen ?? null,
      pid: slot,
      relation_id: params.relation_id,
      sub_union_id: params.sub_union_id,
      custom_params: params.custom_parameters,
      user_id: user.user_id,
      user_basis: attributed ? 'param' : null,
      buy_type: scene.buy_type,
      scene_basis: scene.scene_basis,
      platform_status: plan.platform_status,
      is_presale: order.deposit_paid_at != null,
      deposit_paid_at: order.deposit_paid_at ?? null,
      paid_at: order.paid_at ?? null,
      attr_at: attrAt,
      received_at: plan.received_at,
      settled_at: order.settled_at ?? null,
      platform_modified_at: order.modified_at ?? null,
      content_hash: orderContentHash(order),
      raw_payload_id: payloadId,
    };
    await insertImportedOrder(
      trx,
      {
        platform,
        sub_order_id: order.sub_order_id,
        order_id: orderId,
        app_id: ctx.app_id,
        attr_at: attrAt,
      },
      row,
      plan.history,
      now,
    );
    if (plan.pending !== null) {
      await upsertPending(trx, {
        app_id: ctx.app_id,
        platform,
        sub_order_id: order.sub_order_id,
        order_id: orderId,
        reason: plan.pending,
        raw_status: rawStatus,
        raw_payload_id: payloadId,
        detected_at: now,
      });
    }
    // 待编排裁定 1：未归因计数按 attr_at 的 +08:00 日，只在首次入库进未归因池时计一次。
    if (user.kind === 'unattributed' && user.counter !== null) {
      await bumpCounter(trx, {
        app_id: ctx.app_id,
        platform,
        date: accountingDate(attrAt),
        counter: user.counter,
      });
    }
    await deps.rebate.onImported(trx, {
      app_id: ctx.app_id,
      order_id: orderId,
      attr_at: attrAt,
      attributed,
      platform_status: plan.platform_status,
      received_at: plan.received_at,
    });
    log?.info({ platform, app_id: ctx.app_id, outcome: 'inserted', attributed }, 'order imported');
    return { kind: 'inserted', order_id: orderId };
  }

  return {
    async process(order, ctx) {
      const subOrderId = order.sub_order_id;
      if (typeof subOrderId !== 'string' || subOrderId === '') {
        throw new Error('MISSING_SUB_ORDER_ID: 适配器未映射子订单号');
      }
      if (order.platform !== ctx.platform) {
        throw new Error('PLATFORM_MISMATCH: 订单平台与同步窗口平台不一致');
      }
      const platform = ctx.platform;
      const withSub = order as UnionOrder & { sub_order_id: string };
      return deps.db.transaction().execute(async (trx) => {
        await lockOrderKey(trx, platform, subOrderId);
        const key = await readOrderKey(trx, platform, subOrderId);
        if (key !== undefined) return existing(trx, key, order, ctx, platform);
        return fresh(trx, withSub, ctx, platform);
      });
    },
  };
}
