import type { UnionOrder } from '../../union/index.ts';
import type { OrderSyncWindow } from './sync-ports.ts';
import type { OrderPipelineDeps, OrderPipelineResult } from './pipeline-types.ts';

export interface OrderPipelineContext extends OrderSyncWindow {
  readonly requestId: string;
}

/** Normal resolution includes accepted, dropped, rejected and pending orders. */
export interface OrderPipelinePort {
  process(order: UnionOrder, ctx: OrderPipelineContext): Promise<void | OrderPipelineResult>;
}

export interface OrderPipeline extends OrderPipelinePort {
  process(order: UnionOrder, ctx: OrderPipelineContext): Promise<OrderPipelineResult>;
}

// TODO(规划/11 §4.5): 淘宝 SITE_MISMATCH 判定 — blocked on 淘宝订单映射（无 site_id）。
// TODO(规划/11 §4.5): attr_binding_conflict、order_illegal_transition 事件入队 — blocked on B1-08i；本任务只记日志。
export function createOrderPipeline(deps: OrderPipelineDeps): OrderPipeline {
  void deps;
  throw new Error('NotImplemented: createOrderPipeline');
}
