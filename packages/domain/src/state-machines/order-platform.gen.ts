// TODO(规划/11 §9.2): 生成物，勿手改；来源 specs/state-machines/order-platform.yaml — blocked on CT-04a 实现阶段
export type OrderPlatformState = 'DEPOSIT_PAID' | 'PAID' | 'RECEIVED' | 'SETTLED' | 'INVALID';

export type OrderPlatformEvent =
  | 'PLATFORM_DEPOSIT_PAID'
  | 'PLATFORM_PAID'
  | 'PLATFORM_RECEIVED'
  | 'PLATFORM_SETTLED'
  | 'PLATFORM_INVALID'
  | 'PLATFORM_RIGHTS'
  | 'PLATFORM_PUNISH';

export type OrderPlatformTransitionResult =
  | { ok: true; to: OrderPlatformState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionOrderPlatform(
  from: OrderPlatformState | null,
  event: OrderPlatformEvent,
): OrderPlatformTransitionResult {
  void from;
  void event;
  throw new Error('NotImplemented: transitionOrderPlatform');
}
