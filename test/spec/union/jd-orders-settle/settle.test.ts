import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { mapped, num, one, row } from '../jd-orders/kit.ts';

// Task-local AC labels ([AC-B1-04zl#n]) identify this task's acceptance points, not business rules.
// D10-529：京东官方 validCode 没有已结算码，18 不存在，按普通码处理；settle 恒 null，结算额由联盟
// 结算明细导入写 order_settlements（source=STATEMENT）；est 在 17 取 actualFee，其余取 estimateFee。

/** 映射用不上的金额字段：取这些值都不影响该行。 */
const UNREAD_VALUES = [
  ['负数', num('-1.00')],
  ['非数字串', 'abc'],
  ['null', null],
  ['缺字段', undefined],
] as const;

/** A signed yuan literal and its fen worked out by hand on bigint: mathematical floor. */
const signedYuan = fc
  .tuple(fc.boolean(), fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.stringMatching(/^[0-9]{0,6}$/))
  .map(([negative, whole, tail]) => {
    const exact = whole * 100n + BigInt(tail.slice(0, 2).padEnd(2, '0'));
    const dropped = /[1-9]/.test(tail.slice(2));
    const text = tail === '' ? `${whole}` : `${whole}.${tail}`;
    if (!negative) return { text, fen: exact };
    return { text: `-${text}`, fen: -exact - (dropped ? 1n : 0n) };
  });

it('[AC-B1-04zl#1] validCode 18 是普通码：est、commission 取 estimateFee，paid 取 estimateCosPrice，settle 为 null，paid_at = orderTime', async () => {
  const dto = await one(
    row({
      validCode: num('18'),
      estimateFee: num('1.23'),
      actualFee: num('7.89'),
      estimateCosPrice: num('45.60'),
      actualCosPrice: num('44.10'),
    }),
  );
  expect(dto).toMatchObject({
    raw_status: '18',
    est_commission_fen: 123n,
    commission_fen: 123n,
    settle_commission_fen: null,
    paid_fen: 4560n,
    deposit_paid_at: null,
  });
  expect(dto.paid_at?.toISOString()).toBe('2026-10-30T02:00:01.000Z');
});

it.each(UNREAD_VALUES)(
  '[AC-B1-04zl#2] validCode 18：不读的 actualFee、actualCosPrice 是%s时照常映射',
  async (_name, value) => {
    const input = row({ validCode: num('18'), actualFee: value, actualCosPrice: value });
    const dto = await one(input).catch(() => null);
    expect(dto?.settle_commission_fen).toBeNull();
    expect(dto?.est_commission_fen).toBe(123n);
    expect(dto?.paid_fen).toBe(4560n);
  },
);

it.each([
  ['非数字串', 'abc'],
  ['null', null],
  ['缺字段', undefined],
] as const)(
  '[AC-B1-04zl#3] validCode 18 的 estimateCosPrice 是%s → invalid_dto，不退回 actualCosPrice',
  async (_name, value) => {
    const input = row({
      validCode: num('18'),
      estimateCosPrice: value,
      actualCosPrice: num('44.10'),
    });
    await expect(one(input)).rejects.toMatchObject({ code: 'invalid_dto', platform: 'jd' });
  },
);

it('[AC-B1-04zl#4] validCode 18：estimateCosPrice 为负时 paid_fen 取 0n，不退回 actualCosPrice', async () => {
  const dto = await one(
    row({ validCode: num('18'), estimateCosPrice: num('-3.20'), actualCosPrice: num('44.10') }),
  );
  expect(dto.paid_fen).toBe(0n);
});

it('[AC-B1-04zl#5] validCode 17 的 actualFee 真为 0.0：est、commission 都是 0n，settle 仍是 null', async () => {
  const dto = await one(
    row({ validCode: num('17'), estimateFee: num('1.23'), actualFee: num('0.0') }),
  );
  expect(dto.est_commission_fen).toBe(0n);
  expect(dto.commission_fen).toBe(0n);
  expect(dto.settle_commission_fen).toBeNull();
});

it.each(UNREAD_VALUES)(
  '[AC-B1-04zl#6] validCode 17：不读的 estimateFee、estimateCosPrice 是%s时照常映射',
  async (_name, value) => {
    const input = row({
      validCode: num('17'),
      estimateFee: value,
      estimateCosPrice: value,
      actualFee: num('7.89'),
      actualCosPrice: num('44.10'),
    });
    const dto = await one(input).catch(() => null);
    expect(dto?.est_commission_fen).toBe(789n);
    expect(dto?.commission_fen).toBe(789n);
    expect(dto?.paid_fen).toBe(4410n);
  },
);

it('[AC-B1-04zl#7] validCode 17 的任意正负 actualFee：est 取原值，commission = max(0, est)，estimateFee 不参与', () => {
  expect(() =>
    fc.assert(
      fc.property(signedYuan, signedYuan, (estimate, actual) => {
        const dto = mapped({
          validCode: num('17'),
          estimateFee: num(estimate.text),
          actualFee: num(actual.text),
          actualCosPrice: num('44.10'),
        });
        return (
          dto.est_commission_fen === actual.fen &&
          dto.commission_fen === (actual.fen < 0n ? 0n : actual.fen) &&
          dto.settle_commission_fen === null
        );
      }),
      propParams(),
    ),
  ).not.toThrow();
});

it('[AC-B1-04zl#8] 17 以外的任意 validCode：est 取 estimateFee 原值，commission = max(0, est)，actualFee 不参与', () => {
  // 18 单独加权：17 以外只有它的新旧行为不同。
  const code = fc.oneof(
    fc.constant(18),
    fc.integer({ min: -1, max: 99 }).filter((value) => value !== 17),
  );
  expect(() =>
    fc.assert(
      fc.property(code, signedYuan, signedYuan, (validCode, estimate, actual) => {
        const dto = mapped({
          validCode: num(String(validCode)),
          estimateFee: num(estimate.text),
          actualFee: num(actual.text),
        });
        return (
          dto.est_commission_fen === estimate.fen &&
          dto.commission_fen === (estimate.fen < 0n ? 0n : estimate.fen) &&
          dto.settle_commission_fen === null &&
          dto.paid_fen === 4560n
        );
      }),
      propParams(),
    ),
  ).not.toThrow();
});
