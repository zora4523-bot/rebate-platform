// B1-08q：来源回填端口（OrderSourcePorts）的生产实现（BR-ATTR-15；窗口 BR-ATTR-13 ③；口径 D10-76）。
// 别的模块的原始读口由 app.module 组装后传入（linking 的 link_logs、catalog 的 platforms.key_prefix、
// content 的 config_items），orders 不 import 它们的实现。构造时不读任何东西；每次调用都重读（不缓存，
// 改配置或前缀即生效）；读口抛错原样抛出（调用方整事务回滚、本页重试），不转成缺省值或 null。
// - sourceConfig(appId, platform)：attr.click_code.<platform> 只有 JSON true 才打开（缺省 false）；
//   attr.backfill_window_hours 只认正的安全整数，其余（缺失、字符串、小数、≤0、超安全整数）按 360。
// - productKey：按平台读 key_prefix，交 @couli/domain deriveProductKey；无行 / 空前缀 / 推不出 → null（跳过 ②）。
// - linkByCode 不注入：links 还没有 lk 列，按 backfillOrderSource 的口径开关打开也从 ② 开始。
import { ProductKeyUnderivable, deriveProductKey } from '@couli/domain';
import type { RegisteredPlatform } from '../../union/index.ts';
import { DEFAULT_BACKFILL_WINDOW_HOURS } from '../domain/source-backfill.ts';
import type { OrderSourceConfig, OrderSourcePorts } from './source-backfill.ts';

/** 配置键 attr.backfill_window_hours（BR-ATTR-13 ③）。 */
export const BACKFILL_WINDOW_HOURS_KEY = 'attr.backfill_window_hours';

/** 配置键 attr.click_code.<platform>（BR-ATTR-15 lk 细则）。 */
export function clickCodeKey(platform: RegisteredPlatform): string {
  return `attr.click_code.${platform}`;
}

/** 别的模块的原始读口（app.module 组装）；每个都是一次实时读取，不做判定。 */
export interface OrderSourceReads {
  /** linking：link_logs 中 app_id、user_id、platform 相同、created_at ∈ [from, to] 的原始行。 */
  readonly linkLogs: OrderSourcePorts['linkLogs'];
  /** catalog：platforms 表该平台行的 key_prefix；没有该行 → null。 */
  keyPrefix(platform: RegisteredPlatform): Promise<string | null>;
  /** content：config_items (appId, key) 的原值；没有该行 → null。 */
  configValue(appId: string, key: string): Promise<{ readonly value: unknown } | null>;
}

/** 生产注入的来源端口：比 OrderSourcePorts 多一个必有的 sourceConfig。 */
export type ProductionOrderSourcePorts = OrderSourcePorts & {
  sourceConfig(appId: string, platform: RegisteredPlatform): Promise<OrderSourceConfig>;
};

/** attr.click_code.<platform> 的值：只有 JSON true 打开（'true'、1、null、缺失都不算）。 */
export function clickCodeEnabledOf(value: unknown): boolean {
  return value === true;
}

/** attr.backfill_window_hours 的值：正的安全整数照用，其余按未配置（360）。 */
export function backfillWindowHoursOf(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_BACKFILL_WINDOW_HOURS;
}

export function createOrderSourcePorts(reads: OrderSourceReads): ProductionOrderSourcePorts {
  // TODO(规划/11 §4.5): links.lk 短码反查 — blocked on B1-08s
  return {
    linkLogs: (input) => reads.linkLogs(input),
    async productKey({ platform, order }) {
      // TODO(规划/11 §4.5): 京东订单商品键的 jdMode — blocked on 京东订单映射
      // 端口入参没有 App，读不到 App 级 product_key.jd.mode，不猜模式：京东不推商品键（跳过 ②）。
      if (platform === 'jd') return null;
      const keyPrefix = await reads.keyPrefix(platform);
      if (keyPrefix === null || keyPrefix === '') return null;
      try {
        return deriveProductKey({ platform, keyPrefix }, order);
      } catch (error) {
        if (error instanceof ProductKeyUnderivable) return null;
        throw error;
      }
    },
    async sourceConfig(appId, platform) {
      // 依次读两个键（不并发占第二条连接）；任一读失败原样抛出。
      const clickCode = await reads.configValue(appId, clickCodeKey(platform));
      const windowHours = await reads.configValue(appId, BACKFILL_WINDOW_HOURS_KEY);
      return {
        clickCodeEnabled: clickCodeEnabledOf(clickCode?.value),
        backfillWindowHours: backfillWindowHoursOf(windowHours?.value),
      };
    },
  };
}
