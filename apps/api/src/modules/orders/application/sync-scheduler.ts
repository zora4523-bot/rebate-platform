import type { SyncSchedulerDeps } from './sync-ports.ts';

// TODO(规划/11 §4.5): 淘宝 / 京东增量窗口与 scene 配置 — blocked on CAP-TB-07 / CAP-JD-07
export async function scheduleOrderSync(deps: SyncSchedulerDeps): Promise<void> {
  void deps;
  throw new Error('NotImplemented: scheduleOrderSync');
}

export interface SyncIntervalConfig {
  get(key: string): Promise<unknown>;
}

export interface OrderSyncScheduler {
  /** Starts timers only; construction and start must not dispatch a window. */
  start(): { stop(): Promise<void> };
}

export function createOrderSyncScheduler(
  deps: SyncSchedulerDeps,
  config: SyncIntervalConfig,
): OrderSyncScheduler {
  void deps;
  void config;
  throw new Error('NotImplemented: createOrderSyncScheduler');
}
