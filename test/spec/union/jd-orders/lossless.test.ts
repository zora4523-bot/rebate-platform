import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { beyondNumber, mapped, num, one, row } from './kit.ts';

// 订单号是 19 位字符串或 16 位起的数字，都可能超 2^53：一律取原文，不经 JS number。
it('[AC-B1-04zb#27] id、orderId、parentId 原样取，2^53 + 1 不失真', async () => {
  const id = '2026103090071992547';
  const dto = await one(row({ id, orderId: num(beyondNumber), parentId: num(beyondNumber) }));
  expect(dto.sub_order_id).toBe(id);
  expect(dto.order_id).toBe(beyondNumber);
  expect(dto.parent_order_id).toBe(beyondNumber);
  expect(BigInt(dto.order_id)).toBe(2n ** 53n + 1n);
});

it('[AC-B1-04zb#28] parentId 为 0 时 parent_order_id 是 null', async () => {
  expect((await one(row({ parentId: num('0') }))).parent_order_id).toBeNull();
});

it('[AC-B1-04zb#29] positionId、skuId 同样取原文', async () => {
  const dto = await one(row({ positionId: num(beyondNumber), skuId: num(beyondNumber) }), {
    productKeyMode: { read: async () => 'sku' },
  });
  expect(dto.promotion_slot).toBe(beyondNumber);
  expect(dto.item_id).toBe(beyondNumber);
});

it('[AC-B1-04zb#30] 任意 16–19 位数字的订单号都取到原文', () => {
  const digits = fc.bigInt({ min: 10n ** 15n, max: 10n ** 19n - 1n }).map((value) => `${value}`);
  expect(() =>
    fc.assert(
      fc.property(digits, digits, digits, (orderId, parentId, positionId) => {
        const dto = mapped({
          orderId: num(orderId),
          parentId: num(parentId),
          positionId: num(positionId),
        });
        return (
          dto.order_id === orderId &&
          dto.parent_order_id === parentId &&
          dto.promotion_slot === positionId
        );
      }),
      propParams(),
    ),
  ).not.toThrow();
});

it.each([
  ['id', { id: undefined }],
  ['orderId', { orderId: undefined }],
] as const)(
  '[AC-B1-04zb#31] 缺 %s 报 invalid_dto，不产出没有订单键的 DTO',
  async (_name, overrides) => {
    await expect(one(row(overrides))).rejects.toMatchObject({
      code: 'invalid_dto',
      platform: 'jd',
    });
  },
);
