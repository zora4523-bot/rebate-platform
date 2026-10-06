import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  DemoUnionAdapter,
  isPriceAnomaly,
  type CallCtx,
  type DemoScenario,
  type PriceAnomalyReason,
  type UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';

const ctx: CallCtx = {
  appId: 'demo-price-app',
  requestId: 'demo-price-request',
  purpose: 'online',
};
const keyword = '演示';

function demo(clock = new FixedClock('2031-02-03T04:05:06.789Z')): DemoUnionAdapter {
  return new DemoUnionAdapter({
    platform: 'taobao',
    seed: 'demo-price',
    clock,
    environment: 'test',
  });
}

function expectNormal(item: UnionItem): void {
  expect(isPriceAnomaly(item)).toBe(false);
  expect(Object.hasOwn(item, 'price_anomaly_reason')).toBe(false);
  expect(Object.values(item)).not.toContain(undefined);
  if (item.coupon_fen > 0n) {
    expect(item.coupon_ids).toBeTypeOf('string');
    expect(item.coupon_ids).not.toBe('');
    const ids = item.coupon_ids!.split(',');
    expect(ids).toEqual([...ids].sort());
    expect(ids.every((id) => id.length > 0)).toBe(true);
  } else {
    expect(Object.hasOwn(item, 'coupon_ids')).toBe(false);
  }
}

it('[AC-B1-04r-DEMO#1] 普通淘宝搜索、物料和详情均正常，券串只在有券时出现', async () => {
  const port = demo();
  const all: UnionItem[] = [];
  for (const source of ['search', 'feed'] as const) {
    let cursor: string | undefined;
    let finished = false;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const pagination = cursor === undefined ? {} : { cursor };
      const page =
        source === 'search'
          ? await port.searchItems({ keyword, ...pagination }, ctx)
          : await port.materialFeed(pagination, ctx);
      expect(page.items.length).toBeGreaterThan(0);
      for (const item of page.items) {
        expectNormal(item);
        const detail = await port.getItem(item, ctx);
        expectNormal(detail);
        expect(detail).toMatchObject(item);
      }
      all.push(...page.items);
      if (page.nextCursor === null) {
        finished = true;
        break;
      }
      cursor = page.nextCursor;
    }
    expect(finished).toBe(true);
  }
  expect(all.some((item) => item.coupon_fen > 0n)).toBe(true);
  expect(all.some((item) => item.coupon_fen === 0n)).toBe(true);
});

it('[AC-B1-04r-DEMO#2] coupon_expired 表示券消失：价格正常且没有 coupon_ids 键', async () => {
  const port = demo();
  const normal = await port.searchItems({ keyword }, ctx);
  const original = normal.items.find((item) => item.coupon_fen > 0n);
  expect(original).toBeDefined();
  const expired = { ...ctx, scenario: 'coupon_expired' };
  for (const item of [
    await port.getItem(original!, expired),
    ...(await port.searchItems({ keyword }, expired)).items,
    ...(await port.materialFeed({}, expired)).items,
  ]) {
    expectNormal(item);
    expect(item.coupon_fen).toBe(0n);
    expect(item.final_price_fen).toBe(item.price_fen);
    expect(Object.hasOwn(item, 'coupon_ids')).toBe(false);
  }
  const detail = await port.getItem(original!, expired);
  expect(detail.price_fen).toBe(original!.price_fen);
  expectNormal(await port.getItem(original!, ctx));
  expect(await port.searchItems({ keyword }, ctx)).toEqual(normal);
});

it.each([
  ['price_anomaly', 'calc_diff'],
  ['unknown_promo', 'unknown_promo'],
] as const satisfies readonly (readonly [DemoScenario, PriceAnomalyReason])[])(
  '[AC-B1-04r-DEMO#3] %s 在三个读价入口产出异常 DTO，不污染下一次普通调用',
  async (scenario, reason) => {
    const port = demo();
    const normalSearch = await port.searchItems({ keyword }, ctx);
    const normalFeed = await port.materialFeed({}, ctx);
    const item = normalSearch.items[0];
    expect(item).toBeDefined();
    const normalDetail = await port.getItem(item!, ctx);
    const anomalous = { ...ctx, scenario };
    const expected = {
      price_status: 'anomaly',
      price_anomaly_reason: reason,
      price_fen: 0n,
      coupon_fen: 0n,
      final_price_fen: 0n,
    };
    // A rejection is turned into a value so that an adapter without these scenarios fails the
    // same assertion (orchestrator edit 2026-10-06, couli-runs/B1-04r/decision-orchestrator.md).
    const settle = (p: Promise<unknown>) =>
      p.then(
        (value) => value,
        (error: unknown) => ({ rejected: String((error as { code?: unknown })?.code ?? error) }),
      );
    const detail = await settle(port.getItem(item!, anomalous));
    expect(detail).toMatchObject(expected);
    expect(isPriceAnomaly(detail as Parameters<typeof isPriceAnomaly>[0])).toBe(true);
    for (const read of [
      () => port.searchItems({ keyword }, anomalous),
      () => port.materialFeed({}, anomalous),
    ]) {
      const settled = await settle(read());
      expect(settled).toMatchObject({ items: expect.any(Array) });
      const page = settled as Awaited<ReturnType<typeof read>>;
      expect(page.items.length).toBeGreaterThan(0);
      for (const value of page.items) {
        expect(value).toMatchObject(expected);
        expect(isPriceAnomaly(value)).toBe(true);
        expect(Object.values(value)).not.toContain(undefined);
      }
    }
    expect(await port.getItem(item!, ctx)).toEqual(normalDetail);
    expect(await port.searchItems({ keyword }, ctx)).toEqual(normalSearch);
    expect(await port.materialFeed({}, ctx)).toEqual(normalFeed);
  },
);

it('[AC-B1-04r-DEMO#4] 注入时钟拨到 2042 年，演示明细仍有效且价格不变', async () => {
  const clock = new FixedClock('2031-02-03T04:05:06.789Z');
  const port = demo(clock);
  const before = await port.searchItems({ keyword }, ctx);
  const beforeFeed = await port.materialFeed({}, ctx);
  const later = '2042-09-10T11:12:13.014Z';
  clock.set(later);
  const after = await port.searchItems({ keyword }, ctx);
  const afterFeed = await port.materialFeed({}, ctx);
  expect(after.items.length).toBeGreaterThan(0);
  for (const item of [...after.items, ...afterFeed.items]) {
    expectNormal(item);
    const detail = await port.getItem(item, ctx);
    expectNormal(detail);
    expect(detail.quoted_at).toBe(later);
  }
  expect(after).toEqual({
    ...before,
    items: before.items.map((item) => ({ ...item, quoted_at: later })),
  });
  expect(afterFeed).toEqual({
    ...beforeFeed,
    items: beforeFeed.items.map((item) => ({ ...item, quoted_at: later })),
  });
});

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-04r-DEMO#5] %s 普通结果不附带淘宝券串或空值键',
  async (platform) => {
    const port = new DemoUnionAdapter({
      platform,
      seed: 'demo-price',
      environment: 'test',
      clock: new FixedClock('2031-02-03T04:05:06.789Z'),
    });
    const items = [
      ...(await port.searchItems({ keyword }, ctx)).items,
      ...(await port.materialFeed({}, ctx)).items,
    ];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(isPriceAnomaly(item)).toBe(false);
      expect(Object.hasOwn(item, 'coupon_ids')).toBe(false);
      expect(Object.hasOwn(item, 'price_anomaly_reason')).toBe(false);
      expect(Object.values(item)).not.toContain(undefined);
    }
  },
);
