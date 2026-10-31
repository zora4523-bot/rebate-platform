import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { expectRedacted, unionFailure } from '../jd-core/kit.ts';
import { mapped, num, one, row } from './kit.ts';

// D10-520 / BR-CALC-26：元转分取报文数字原文按十进制解析，≤2 位小数精确，>2 位 floor 到分。
// 最要紧的一条：未完成单的 actualFee 是 0.0，绝不能变成 0n（orders 取 coalesce(settle, est)）。
const FINISHED_CODES = ['17', '18'] as const;
/** 没有结算的码：待付款、已付款、已付定金与各类无效码，含文档外的 -1 与未知码。 */
const UNFINISHED_CODES = ['-1', '2', '3', '13', '15', '16', '19', '22', '24', '25', '43', '99'];

const yuanCases = [
  ['9.999', 999n],
  ['0.10', 10n],
  ['12.3', 1230n],
  ['12.30', 1230n],
  ['0.0', 0n],
  ['0', 0n],
  ['5', 500n],
  ['0.009', 0n],
  ['0.019', 1n],
  // 经浮点乘 100 会错一分的值。
  ['1.15', 115n],
  ['4.35', 435n],
  ['0.29', 29n],
  ['8.2', 820n],
  ['2.675', 267n],
  // 分值超 2^53 仍精确。
  ['90071992547409.93', 9007199254740993n],
  ['92233720368547758.07', 9223372036854775807n],
] as const;

it.each(yuanCases)(
  '[AC-B1-04zb#32] 报文数字 %s 元 → %s 分，四个金额字段同一换算',
  async (text, fen) => {
    const value = num(text);
    const finished = await one(
      row({ validCode: num('17'), estimateFee: value, actualFee: value, actualCosPrice: value }),
    );
    expect(finished.est_commission_fen).toBe(fen);
    expect(finished.commission_fen).toBe(fen);
    expect(finished.settle_commission_fen).toBe(fen);
    expect(finished.paid_fen).toBe(fen);
    const open = await one(row({ estimateCosPrice: value }));
    expect(open.paid_fen).toBe(fen);
  },
);

const notAmounts = [
  ['负数', num('-0.01')],
  ['负的多位小数', num('-12.305')],
  ['科学计数法', num('1.5e3')],
  ['超出 int64 的分值', num('92233720368547758.08')],
  ['非数字串', 'abc'],
  ['空串', ''],
  ['布尔', true],
  ['null', null],
  ['对象', { value: num('1.00') }],
  ['缺字段', undefined],
] as const;

it.each(notAmounts)(
  '[AC-B1-04zb#33] estimateFee 是%s → invalid_dto，不按 0 处理',
  async (_name, value) => {
    await expect(one(row({ estimateFee: value }))).rejects.toMatchObject({
      code: 'invalid_dto',
      platform: 'jd',
    });
  },
);

it.each(notAmounts)('[AC-B1-04zb#34] estimateCosPrice 是%s → invalid_dto', async (_name, value) => {
  await expect(one(row({ estimateCosPrice: value }))).rejects.toMatchObject({
    code: 'invalid_dto',
  });
});

it.each(notAmounts)(
  '[AC-B1-04zb#35] 已完成单的 actualFee 是%s → invalid_dto',
  async (_name, value) => {
    await expect(one(row({ validCode: num('17'), actualFee: value }))).rejects.toMatchObject({
      code: 'invalid_dto',
    });
  },
);

it.each(notAmounts)(
  '[AC-B1-04zb#36] 已完成单的 actualCosPrice 是%s → invalid_dto',
  async (_name, value) => {
    await expect(one(row({ validCode: num('18'), actualCosPrice: value }))).rejects.toMatchObject({
      code: 'invalid_dto',
    });
  },
);

it.each(FINISHED_CODES)(
  '[AC-B1-04zb#37] validCode %s：settle = actualFee，退款后真为 0 时是 0n',
  async (code) => {
    const validCode = num(code);
    const settled = await one(row({ validCode, actualFee: num('7.89') }));
    expect(settled.settle_commission_fen).toBe(789n);
    const refunded = await one(row({ validCode, actualFee: num('0.0') }));
    expect(refunded.settle_commission_fen).toBe(0n);
  },
);

it.each(UNFINISHED_CODES)(
  '[AC-B1-04zb#38] validCode %s：settle 一律 null，actualFee 的 0.0 不变成 0n',
  async (code) => {
    const validCode = num(code);
    const zero = await one(row({ validCode, actualFee: num('0.0') }));
    expect(zero.settle_commission_fen).toBeNull();
    const nonZero = await one(row({ validCode, actualFee: num('7.89') }));
    expect(nonZero.settle_commission_fen).toBeNull();
  },
);

it.each(FINISHED_CODES)(
  '[AC-B1-04zb#39] validCode %s：commission 与 est 仍是 estimateFee，不被 actualFee 顶替',
  async (code) => {
    const dto = await one(
      row({ validCode: num(code), estimateFee: num('1.23'), actualFee: num('7.89') }),
    );
    expect(dto.commission_fen).toBe(123n);
    expect(dto.est_commission_fen).toBe(123n);
  },
);

it.each(FINISHED_CODES)(
  '[AC-B1-04zb#40] validCode %s：paid_fen 取 actualCosPrice',
  async (code) => {
    const dto = await one(
      row({ validCode: num(code), estimateCosPrice: num('45.60'), actualCosPrice: num('44.10') }),
    );
    expect(dto.paid_fen).toBe(4410n);
  },
);

it.each(UNFINISHED_CODES)(
  '[AC-B1-04zb#41] validCode %s：paid_fen 取 estimateCosPrice',
  async (code) => {
    const dto = await one(
      row({ validCode: num(code), estimateCosPrice: num('45.60'), actualCosPrice: num('44.10') }),
    );
    expect(dto.paid_fen).toBe(4560n);
  },
);

it('[AC-B1-04zb#42] service_fee_fen 不给，已完成单也一样', async () => {
  const dto = await one(row({ validCode: num('17'), actualFee: num('7.89') }));
  expect(dto.service_fee_fen).toBeUndefined();
});

it('[AC-B1-04zb#43] 金额错误的信息不带报文内容', async () => {
  const marker = 'synthetic-row-marker';
  const error = await unionFailure(
    () => one(row({ estimateFee: marker, skuName: marker, subUnionId: marker })),
    'invalid_dto',
  );
  expectRedacted(error, [marker]);
});

/** A synthetic yuan literal and its fen worked out by hand on bigint, floor past two decimals. */
const yuan = fc
  .tuple(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.stringMatching(/^[0-9]{0,6}$/))
  .map(([whole, tail]) => ({
    text: tail === '' ? `${whole}` : `${whole}.${tail}`,
    fen: whole * 100n + BigInt(tail.slice(0, 2).padEnd(2, '0')),
  }));

it('[AC-B1-04zb#44] 任意元字符串转分与 bigint 手算一致', () => {
  expect(() =>
    fc.assert(
      fc.property(yuan, ({ text, fen }) => {
        const dto = mapped({ estimateFee: num(text) });
        return dto.est_commission_fen === fen && dto.commission_fen === fen;
      }),
      propParams(),
    ),
  ).not.toThrow();
});

it('[AC-B1-04zb#45] 任意 validCode：settle 只在 17 / 18 取 actualFee，paid 按同一分界取价', () => {
  const code = fc.integer({ min: -1, max: 99 });
  expect(() =>
    fc.assert(
      fc.property(code, yuan, yuan, yuan, yuan, (validCode, estimate, actual, estCos, actCos) => {
        const finished = validCode === 17 || validCode === 18;
        const dto = mapped({
          validCode: num(String(validCode)),
          estimateFee: num(estimate.text),
          actualFee: num(actual.text),
          estimateCosPrice: num(estCos.text),
          actualCosPrice: num(actCos.text),
        });
        return (
          dto.raw_status === String(validCode) &&
          dto.est_commission_fen === estimate.fen &&
          dto.commission_fen === estimate.fen &&
          dto.settle_commission_fen === (finished ? actual.fen : null) &&
          dto.paid_fen === (finished ? actCos.fen : estCos.fen)
        );
      }),
      propParams(),
    ),
  ).not.toThrow();
});
