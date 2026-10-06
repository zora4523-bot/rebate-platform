import { expect, it } from 'vitest';
import type { CallCtx } from '../../../../apps/api/src/modules/union/index.ts';
import {
  demo,
  demoLink,
  firstItem,
  keyword,
  LinkingIdentity,
  online,
  platforms,
  refOf,
} from './kit.ts';

// Scenario names and expected codes are local demo controls, not upstream API fixtures.
it.each(platforms)(
  '[AC-B1-04o-SCENARIO#1] %s 六个操作均可注入超时或限流，且不污染后续调用',
  async (platform) => {
    const port = demo(platform);
    const item = await firstItem(port);
    const ref = refOf(item);
    const calls: readonly [string, (ctx: CallCtx) => Promise<unknown>][] = [
      ['search', (ctx) => port.searchItems({ keyword }, ctx)],
      ['detail', (ctx) => port.getItem(ref, ctx)],
      ['resolve', (ctx) => port.resolveLink(demoLink(item), ctx)],
      [
        'convert',
        (ctx) =>
          port.convert(
            { item: ref, idempotencyKey: 'scenario-key' },
            new LinkingIdentity(platform),
            ctx,
          ),
      ],
      ['bind', (ctx) => port.bindPublisher({ authorizationCode: 'demo-code' }, ctx)],
      ['feed', (ctx) => port.materialFeed({}, ctx)],
    ];
    for (const [name, call] of calls) {
      const normal = await call(online);
      for (const [scenario, code] of [
        ['timeout', 'timeout'],
        ['rate_limit', 'quota_exceeded'],
      ] as const) {
        const failure = Promise.resolve().then(() => call({ ...online, scenario }));
        await expect(failure, `${name}:${scenario}`).rejects.toBeInstanceOf(Error);
        await expect(failure, `${name}:${scenario}`).rejects.toMatchObject({ code });
      }
      expect(await call(online), name).toEqual(normal);
    }
  },
);

it.each(platforms)(
  '[AC-B1-04o-SCENARIO#2] %s 下架场景隐藏搜索和物料商品并拒绝详情、解析与转链',
  async (platform) => {
    const port = demo(platform);
    const item = await firstItem(port);
    const ctx = { ...online, scenario: 'delisted' };
    expect(await port.searchItems({ keyword }, ctx)).toEqual({ items: [], nextCursor: null });
    expect(await port.materialFeed({}, ctx)).toEqual({ items: [], nextCursor: null });
    for (const run of [
      () => port.getItem(refOf(item), ctx),
      () => port.resolveLink(demoLink(item), ctx),
      () =>
        port.convert(
          { item: refOf(item), idempotencyKey: 'delisted-key' },
          new LinkingIdentity(platform),
          ctx,
        ),
    ]) {
      await expect(Promise.resolve().then<unknown>(run)).rejects.toMatchObject({
        code: 'demo_delisted',
      });
    }
    expect(await port.getItem(refOf(item), online)).toMatchObject(item);
    expect((await port.searchItems({ keyword }, online)).items).toContainEqual(item);
  },
);

it.each(platforms)(
  '[AC-B1-04o-SCENARIO#3] %s 券失效置零优惠并回到原价，无佣金只改变佣金字段',
  async (platform) => {
    const port = demo(platform);
    const normalSearch = await port.searchItems({ keyword }, online);
    const normalFeed = await port.materialFeed({}, online);
    expect(normalSearch.items.some((item) => item.coupon_fen > 0n)).toBe(true);
    expect(normalSearch.items.some((item) => item.commission_rate_bp > 0n)).toBe(true);
    for (const scenario of ['coupon_expired', 'no_commission'] as const) {
      const ctx = { ...online, scenario };
      // An expired coupon disappears from the detail, so its coupon_ids may go with it;
      // toEqual treats an undefined property the same as a missing one.
      const comparable = <T extends object>(item: T) =>
        scenario === 'coupon_expired' ? { ...item, coupon_ids: undefined } : item;
      const change = <T extends { price_fen: bigint }>(item: T) =>
        scenario === 'coupon_expired'
          ? comparable({ ...item, coupon_fen: 0n, final_price_fen: item.price_fen })
          : { ...item, commission_rate_bp: 0n };
      const search = await port.searchItems({ keyword }, ctx);
      expect({ ...search, items: search.items.map(comparable) }).toEqual({
        ...normalSearch,
        items: normalSearch.items.map(change),
      });
      const feed = await port.materialFeed({}, ctx);
      expect({ ...feed, items: feed.items.map(comparable) }).toEqual({
        ...normalFeed,
        items: normalFeed.items.map(change),
      });
      for (const item of normalSearch.items) {
        const normal = await port.getItem(refOf(item), online);
        expect(comparable(await port.getItem(refOf(item), ctx))).toEqual(change(normal));
        expect(await port.getItem(refOf(item), online)).toEqual(normal);
      }
    }
    expect(await port.searchItems({ keyword }, online)).toEqual(normalSearch);
    expect(await port.materialFeed({}, online)).toEqual(normalFeed);
  },
);
