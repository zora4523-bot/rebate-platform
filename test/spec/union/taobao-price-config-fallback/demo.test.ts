import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  DemoUnionAdapter,
  createUnionRegistry,
  isPriceAnomaly,
  type CallCtx,
  type ChannelRankingReq,
  type TaobaoPriceSettingsReader,
  type UnionEndpoint,
  type UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  BASIS,
  CUSTOM,
  KEYS,
  UNKNOWN,
  expectNoErrorDetail,
  failingConfig,
  fakeLogger,
  loggedText,
  readFailedEvent,
  settings,
  settle,
  syntheticError,
  warnFields,
} from './kit.ts';

// B1-22w: the demo Taobao adapter keeps answering search, detail, feed and ranking when the
// price.taobao.* read fails; prices then follow the 08 default lists. Synthetic data only.

const ctx: CallCtx = {
  appId: 'demo-price-fallback-app',
  requestId: 'demo-price-fallback-request',
  purpose: 'online',
};
const unknownScenario: CallCtx = { ...ctx, scenario: 'unknown_promo' };
const keyword = '演示';
const instant = '2031-02-03T04:05:06.789Z';
const SEED = 'demo-price-fallback';
const whole: ChannelRankingReq = {
  channelId: 'demo-price-fallback-channel',
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

interface Entries {
  readonly search: readonly UnionItem[];
  readonly feed: readonly UnionItem[];
  readonly detail: UnionItem;
  readonly ranking: readonly UnionItem[];
}

/** The four Taobao entries that map prices; each must resolve (a rejection is one assertion). */
async function entries(port: DemoUnionAdapter, call: CallCtx): Promise<Entries> {
  const search = await settle(port.searchItems({ keyword }, call), 'searchItems');
  const feed = await settle(port.materialFeed({}, call), 'materialFeed');
  const ranking = await settle(port.channelRanking(whole, call), 'channelRanking');
  expect(search.items.length).toBeGreaterThan(0);
  expect(feed.items.length).toBeGreaterThan(0);
  expect(ranking.items.length).toBeGreaterThan(0);
  const detail = await settle(port.getItem(search.items[0]!, call), 'getItem');
  return {
    search: search.items,
    feed: feed.items,
    detail,
    ranking: ranking.items.map((entry) => entry.item),
  };
}

function all(found: Entries): UnionItem[] {
  return [...found.search, ...found.feed, found.detail, ...found.ranking];
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

/** Every warn is a read-failure warn of one of the five keys. */
function expectReadFailedWarns(warns: readonly unknown[][]): void {
  expect(warns.length).toBeGreaterThan(0);
  const events = new Set<string>();
  for (const call of warns) {
    const fields = warnFields(call);
    const key = KEYS.find((candidate) => Object.values(fields).includes(candidate));
    expect(key, 'the warn names a price.taobao.* key').toBeDefined();
    events.add(readFailedEvent(call, key!));
  }
  expect(events.size).toBe(1);
}

it.each([
  ['普通', ctx],
  ['清单外名称', unknownScenario],
] as const)(
  '[AC-B1-22w-DEMO#1] 五个键全部读取抛错（%s场景）：搜索、详情、物料流、榜单照常给出淘宝商品，与 08 默认映射一致',
  async (_label, call) => {
    const config = failingConfig();
    config.setAll(CUSTOM, ctx.appId);
    config.failAll(syntheticError('SyntheticStoreError'), 'reject', ctx.appId);
    const { logger, warns } = fakeLogger();
    const failing = await entries(taobao(settings(config, logger)), call);
    // Without a settings port the demo adapter maps with the 08 defaults.
    const plain = await entries(taobao(), call);
    expect(failing).toEqual(plain);
    expect(config.calls.every((entry) => entry.appId === ctx.appId)).toBe(true);
    expectReadFailedWarns(warns);
  },
);

it('[AC-B1-22w-DEMO#2] unknown_promo 读取抛错时四个入口按默认 unavailable 映射，恢复后即按配置 add_back', async () => {
  const config = failingConfig();
  config.set(UNKNOWN, 'add_back', ctx.appId);
  const { logger, warns } = fakeLogger();
  const port = taobao(settings(config, logger));
  // Baseline: the configured add_back prices the unlisted name.
  for (const item of all(await entries(port, unknownScenario))) expectNormal(item);
  expect(warns).toEqual([]);
  config.fail(UNKNOWN, syntheticError('SyntheticDeadlineError'), 'throw', ctx.appId);
  for (const item of all(await entries(port, unknownScenario))) expectUnknownAnomaly(item);
  expectReadFailedWarns(warns);
  for (const call of warns) readFailedEvent(call, UNKNOWN, 'SyntheticDeadlineError');
  const failedWarns = warns.length;
  config.heal(UNKNOWN, ctx.appId);
  for (const item of all(await entries(port, unknownScenario))) expectNormal(item);
  expect(warns).toHaveLength(failedWarns);
});

it('[AC-B1-22w-DEMO#3] basis 读取抛错时不切到 coupon_only：四个入口与默认映射一致', async () => {
  const config = failingConfig();
  config.set(BASIS, 'coupon_only', ctx.appId);
  config.fail(BASIS, syntheticError('SyntheticStoreError'), 'reject', ctx.appId);
  const { logger, warns } = fakeLogger();
  const failing = await entries(taobao(settings(config, logger)), ctx);
  expect(failing).toEqual(await entries(taobao(), ctx));
  for (const item of all(failing)) expectNormal(item);
  for (const call of warns) readFailedEvent(call, BASIS, 'SyntheticStoreError');
  expect(warns.length).toBeGreaterThan(0);
});

it('[AC-B1-22w-DEMO#4] 读取失败的告警不带商品信息、错误全文与凭据', async () => {
  const config = failingConfig();
  config.failAll(syntheticError('SyntheticStoreError'), 'throw', ctx.appId);
  const { logger, warns } = fakeLogger();
  const items = all(await entries(taobao(settings(config, logger)), unknownScenario));
  const normal = all(await entries(taobao(), ctx));
  expectReadFailedWarns(warns);
  expectNoErrorDetail(warns);
  const text = loggedText(warns);
  for (const item of [...items, ...normal]) {
    expect(text).not.toContain(item.title);
    expect(text).not.toContain(String(Reflect.get(item, 'item_id')));
    const couponIds: unknown = Reflect.get(item, 'coupon_ids');
    if (typeof couponIds === 'string') expect(text).not.toContain(couponIds);
  }
});

it('[AC-B1-22w-DEMO#5] 登记表装配的淘宝演示适配器在配置读取抛错时照常搜索', async () => {
  const endpoints: readonly UnionEndpoint[] = (['taobao', 'jd', 'pdd'] as const).map(
    (platform) => ({ platform, mode: 'demo', baseUrl: null, quotaKey: `demo:${platform}` }),
  );
  const config = failingConfig();
  config.failAll(syntheticError('SyntheticDeadlineError'), 'reject', ctx.appId);
  const { logger, warns } = fakeLogger();
  const registry = createUnionRegistry({
    endpoints,
    environment: 'test',
    seed: SEED,
    clock: new FixedClock(instant),
    taobaoPriceSettings: settings(config, logger),
  });
  const page = await settle(registry.get('taobao').searchItems({ keyword }, ctx), 'searchItems');
  expect(page.items.length).toBeGreaterThan(0);
  const plain = await taobao().searchItems({ keyword }, ctx);
  expect(page).toEqual(plain);
  expectReadFailedWarns(warns);
});
