import { expect, it } from 'vitest';
import { mapTaobaoPrice } from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP,
  BASIS,
  COUPON,
  CUSTOM,
  DEFAULTS,
  DISCOUNT,
  KEYS,
  MEMBER,
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
  type PriceKey,
} from './kit.ts';

const invalidLists: readonly (readonly [string, unknown])[] = [
  ['字符串而非数组', '演示'],
  ['空数组', []],
  ['数组含数字', ['演示', 1]],
  ['数组含空串', ['演示', '']],
  ['数组含 null', ['演示', null]],
  ['数组含对象', ['演示', { title: '演示' }]],
  ['对象', { 0: '演示' }],
  ['数字', 1],
  ['布尔', true],
];
const invalidUnknown: readonly (readonly [string, unknown])[] = [
  ['大写', 'UNAVAILABLE'],
  ['集合外', 'skip'],
  ['空串', ''],
  ['数字', 1],
  ['布尔', true],
  ['数组', ['add_back']],
  ['对象', { mode: 'add_back' }],
];
const invalidBasis: readonly (readonly [string, unknown])[] = [
  ['集合外', 'coupon'],
  ['大写', 'COUPON_ONLY'],
  ['空串', ''],
  ['数字', 0],
  ['数组', ['coupon_only']],
  ['对象', { basis: 'coupon_only' }],
];
const cases: readonly (readonly [PriceKey, string, unknown])[] = [
  ...invalidLists.map(([label, value]) => [MEMBER, label, value] as const),
  ...invalidLists.map(([label, value]) => [COUPON, label, value] as const),
  ...invalidLists.map(([label, value]) => [DISCOUNT, label, value] as const),
  ...invalidUnknown.map(([label, value]) => [UNKNOWN, label, value] as const),
  ...invalidBasis.map(([label, value]) => [BASIS, label, value] as const),
];

it.each(cases)(
  '[AC-B1-22q-INVALID#1] %s 取值不合法（%s）：该键回落 08 默认并告警一条，其他四键照常生效',
  async (key, _label, value) => {
    const config = fakeConfig();
    for (const other of KEYS) config.set(other, CUSTOM[other]);
    config.set(key, value);
    const { logger, warns } = fakeLogger();
    const options = await settings(config, logger).read(APP);
    expect(effective(options)).toEqual({ ...CUSTOM, [key]: DEFAULTS[key] });
    expect(warns).toHaveLength(1);
    expectKeyWarn(warns[0], key);
  },
);

it('[AC-B1-22q-INVALID#2] 两个键同时不合法：各自回落默认、各告警一条，事件名相同', async () => {
  const config = fakeConfig();
  config.set(MEMBER, ['演示会员']);
  config.set(COUPON, []);
  config.set(DISCOUNT, ['演示立减']);
  config.set(UNKNOWN, 'add_back');
  config.set(BASIS, 'degraded');
  const { logger, warns } = fakeLogger();
  const options = await settings(config, logger).read(APP);
  expect(effective(options)).toEqual({
    [MEMBER]: ['演示会员'],
    [COUPON]: DEFAULTS[COUPON],
    [DISCOUNT]: ['演示立减'],
    [UNKNOWN]: 'add_back',
    [BASIS]: DEFAULTS[BASIS],
  });
  expect(warns).toHaveLength(2);
  const byKey = new Map<string, string>();
  for (const call of warns) {
    const named = [COUPON, BASIS].filter((key) => Object.values(call[0] as object).includes(key));
    expect(named).toHaveLength(1);
    byKey.set(named[0]!, expectKeyWarn(call, named[0]!));
  }
  expect([...byKey.keys()].sort()).toEqual([BASIS, COUPON].sort());
  expect(new Set(byKey.values()).size).toBe(1);
});

it('[AC-B1-22q-INVALID#3] 告警事件名固定：五个键各自不合法时事件名相同', async () => {
  const events = new Set<string>();
  for (const key of KEYS) {
    const config = fakeConfig();
    config.set(key, 42);
    const { logger, warns } = fakeLogger();
    await settings(config, logger).read(APP);
    expect(warns).toHaveLength(1);
    events.add(expectKeyWarn(warns[0], key));
  }
  expect(events.size).toBe(1);
});

it('[AC-B1-22q-INVALID#4] 不合法的 basis 不会把价格切到降级口径', async () => {
  const config = fakeConfig();
  config.set(BASIS, 'COUPON_ONLY');
  const options = await settings(config).read(APP);
  expectPrice(mapTaobaoPrice(example, now, options), 2990n, 500n, 2490n, 'demo-coupon');
});

it('[AC-B1-22q-INVALID#5] 不合法的 unknown_promo 按默认 unavailable：清单外名称不出价', async () => {
  const config = fakeConfig();
  config.set(UNKNOWN, 'ADD_BACK');
  const options = await settings(config).read(APP);
  expectAnomaly(mapTaobaoPrice(withUnknown, now, options), 'unknown_promo');
});

it('[AC-B1-22q-INVALID#6] 空清单配置不会让默认券名失效（回落默认，不是显式空清单）', async () => {
  const config = fakeConfig();
  config.set(COUPON, []);
  config.set(MEMBER, []);
  config.set(DISCOUNT, []);
  const { logger, warns } = fakeLogger();
  const options = await settings(config, logger).read(APP);
  expectPrice(mapTaobaoPrice(example, now, options), 2990n, 500n, 2490n, 'demo-coupon');
  expect(warns).toHaveLength(3);
});
