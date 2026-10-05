import { expect, it } from 'vitest';
import { deriveProductKey } from '@couli/domain';
import { makeUnionItem, makeUnionOrder } from '../../../../apps/api/src/modules/union/index.ts';
import { errorCode, fixedClock, item, itemInput } from './kit.ts';

it.each([
  [{ platform: 'taobao' as const, item_id: 'opaque-prefix-ABC_001' }, 'tb', 'tb:ABC_001'],
  [{ platform: 'jd' as const, itemId: 'JD_001', skuId: null }, 'jd', 'jd:i_001'],
  [
    { platform: 'pdd' as const, goods_id: 'PDD_001', goods_sign: 'opaque-sign' },
    'pdd',
    'pdd:PDD_001',
  ],
])('[AC-B1-04b-DTO#11] 商品 DTO 可直接交给 domain 派生商品键 %s', (ref, keyPrefix, expected) => {
  const dto = makeUnionItem({ ...itemInput, ...ref }, fixedClock);
  // Pass the DTO itself: no ID projection, coercion or platform-specific shim here.
  expect(deriveProductKey({ platform: ref.platform, keyPrefix }, dto)).toBe(expected);
});

// AC-B1-04b-* are local test identifiers, not claims of AC-LINK / AC-ORD acceptance.
it('[AC-B1-04b-DTO#1] 商品保留京东空 skuId、三种价格、佣金率与注入时钟的取数时刻', () => {
  expect(makeUnionItem(itemInput, fixedClock)).toEqual(item);
});

it.each([
  ['0', 0n],
  ['0.29', 29n],
  ['12.34', 1234n],
  ['99.99', 9999n],
  ['100', 10000n],
])('[AC-B1-04b-DTO#2] 用例 %#：百分数字符串精确转万分之一整数，不走浮点', (percent, bp) => {
  expect(
    makeUnionItem({ ...itemInput, commission_percent: percent }, fixedClock).commission_rate_bp,
  ).toBe(bp);
});

it.each(['', '1e1', 'NaN', 'Infinity', '-1', '100.01', '12.3x', ' 12', '12\n'])(
  '[AC-B1-04b-DTO#3] 拒绝无效或越界佣金率 %j',
  (commission_percent) => {
    expect(errorCode(() => makeUnionItem({ ...itemInput, commission_percent }, fixedClock))).toBe(
      'invalid_dto',
    );
  },
);

it.each(['price_fen', 'coupon_fen', 'final_price_fen'] as const)(
  '[AC-B1-04b-DTO#4] %s 不接受非整数分、负价格或不安全数字',
  (field) => {
    for (const value of [
      '1.01',
      0.1,
      NaN,
      Infinity,
      9007199254740992,
      '-1',
      '9223372036854775808',
    ]) {
      expect(errorCode(() => makeUnionItem({ ...itemInput, [field]: value }, fixedClock))).toBe(
        'invalid_dto',
      );
    }
  },
);

it('[AC-B1-04b-DTO#5] 超出 JS 安全整数的整数分字符串保持精度，不把价格转成 number', () => {
  const result = makeUnionItem(
    {
      ...itemInput,
      price_fen: '9007199254740993',
      coupon_fen: 0n,
      final_price_fen: '9007199254740993',
    },
    fixedClock,
  );
  expect([result.price_fen, result.coupon_fen, result.final_price_fen]).toEqual([
    9007199254740993n,
    0n,
    9007199254740993n,
  ]);
});

it.each([
  { platform: 'taobao' as const, item_id: 'prefix-item-A' },
  { platform: 'jd' as const, itemId: 'item-A', skuId: null },
  { platform: 'pdd' as const, goods_id: 'goods-A', goods_sign: 'opaque-sign' },
])('[AC-B1-04b-DTO#6] 统一 DTO 原样保留商品标识 $platform', (ref) => {
  expect(makeUnionItem({ ...itemInput, ...ref }, fixedClock)).toMatchObject(ref);
});

it('[AC-B1-04b-DTO#7] quoted_at 每次来自所注入的 Clock', () => {
  const later = { now: () => new Date('2030-01-02T03:04:05.678Z') };
  expect(makeUnionItem(itemInput, later).quoted_at).toBe('2030-01-02T03:04:05.678Z');
});

it.each(['000012345', '900719925474099312345', 'order-A-0001'])(
  '[AC-B1-04b-DTO#8] 订单号 %s 始终是原始字符串，金额保持整数分',
  (order_id) => {
    expect(
      makeUnionOrder({
        platform: 'jd',
        order_id,
        paid_fen: '9007199254740993',
        commission_fen: 1234n,
      }),
    ).toEqual({ platform: 'jd', order_id, paid_fen: 9007199254740993n, commission_fen: 1234n });
  },
);

it.each([123, 9007199254740992, 123n, null, '', {}])(
  '[AC-B1-04b-DTO#9] 用例 %#：拒绝非字符串或空订单号，不能先损失精度再转字符串',
  (order_id) => {
    expect(
      errorCode(() =>
        makeUnionOrder({ platform: 'jd', order_id, paid_fen: 100n, commission_fen: 1n }),
      ),
    ).toBe('invalid_dto');
  },
);

it.each(['paid_fen', 'commission_fen'] as const)(
  '[AC-B1-04b-DTO#10] 订单 %s 拒绝非整数分',
  (field) => {
    expect(
      errorCode(() =>
        makeUnionOrder({
          platform: 'pdd',
          order_id: 'order-A',
          paid_fen: 100n,
          commission_fen: 1n,
          [field]: '0.5',
        }),
      ),
    ).toBe('invalid_dto');
  },
);
