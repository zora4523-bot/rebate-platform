// TODO(规划/11 §9.2): 生成物，勿手改；来源 specs/state-machines/order-rebate.yaml — blocked on CT-04a 实现阶段
export type OrderRebateState =
  | 'UNATTRIBUTED'
  | 'ESTIMATED'
  | 'WAITING'
  | 'CREDITED'
  | 'VOID'
  | 'CLAWED_BACK';

// 中文事件的最终编码由实现阶段 YAML 注释说明；骨架先保留大写蛇形名的类型入口。
export type OrderRebateEvent = Uppercase<string>;

export type OrderRebateTransitionResult =
  | { ok: true; to: OrderRebateState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionOrderRebate(
  from: OrderRebateState | null,
  event: OrderRebateEvent,
): OrderRebateTransitionResult {
  void from;
  void event;
  throw new Error('NotImplemented: transitionOrderRebate');
}
