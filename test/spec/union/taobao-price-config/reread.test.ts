import { expect, it } from 'vitest';
import { mapTaobaoPrice } from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP,
  BASIS,
  COUPON,
  DEFAULTS,
  KEYS,
  OTHER_APP,
  UNKNOWN,
  effective,
  example,
  expectAnomaly,
  expectKeyWarn,
  expectPrice,
  fakeConfig,
  fakeLogger,
  now,
  settings,
  withUnknown,
} from './kit.ts';

it('[AC-B1-22q-REREAD#1] 每次 read 都按该 appId 重新读五个键，不缓存', async () => {
  const config = fakeConfig();
  const reader = settings(config);
  for (let round = 0; round < 3; round++) {
    const start = config.calls.length;
    await reader.read(APP);
    const calls = config.calls.slice(start);
    expect(new Set(calls.map((call) => call.key))).toEqual(new Set(KEYS));
    expect(calls.every((call) => call.appId === APP)).toBe(true);
  }
});

it('[AC-B1-22q-REREAD#2] 改配置后下一次 read 即生效；删除后回到默认', async () => {
  const config = fakeConfig();
  const { logger, warns } = fakeLogger();
  const reader = settings(config, logger);
  config.set(COUPON, ['演示券']);
  config.set(BASIS, 'coupon_only');
  let options = await reader.read(APP);
  expect(effective(options)[COUPON]).toEqual(['演示券']);
  expect(effective(options)[BASIS]).toBe('coupon_only');
  config.set(COUPON, ['商品券', '演示券二']);
  config.set(BASIS, 'promotion_path');
  options = await reader.read(APP);
  expect(effective(options)[COUPON]).toEqual(['商品券', '演示券二']);
  expectPrice(mapTaobaoPrice(example, now, options), 2990n, 500n, 2490n, 'demo-coupon');
  config.remove(COUPON);
  config.remove(BASIS);
  options = await reader.read(APP);
  expect(effective(options)).toEqual(DEFAULTS);
  expect(warns).toEqual([]);
});

it('[AC-B1-22q-REREAD#3] unknown_promo 在两次映射之间改动，第二次映射按新取值', async () => {
  const config = fakeConfig();
  const reader = settings(config);
  config.set(UNKNOWN, 'add_back');
  expectPrice(
    mapTaobaoPrice(withUnknown, now, await reader.read(APP)),
    3990n,
    300n,
    3690n,
    'demo-store',
  );
  config.set(UNKNOWN, 'unavailable');
  expectAnomaly(mapTaobaoPrice(withUnknown, now, await reader.read(APP)), 'unknown_promo');
});

it('[AC-B1-22q-REREAD#4] 只读调用方的 appId：另一个应用的配置不串用', async () => {
  const config = fakeConfig();
  const reader = settings(config);
  config.set(BASIS, 'coupon_only', APP);
  config.set(UNKNOWN, 'count', OTHER_APP);
  const start = config.calls.length;
  const mine = await reader.read(APP);
  expect(config.calls.slice(start).every((call) => call.appId === APP)).toBe(true);
  const middle = config.calls.length;
  const theirs = await reader.read(OTHER_APP);
  expect(config.calls.slice(middle).every((call) => call.appId === OTHER_APP)).toBe(true);
  expect(effective(mine)).toEqual({ ...DEFAULTS, [BASIS]: 'coupon_only' });
  expect(effective(theirs)).toEqual({ ...DEFAULTS, [UNKNOWN]: 'count' });
});

it('[AC-B1-22q-REREAD#5] 不合法取值修正后下一次 read 用新值，修正后不再告警', async () => {
  const config = fakeConfig();
  const { logger, warns } = fakeLogger();
  const reader = settings(config, logger);
  config.set(UNKNOWN, 'Add_Back');
  expect(effective(await reader.read(APP))[UNKNOWN]).toBe(DEFAULTS[UNKNOWN]);
  expect(warns).toHaveLength(1);
  expectKeyWarn(warns[0], UNKNOWN);
  config.set(UNKNOWN, 'add_back');
  expect(effective(await reader.read(APP))[UNKNOWN]).toBe('add_back');
  expect(warns).toHaveLength(1);
});
