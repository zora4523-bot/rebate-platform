import type { Clock, QuotaLimiter } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionIdentity,
  type CallCtx,
  type ItemInput,
  type RegisteredPlatform,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';
export { ManualScheduler, flush, observe, ending } from '../../platform/http/kit.ts';

export const platforms = ['jd', 'pdd', 'taobao'] as const;
export const online: CallCtx = { appId: 'app-a', requestId: 'req-1', purpose: 'online' };
export const window = { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' };
export const fixedClock: Clock = { now: () => new Date('2026-10-06T01:02:03.456Z') };
export const itemInput: ItemInput = {
  platform: 'jd',
  itemId: 'item-A',
  skuId: null,
  title: '统一领域测试商品（非平台录制）',
  price_fen: '10000',
  coupon_fen: '1200',
  final_price_fen: '8800',
  commission_percent: '12.34',
};
export const item: UnionItem = {
  platform: 'jd',
  itemId: 'item-A',
  skuId: null,
  title: itemInput.title,
  price_fen: 10000n,
  coupon_fen: 1200n,
  final_price_fen: 8800n,
  commission_rate_bp: 1234n,
  quoted_at: '2026-10-06T01:02:03.456Z',
};

export function endpoint(platform: RegisteredPlatform = 'jd'): UnionEndpoint {
  return {
    platform,
    mode: 'replay',
    baseUrl: `http://wiremock:8080/${platform}`,
    quotaKey: `account:${platform}`,
  };
}

export function quota(bucketKey = 'account:jd'): QuotaLimiter {
  return { bucketKey, tryAcquire: () => true };
}

/** Trusted server fixture, modelling the future linking authority; never a JSON input. */
export class LinkingIdentity extends UnionIdentity {
  constructor(appId = 'app-a', platform: RegisteredPlatform = 'jd') {
    super({
      appId,
      platform,
      userId: 'user-a',
      promotionSlot: 'synthetic-slot',
      relationId: 'synthetic-relation',
    });
  }
}

/** Local port double returning domain DTOs only. No transport or platform payload imitation. */
export function adapter(platform: RegisteredPlatform = 'jd'): UnionAdapter {
  return {
    platform,
    searchItems: async () => ({ items: [item], nextCursor: null }),
    getItem: async () => item,
    resolveLink: async () => ({ item: { platform, itemId: 'item-A' } }),
    convert: async () => ({ kind: 'url', url: 'https://example.invalid/result' }),
    listOrders: async () => ({ items: [], nextCursor: null }),
  };
}

export function errorCode(run: () => unknown): unknown {
  try {
    run();
    return 'returned';
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error ? error.code : error;
  }
}
