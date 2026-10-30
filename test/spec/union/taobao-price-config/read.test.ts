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
  expectPrice,
  fakeConfig,
  fakeLogger,
  now,
  readWith,
  settings,
  withUnknown,
} from './kit.ts';

it.each([
  ['configValue 答 null', null],
  ['configValue 答 undefined', undefined],
  ['取值为 null', { value: null, version: 1 }],
] as const)('[AC-B1-22q-READ#1] 五个键都缺失（%s）时用 08 默认且不告警', async (_label, raw) => {
  const config = fakeConfig();
  for (const key of KEYS) config.answer(key, raw);
  const { logger, warns } = fakeLogger();
  const options = await settings(config, logger).read(APP);
  expect(effective(options)).toEqual(DEFAULTS);
  expect(warns).toEqual([]);
  expect(mapTaobaoPrice(example, now, options)).toEqual(mapTaobaoPrice(example, now));
  expect(mapTaobaoPrice(withUnknown, now, options)).toEqual(mapTaobaoPrice(withUnknown, now));
});

it('[AC-B1-22q-READ#2] 五个键都合法时全部生效，数组原样替换默认（不合并），不告警', async () => {
  const values = {
    [MEMBER]: ['演示会员', '演示专享'],
    [COUPON]: ['演示券', '商品券'],
    [DISCOUNT]: ['演示立减'],
    [UNKNOWN]: 'add_back',
    [BASIS]: 'coupon_only',
  };
  const { options, warns } = await readWith(values);
  expect(effective(options)).toEqual(values);
  expect(warns).toEqual([]);
});

it.each([
  [UNKNOWN, 'unavailable'],
  [UNKNOWN, 'add_back'],
  [UNKNOWN, 'count'],
  [BASIS, 'promotion_path'],
  [BASIS, 'coupon_only'],
] as const)('[AC-B1-22q-READ#3] %s=%s 是合法取值，照配置生效且不告警', async (key, value) => {
  const { options, warns } = await readWith({ [key]: value });
  expect(effective(options)).toEqual({ ...DEFAULTS, [key]: value });
  expect(warns).toEqual([]);
});

it('[AC-B1-22q-READ#4] coupon_titles 配置后自定义券名被识别为券，默认券名不再是券', async () => {
  const custom = {
    discount_fen: 3990n,
    promotion_final_fen: 3490n,
    promotions: [{ title: '演示券', amount_fen: 500n, id: 'demo-custom' }],
  };
  const listed = {
    ...custom,
    promotions: [{ title: '商品券', amount_fen: 500n, id: 'demo-default' }],
  };
  const configured = await readWith({ [COUPON]: ['演示券'] });
  expectPrice(mapTaobaoPrice(custom, now, configured.options), 3990n, 500n, 3490n, 'demo-custom');
  const dropped = mapTaobaoPrice(listed, now, configured.options);
  expectAnomaly(dropped, 'unknown_promo');
  expect(dropped.warnings).toContainEqual({ code: 'PRICE_PROMO_UNKNOWN', title: '商品券' });
  const unset = await readWith({});
  expectAnomaly(mapTaobaoPrice(custom, now, unset.options), 'unknown_promo');
  expectPrice(mapTaobaoPrice(listed, now, unset.options), 3990n, 500n, 3490n, 'demo-default');
});

it('[AC-B1-22q-READ#5] member_title_keywords 配置后按包含匹配加回，默认 88VIP 不再是会员项', async () => {
  const input = (title: string) => ({
    discount_fen: 3990n,
    promotion_final_fen: 3890n,
    promotions: [{ title, amount_fen: 100n }],
  });
  const configured = await readWith({ [MEMBER]: ['演示会员'] });
  expectPrice(mapTaobaoPrice(input('演示会员价'), now, configured.options), 3990n, 0n, 3990n);
  expectAnomaly(mapTaobaoPrice(input('88VIP'), now, configured.options), 'unknown_promo');
  const unset = await readWith({});
  expectPrice(mapTaobaoPrice(input('88VIP'), now, unset.options), 3990n, 0n, 3990n);
  expectAnomaly(mapTaobaoPrice(input('演示会员价'), now, unset.options), 'unknown_promo');
});

it('[AC-B1-22q-READ#6] discount_titles 配置后自定义立减计入券前价，默认立减名不再识别', async () => {
  const input = (title: string) => ({
    discount_fen: 3990n,
    promotion_final_fen: 3190n,
    promotions: [{ title, amount_fen: 800n }],
  });
  const configured = await readWith({ [DISCOUNT]: ['演示立减'] });
  expectPrice(mapTaobaoPrice(input('演示立减'), now, configured.options), 3190n, 0n, 3190n);
  expectAnomaly(mapTaobaoPrice(input('百亿补贴'), now, configured.options), 'unknown_promo');
  const unset = await readWith({});
  expectPrice(mapTaobaoPrice(input('百亿补贴'), now, unset.options), 3190n, 0n, 3190n);
});

it.each([
  [undefined, 2990n, 2490n],
  ['promotion_path', 2990n, 2490n],
  ['coupon_only', 3990n, 3490n],
] as const)('[AC-B1-22q-READ#7] basis=%s：08 例表的券前价与券后价', async (basis, price, final) => {
  const { options } = await readWith(basis === undefined ? {} : { [BASIS]: basis });
  expectPrice(mapTaobaoPrice(example, now, options), price, 500n, final, 'demo-coupon');
});

it.each([undefined, 'unavailable', 'add_back', 'count'] as const)(
  '[AC-B1-22q-READ#8] unknown_promo=%s 决定清单外名称的计价',
  async (unknown) => {
    const { options } = await readWith(unknown === undefined ? {} : { [UNKNOWN]: unknown });
    const result = mapTaobaoPrice(withUnknown, now, options);
    if (unknown === undefined || unknown === 'unavailable') expectAnomaly(result, 'unknown_promo');
    else if (unknown === 'add_back') expectPrice(result, 3990n, 300n, 3690n, 'demo-store');
    else expectPrice(result, 3790n, 300n, 3490n, 'demo-store');
    expect(result.warnings).toContainEqual({
      code: 'PRICE_PROMO_UNKNOWN',
      title: '某个清单外的名称',
    });
  },
);

it('[AC-B1-22q-READ#9] 全部自定义取值同时生效：组合口径与逐键一致', async () => {
  const { options, warns } = await readWith(CUSTOM);
  expect(effective(options)).toEqual(CUSTOM);
  expect(warns).toEqual([]);
  // coupon_only + count: only '演示券' is deducted; the unlisted name is counted, not added back.
  const result = mapTaobaoPrice(
    {
      discount_fen: 3990n,
      promotion_final_fen: 3290n,
      promotions: [
        { title: '演示券', amount_fen: 500n, id: 'demo-custom' },
        { title: '商品券', amount_fen: 200n },
      ],
    },
    now,
    options,
  );
  expectPrice(result, 3990n, 500n, 3490n, 'demo-custom');
});
