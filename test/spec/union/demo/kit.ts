import { expect } from 'vitest';
import { FixedClock, type Clock } from '../../../../apps/api/src/modules/platform/index.ts';
import * as union from '../../../../apps/api/src/modules/union/index.ts';
import type {
  CallCtx,
  IdentityClaims,
  ItemRef,
  RegisteredPlatform,
  UnionAdapter,
  UnionEnvironment,
  UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';

export const platforms = ['taobao', 'jd', 'pdd'] as const;
export const instant = '2031-02-03T04:05:06.789Z';
export const online: CallCtx = { appId: 'demo-app', requestId: 'demo-request', purpose: 'online' };
export const keyword = '演示';
export type DemoPort = UnionAdapter &
  Required<Pick<UnionAdapter, 'bindPublisher' | 'materialFeed'>>;
export interface DemoOptions {
  platform: RegisteredPlatform;
  seed: string;
  clock: Clock;
  environment: UnionEnvironment;
}

// Test only the module's public surface. B1-04b index.ts must stay untouched in the test phase:
// assert the export before calling it, so missing wiring is an assertion failure, not TypeError.
export function demoConstructor(): new (options: DemoOptions) => DemoPort {
  const constructor: unknown = Reflect.get(union, 'DemoUnionAdapter');
  expect(constructor, 'union/index.ts must export DemoUnionAdapter').toBeTypeOf('function');
  return constructor as new (options: DemoOptions) => DemoPort;
}

export function demo(
  platform: RegisteredPlatform,
  seed = 'catalog-a',
  clock: Clock = new FixedClock(instant),
): DemoPort {
  const Constructor = demoConstructor();
  return new Constructor({ platform, seed, clock, environment: 'test' });
}

/** Models linking's trusted construction, never an external JSON identity. */
export class LinkingIdentity extends union.UnionIdentity {
  constructor(platform: RegisteredPlatform, overrides: Partial<IdentityClaims> = {}) {
    super({
      appId: online.appId,
      userId: 'demo-user',
      platform,
      promotionSlot: 'demo-slot',
      relationId: platform === 'taobao' ? 'demo-relation' : null,
      ...overrides,
    });
  }
}

export function refOf(item: ItemRef): ItemRef {
  const ref: Record<string, unknown> = { platform: item.platform };
  for (const key of ['item_id', 'itemId', 'skuId', 'goods_id', 'goods_sign'] as const) {
    if (item[key] !== undefined) ref[key] = item[key];
  }
  return ref as unknown as ItemRef;
}

export function demoLink(item: ItemRef): string {
  const id =
    item.platform === 'taobao'
      ? item.item_id
      : item.platform === 'jd'
        ? item.itemId
        : item.goods_sign;
  expect(id).toBeTypeOf('string');
  expect(id).not.toBe('');
  return `https://demo.invalid/${item.platform}/${encodeURIComponent(id as string)}`;
}

export async function firstItem(port: DemoPort): Promise<UnionItem> {
  const page = await port.searchItems({ keyword }, online);
  expect(page.items.length).toBeGreaterThan(0);
  return page.items[0]!;
}

export function keys(value: object): string[] {
  return Object.keys(value).sort();
}

export function expectItem(item: UnionItem, platform: RegisteredPlatform): void {
  const identifiers =
    platform === 'taobao'
      ? ['item_id']
      : platform === 'jd'
        ? ['itemId', 'skuId']
        : ['goods_id', 'goods_sign'];
  const required = [
    'platform',
    ...identifiers,
    'title',
    'price_fen',
    'coupon_fen',
    'final_price_fen',
    'commission_rate_bp',
    'quoted_at',
  ];
  // D33 optional fields appear only when they carry a value.
  const optional = ['coupon_ids', 'price_status', 'price_anomaly_reason'];
  const actual = keys(item);
  expect(actual).toEqual(expect.arrayContaining(required));
  expect(actual.filter((key) => !required.includes(key) && !optional.includes(key))).toEqual([]);
  expect(item.platform).toBe(platform);
  expect(item.title).toContain('演示');
  expect(item.quoted_at).toBe(instant);
  for (const field of [
    'price_fen',
    'coupon_fen',
    'final_price_fen',
    'commission_rate_bp',
  ] as const) {
    expect(typeof item[field]).toBe('bigint');
    expect(item[field]).toBeGreaterThanOrEqual(0n);
  }
  expect(item.price_fen).toBeGreaterThan(0n);
  expect(item.coupon_fen).toBeLessThanOrEqual(item.price_fen);
  expect(item.final_price_fen).toBeLessThanOrEqual(item.price_fen);
  expect(item.commission_rate_bp).toBeLessThanOrEqual(10000n);
}
