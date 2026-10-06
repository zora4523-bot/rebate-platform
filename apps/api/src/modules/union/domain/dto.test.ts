import { expect, it } from 'vitest';
import { makeUnionItem, makeUnionOrder, UnionError, type ItemInput } from '../index.ts';

// Local unit-test identifiers; not AC-LINK / AC-ORD acceptance.
const clock = { now: () => new Date('2026-10-06T00:00:00Z') };
const input: ItemInput = {
  platform: 'jd',
  itemId: 'item-A',
  skuId: null,
  title: 'unit',
  price_fen: '100',
  coupon_fen: '0',
  final_price_fen: '100',
  commission_percent: '1',
};

function code(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error instanceof UnionError ? error.code : error;
  }
  return 'no error';
}

it.each(['-0', '-0.00', '-0.001'])('[AC-B1-04b-UNIT#5] 佣金率 %j 带负号即拒绝', (percent) => {
  expect(code(() => makeUnionItem({ ...input, commission_percent: percent }, clock))).toBe(
    'invalid_dto',
  );
});

it.each(['-0', -0, -1n, '-00'])('[AC-B1-04b-UNIT#6] 金额 %s 带负号即拒绝', (value) => {
  expect(code(() => makeUnionItem({ ...input, price_fen: value }, clock))).toBe('invalid_dto');
  expect(
    code(() =>
      makeUnionOrder({ platform: 'jd', order_id: 'o-1', paid_fen: value, commission_fen: 0n }),
    ),
  ).toBe('invalid_dto');
});

it('[AC-B1-04b-UNIT#7] 0 与 0.00 合法', () => {
  const result = makeUnionItem({ ...input, price_fen: 0, commission_percent: '0.00' }, clock);
  expect([result.price_fen, result.commission_rate_bp]).toEqual([0n, 0n]);
});
