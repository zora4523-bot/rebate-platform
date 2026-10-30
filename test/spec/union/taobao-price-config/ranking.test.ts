import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  DemoUnionAdapter,
  isPriceAnomaly,
  type CallCtx,
  type ChannelRankingPage,
  type ChannelRankingReq,
  type TaobaoPriceOptions,
  type TaobaoPriceSettingsReader,
  type UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';
import { UNKNOWN, fakeConfig, fakeLogger, settings } from './kit.ts';

// B1-22q review r1 S2: the demo channel ranking prices taobao items through the same mapping as
// search, feed and detail, so it must map with settings.read(ctx.appId) too. Synthetic data only.

const ctx: CallCtx = {
  appId: 'demo-price-ranking-app',
  requestId: 'demo-price-ranking-request',
  purpose: 'online',
};
const unknownScenario: CallCtx = { ...ctx, scenario: 'unknown_promo' };
const instant = '2031-02-03T04:05:06.789Z';
const SEED = 'demo-price-config';
const whole: ChannelRankingReq = {
  channelId: 'demo-price-ranking-channel',
  categoryId: null,
  pageNo: 1,
  pageSize: 50,
};

function taobao(taobaoPriceSettings?: TaobaoPriceSettingsReader): DemoUnionAdapter {
  return new DemoUnionAdapter({
    platform: 'taobao',
    seed: SEED,
    clock: new FixedClock(instant),
    environment: 'test',
    ...(taobaoPriceSettings === undefined ? {} : { taobaoPriceSettings }),
  });
}

/** A settings port that answers fixed options and records every appId it is asked for. */
function recording(options: TaobaoPriceOptions) {
  const reads: string[] = [];
  const reader: TaobaoPriceSettingsReader = {
    read(appId: string): Promise<TaobaoPriceOptions> {
      reads.push(appId);
      return Promise.resolve(options);
    },
  };
  return { reader, reads };
}

function itemsOf(page: ChannelRankingPage): UnionItem[] {
  expect(page.items.length).toBeGreaterThan(0);
  return page.items.map((entry) => entry.item);
}

function itemId(item: UnionItem): unknown {
  return Reflect.get(item, 'item_id');
}

function ids(page: ChannelRankingPage): unknown[] {
  return page.items.map((entry) => itemId(entry.item));
}

function expectNormal(item: UnionItem): void {
  expect(isPriceAnomaly(item)).toBe(false);
  expect(Object.hasOwn(item, 'price_anomaly_reason')).toBe(false);
  expect(item.final_price_fen).toBe(item.price_fen - item.coupon_fen);
}

function expectUnknownAnomaly(item: UnionItem): void {
  expect(item).toMatchObject({
    price_fen: 0n,
    coupon_fen: 0n,
    final_price_fen: 0n,
    price_status: 'anomaly',
    price_anomaly_reason: 'unknown_promo',
  });
}

it('[AC-B1-22q-DEMO#6] 淘宝演示频道榜单每次映射用 settings.read(ctx.appId) 的结果（整榜与类目）', async () => {
  // Baseline: without settings the 08 default (unavailable) keeps the unlisted name unpriced.
  const plain = await taobao().channelRanking(whole, unknownScenario);
  for (const item of itemsOf(plain)) expectUnknownAnomaly(item);
  const { reader, reads } = recording({ unknown_promo: 'add_back' });
  const port = taobao(reader);
  const ranked = await port.channelRanking(whole, unknownScenario);
  // Same channel order and salesText; only the price mapping changes.
  expect(ids(ranked)).toEqual(ids(plain));
  expect(ranked.items.map((entry) => entry.salesText)).toEqual(
    plain.items.map((entry) => entry.salesText),
  );
  for (const item of itemsOf(ranked)) expectNormal(item);
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((appId) => appId === ctx.appId)).toBe(true);
  const before = reads.length;
  const category = await port.channelRanking(
    { ...whole, categoryId: 'demo-cat-2', pageSize: 5 },
    unknownScenario,
  );
  for (const item of itemsOf(category)) expectNormal(item);
  expect(reads.length).toBeGreaterThan(before);
});

it('[AC-B1-22q-DEMO#7] 频道榜单经 createTaobaoPriceSettings 读配置：与搜索同一口径，改配置下一次调用即变', async () => {
  const config = fakeConfig();
  const { logger, warns } = fakeLogger();
  config.set(UNKNOWN, 'add_back', ctx.appId);
  const port = taobao(settings(config, logger));
  for (const item of itemsOf(await port.channelRanking(whole, unknownScenario))) {
    expectNormal(item);
  }
  expect(config.calls.length).toBeGreaterThan(0);
  expect(config.calls.every((call) => call.appId === ctx.appId)).toBe(true);
  // The ranking and the search price the same item identically.
  const search = await port.searchItems({ keyword: '演示' }, unknownScenario);
  const ranked = itemsOf(await port.channelRanking(whole, unknownScenario));
  const byId = new Map<unknown, UnionItem>(ranked.map((item) => [itemId(item), item] as const));
  let compared = 0;
  for (const item of search.items) {
    const same = byId.get(itemId(item));
    if (same === undefined) continue;
    expect(same).toEqual(item);
    compared++;
  }
  expect(compared).toBeGreaterThan(0);
  config.set(UNKNOWN, 'unavailable', ctx.appId);
  for (const item of itemsOf(await port.channelRanking(whole, unknownScenario))) {
    expectUnknownAnomaly(item);
  }
  config.set(UNKNOWN, 'count', ctx.appId);
  for (const item of itemsOf(await port.channelRanking(whole, unknownScenario))) {
    expectNormal(item);
  }
  expect(warns).toEqual([]);
});
