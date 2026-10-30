import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  DemoUnionAdapter,
  createUnionRegistry,
  isPriceAnomaly,
  type CallCtx,
  type TaobaoPriceOptions,
  type TaobaoPriceSettingsReader,
  type UnionEndpoint,
  type UnionItem,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  BASIS,
  KEYS,
  UNKNOWN,
  expectKeyWarn,
  fakeConfig,
  fakeLogger,
  logged,
  settings,
} from './kit.ts';

const ctx: CallCtx = {
  appId: 'demo-price-config-app',
  requestId: 'demo-price-config-request',
  purpose: 'online',
};
const unknownScenario: CallCtx = { ...ctx, scenario: 'unknown_promo' };
const keyword = '演示';
const instant = '2031-02-03T04:05:06.789Z';
const SEED = 'demo-price-config';

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

async function readsOf(port: DemoUnionAdapter, call: CallCtx): Promise<UnionItem[]> {
  const search = await port.searchItems({ keyword }, call);
  const feed = await port.materialFeed({}, call);
  expect(search.items.length).toBeGreaterThan(0);
  expect(feed.items.length).toBeGreaterThan(0);
  const detail = await port.getItem(search.items[0]!, call);
  return [...search.items, ...feed.items, detail];
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

it('[AC-B1-22q-DEMO#1] 淘宝演示适配器每次映射用 settings.read(ctx.appId) 的结果作参数', async () => {
  // Baseline: without settings the 08 default (unavailable) keeps the unlisted name unpriced.
  for (const item of await readsOf(taobao(), unknownScenario)) expectUnknownAnomaly(item);
  const { reader, reads } = recording({ unknown_promo: 'add_back' });
  const port = taobao(reader);
  for (const item of await readsOf(port, unknownScenario)) expectNormal(item);
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((appId) => appId === ctx.appId)).toBe(true);
  const before = reads.length;
  await port.searchItems({ keyword }, unknownScenario);
  expect(reads.length).toBeGreaterThan(before);
});

it('[AC-B1-22q-DEMO#2] 经 createTaobaoPriceSettings 读配置：读到 ctx.appId 的五个键，改配置下一次调用即变', async () => {
  const config = fakeConfig();
  const { logger, warns } = fakeLogger();
  config.set(UNKNOWN, 'add_back', ctx.appId);
  const port = taobao(settings(config, logger));
  for (const item of await readsOf(port, unknownScenario)) expectNormal(item);
  expect(config.calls.length).toBeGreaterThan(0);
  expect(config.calls.every((call) => call.appId === ctx.appId)).toBe(true);
  expect(new Set(config.calls.map((call) => call.key))).toEqual(new Set(KEYS));
  config.set(UNKNOWN, 'unavailable', ctx.appId);
  for (const item of await readsOf(port, unknownScenario)) expectUnknownAnomaly(item);
  config.set(UNKNOWN, 'count', ctx.appId);
  for (const item of await readsOf(port, unknownScenario)) expectNormal(item);
  config.remove(UNKNOWN, ctx.appId);
  for (const item of await readsOf(port, unknownScenario)) expectUnknownAnomaly(item);
  expect(warns).toEqual([]);
});

it('[AC-B1-22q-DEMO#3] basis=coupon_only 经 settings 进入演示映射：券不变，券前价不再扣平台立减', async () => {
  const plain = await taobao().searchItems({ keyword }, ctx);
  const { reader } = recording({ basis: 'coupon_only' });
  const degraded = await taobao(reader).searchItems({ keyword }, ctx);
  const ids = (page: typeof plain) => page.items.map((item) => Reflect.get(item, 'item_id'));
  expect(ids(degraded)).toEqual(ids(plain));
  let raised = 0;
  degraded.items.forEach((item, index) => {
    const base = plain.items[index]!;
    expectNormal(item);
    expect(item.coupon_fen).toBe(base.coupon_fen);
    expect(item.price_fen >= base.price_fen).toBe(true);
    if (item.price_fen > base.price_fen) raised++;
  });
  expect(raised).toBeGreaterThan(0);
});

it('[AC-B1-22q-DEMO#4] 登记表装配把 taobaoPriceSettings 交给淘宝演示适配器', async () => {
  const endpoints: readonly UnionEndpoint[] = (['taobao', 'jd', 'pdd'] as const).map(
    (platform) => ({ platform, mode: 'demo', baseUrl: null, quotaKey: `demo:${platform}` }),
  );
  const { reader, reads } = recording({ unknown_promo: 'add_back' });
  const registry = createUnionRegistry({
    endpoints,
    environment: 'test',
    seed: SEED,
    clock: new FixedClock(instant),
    taobaoPriceSettings: reader,
  });
  const page = await registry.get('taobao').searchItems({ keyword }, unknownScenario);
  expect(page.items.length).toBeGreaterThan(0);
  for (const item of page.items) expectNormal(item);
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((appId) => appId === ctx.appId)).toBe(true);
});

it('[AC-B1-22q-DEMO#5] 配置不合法时演示映射回落默认，告警只带键名、不带商品信息', async () => {
  const config = fakeConfig();
  const { logger, warns } = fakeLogger();
  config.set(UNKNOWN, 'ADD_BACK', ctx.appId);
  config.set(BASIS, 'coupon_only', ctx.appId);
  const port = taobao(settings(config, logger));
  const items = await readsOf(port, unknownScenario);
  for (const item of items) expectUnknownAnomaly(item);
  expect(warns.length).toBeGreaterThan(0);
  for (const call of warns) expectKeyWarn(call, UNKNOWN);
  const normal = await readsOf(taobao(), ctx);
  const text = logged(warns);
  for (const item of [...items, ...normal]) {
    expect(text).not.toContain(item.title);
    expect(text).not.toContain(String(Reflect.get(item, 'item_id')));
    const couponIds: unknown = Reflect.get(item, 'coupon_ids');
    if (typeof couponIds === 'string') expect(text).not.toContain(couponIds);
  }
});
