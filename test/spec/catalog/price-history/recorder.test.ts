// B1-17b: the after-response recorder (BR-WATCH-19 (1): 响应后异步写入，写入失败只计数不重试，
// 不得影响接口; orchestrator semantics B.2, B.4, B.5). A fake store stands in for the database.
import { expect, it } from 'vitest';
import {
  createPriceSnapshotRecorder,
  type PriceObservation,
  type PriceSnapshotWriteOutcome,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  INTERVAL_KEY,
  at,
  deferred,
  fakeStore,
  intervalConfig,
  observation,
  recorderSetup,
  settle,
} from './kit.ts';

it('[AC-B1-17b#24] 可写观测交给 store 恰好一次，只带表列：时刻取 record 当下的 Clock，间隔缺省 10', async () => {
  const { options, clock, write } = recorderSetup();
  const recorder = createPriceSnapshotRecorder(options);
  clock.set(at('08:00'));
  const handedOff = recorder.record(
    observation({ skuKey: 'sku-1', couponFen: 500n, finalPriceFen: 4000n, inStock: false }),
  );
  expect(handedOff).toBeUndefined();
  clock.set(at('09:00'));
  await recorder.drain();
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]![0]).toStrictEqual({
    appId: 'ph-app',
    platform: 'taobao',
    productKey: 'tb:123',
    skuKey: 'sku-1',
    sourceKind: 'detail',
    values: { priceFen: 4500n, couponFen: 500n, finalPriceFen: 4000n, inStock: false },
    goodsSignPlan: null,
    observedAt: at('08:00'),
    touchMinIntervalMinutes: 10,
  });
  expect(recorder.failureCount()).toBe(0);
}, 10_000);

it('[AC-B1-17b#25] 拼多多观测把 goods_sign_plan 原样交给 store', async () => {
  const { options, write } = recorderSetup();
  const recorder = createPriceSnapshotRecorder(options);
  recorder.record(observation({ platform: 'pdd', productKey: 'pdd:77', goodsSignPlan: 'search' }));
  await recorder.drain();
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]![0]).toMatchObject({
    platform: 'pdd',
    productKey: 'pdd:77',
    goodsSignPlan: 'search',
  });
}, 10_000);

it('[AC-B1-17b#26] 运行期混入的用户标识字段不会被交给 store（写入只含表定义的列）', async () => {
  const { options, write } = recorderSetup();
  const recorder = createPriceSnapshotRecorder(options);
  const smuggled = {
    ...observation(),
    userId: 'u-secret',
    deviceId: 'd-secret',
    relationId: 'r-secret',
    subUnionId: 's-secret',
    customParameters: 'c-secret',
    region: 'g-secret',
  } as PriceObservation;
  recorder.record(smuggled);
  await recorder.drain();
  expect(write).toHaveBeenCalledTimes(1);
  const input = write.mock.calls[0]![0];
  expect(Object.keys(input).sort()).toEqual([
    'appId',
    'goodsSignPlan',
    'observedAt',
    'platform',
    'productKey',
    'skuKey',
    'sourceKind',
    'touchMinIntervalMinutes',
    'values',
  ]);
  expect(Object.keys(input.values).sort()).toEqual([
    'couponFen',
    'finalPriceFen',
    'inStock',
    'priceFen',
  ]);
  expect(
    JSON.stringify(input, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}` : v)),
  ).not.toMatch(/secret/);
}, 10_000);

it.each([
  ['upstream failed', observation({ outcome: 'failed' })],
  ['timeout', observation({ outcome: 'timeout' })],
  ['rate limited', observation({ outcome: 'rate_limited' })],
  ['price anomaly', observation({ priceStatus: 'anomaly' })],
  ['cache / stale', observation({ fresh: false })],
  ['user-level parameter', observation({ userScoped: true })],
  ['convert', observation({ sourceKind: 'convert' })],
  ['pdd without plan', observation({ platform: 'pdd', productKey: 'pdd:7', goodsSignPlan: null })],
] as const)(
  '[AC-B1-17b#27] 拒写的观测（%s）不交给 store，也不算写入失败',
  async (_name, obs) => {
    const { options, write } = recorderSetup();
    const recorder = createPriceSnapshotRecorder(options);
    expect(recorder.record(obs)).toBeUndefined();
    await recorder.drain();
    expect(write).not.toHaveBeenCalled();
    expect(recorder.failureCount()).toBe(0);
  },
  10_000,
);

it('[AC-B1-17b#28] 交出即返回：store 未完成时 record 已同步返回，drain 等到已交出的写入结束才完成', async () => {
  const pending = deferred<PriceSnapshotWriteOutcome>();
  const { store, write } = fakeStore(() => pending.promise);
  const { options } = recorderSetup({ store });
  const recorder = createPriceSnapshotRecorder(options);
  expect(recorder.record(observation())).toBeUndefined();
  let drained = false;
  const draining = recorder.drain().then(() => {
    drained = true;
  });
  await settle(20);
  expect(write).toHaveBeenCalledTimes(1);
  expect(drained).toBe(false);
  pending.resolve('inserted');
  await draining;
  expect(drained).toBe(true);
  expect(recorder.failureCount()).toBe(0);
}, 10_000);

it('[AC-B1-17b#29] 写库失败：record 不抛、drain 不拒绝，只尝试一次不重试，计数 + 1，打一条平铺 warn（code=PRICE_SNAPSHOT_WRITE_FAILED）', async () => {
  const { store, write } = fakeStore(async () => {
    throw new Error('connection refused');
  });
  const { options, warn } = recorderSetup({ store });
  const recorder = createPriceSnapshotRecorder(options);
  expect(() => recorder.record(observation())).not.toThrow();
  await expect(recorder.drain()).resolves.toBeUndefined();
  await settle(100);
  await recorder.drain();
  expect(write).toHaveBeenCalledTimes(1);
  expect(recorder.failureCount()).toBe(1);
  expect(warn).toHaveBeenCalledTimes(1);
  const fields = warn.mock.calls[0]![0] as Record<string, unknown>;
  expect(fields).toMatchObject({ code: 'PRICE_SNAPSHOT_WRITE_FAILED' });
  for (const value of Object.values(fields)) {
    expect(value === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value)).toBe(
      true,
    );
  }
}, 10_000);

it('[AC-B1-17b#30] store 同步抛错也不外泄：record 不抛，计数 + 1，不重试', async () => {
  const { store, write } = fakeStore(() => {
    throw new Error('pool ended');
  });
  const { options } = recorderSetup({ store });
  const recorder = createPriceSnapshotRecorder(options);
  expect(() => recorder.record(observation())).not.toThrow();
  await recorder.drain();
  await settle(50);
  expect(write).toHaveBeenCalledTimes(1);
  expect(recorder.failureCount()).toBe(1);
}, 10_000);

it('[AC-B1-17b#31] 多次交出互不连累：第 2 次失败只计 1 次，第 1、3 次照常写入', async () => {
  let calls = 0;
  const { store, write } = fakeStore(async () => {
    calls += 1;
    if (calls === 2) throw new Error('deadlock detected');
    return 'inserted';
  });
  const { options, warn } = recorderSetup({ store });
  const recorder = createPriceSnapshotRecorder(options);
  for (const fen of [4500n, 3900n, 3500n]) {
    recorder.record(observation({ priceFen: fen, finalPriceFen: fen }));
    await recorder.drain();
  }
  expect(write).toHaveBeenCalledTimes(3);
  expect(recorder.failureCount()).toBe(1);
  expect(warn).toHaveBeenCalledTimes(1);
}, 10_000);

it('[AC-B1-17b#32] Clock 抛错时 record 也不抛，观测不交给 store，drain 照常完成', async () => {
  const { options, write } = recorderSetup();
  const brokenClock = {
    now(): Date {
      throw new Error('clock unavailable');
    },
  };
  const recorder = createPriceSnapshotRecorder({ ...options, clock: brokenClock });
  expect(() => recorder.record(observation())).not.toThrow();
  await expect(recorder.drain()).resolves.toBeUndefined();
  expect(write).not.toHaveBeenCalled();
}, 10_000);

it.each([
  ['缺省（无配置）', undefined, false, 10],
  ['30', 30, false, 30],
  ['1', 1, false, 1],
  ['0', 0, false, 10],
  ['负数', -5, false, 10],
  ['小数', 2.5, false, 10],
  ['字符串', '15', false, 10],
  ['布尔', true, false, 10],
  ['读取失败', 30, true, 10],
] as const)(
  '[AC-B1-17b#33] touch_min_interval_minutes 经 CatalogConfigReader 按 app 读：%s',
  async (_name, value, fail, expected) => {
    const config = intervalConfig(value, fail);
    const { options, write } = recorderSetup({ config });
    const recorder = createPriceSnapshotRecorder(options);
    recorder.record(observation({ appId: 'ph-config-app' }));
    await recorder.drain();
    expect(config.configValue).toHaveBeenCalledWith('ph-config-app', INTERVAL_KEY);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0].touchMinIntervalMinutes).toBe(expected);
    expect(recorder.failureCount()).toBe(0);
  },
  10_000,
);
