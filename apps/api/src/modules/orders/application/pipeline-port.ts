import type { UnionOrder } from '../../union/index.ts';
import type { OrderSyncWindow } from './sync-ports.ts';

export interface OrderPipelineContext extends OrderSyncWindow {
  readonly requestId: string;
}

/** Normal resolution includes accepted, dropped, rejected and pending orders. */
export interface OrderPipelinePort {
  process(order: UnionOrder, ctx: OrderPipelineContext): Promise<void>;
}

// TODO(规划/11 §4.5): 默认订单流水线 — blocked on B1-08h
export function createOrderPipeline(): OrderPipelinePort {
  throw new Error('NotImplemented: createOrderPipeline');
}
