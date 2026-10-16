// 编排补充 §9.1：运行时防御使用 money 的错误类；8000 发布门禁不在本函数范围。
import { quoteRebate, splitCommission } from '@couli/domain';
import { InvalidAmount, InvalidRatio } from '@couli/money';
import { expect, it } from 'vitest';
import { example, person } from './fixtures.ts';

const nonBigints: unknown[] = [0, 1.5, NaN, Infinity, '1000', null, undefined, true, {}];
const badRatios: unknown[] = [-1n, 10001n, ...nonBigints];

it.each(nonBigints)('[AC-B2-03a#11] split拒绝非bigint原佣金：%s', (value) => {
  expect(() => splitCommission(example({ n_base_fen: value as bigint }))).toThrow(InvalidAmount);
});

it.each([-1n, ...nonBigints])('[AC-B2-03a#12] split拒绝负数或非bigint淘礼金扣除：%s', (value) => {
  expect(() => splitCommission(example({ tlj_deduct_fen: value as bigint }))).toThrow(
    InvalidAmount,
  );
});

it.each(badRatios)('[AC-B2-03a#13] split拒绝越界或非bigint预留比例：%s', (value) => {
  expect(() => splitCommission(example({ reserve_bp: value as bigint }))).toThrow(InvalidRatio);
});

it.each(
  (['owner', 'direct', 'indirect'] as const).flatMap((role) =>
    badRatios.map((value) => ({ role, value })),
  ),
)('[AC-B2-03a#14] $role非法比例$value不得截断或放过', ({ role, value }) => {
  expect(() => splitCommission(example({ [role]: person(role, value as bigint) }))).toThrow(
    InvalidRatio,
  );
});

it.each(['active', 'forfeited'] as const)(
  '[AC-B2-03a#15] 基数零且状态%s也必须校验非法比例，不能提前返回零绕过',
  (status) => {
    expect(() =>
      splitCommission(example({ n_base_fen: 0n, owner: person('owner', -1n, status) })),
    ).toThrow(InvalidRatio);
    expect(() => splitCommission(example({ n_base_fen: -1n, reserve_bp: 10001n }))).toThrow(
      InvalidRatio,
    );
    expect(() =>
      splitCommission(
        example({ indirect_enabled: false, indirect: person('grandparent', -1n, status) }),
      ),
    ).toThrow(InvalidRatio);
  },
);

it('[AC-B2-03a#16] 总比例超过10000抛InvalidRatio；各单项合法也不能超分', () => {
  expect(() =>
    splitCommission(
      example({
        owner: person('owner', 7000n),
        direct: person('parent', 2500n),
        indirect: person('grandparent', 501n),
      }),
    ),
  ).toThrow(InvalidRatio);
});

it.each([-1n, ...nonBigints])('[AC-B2-03a#17] quote拒绝负数或非bigint收入：%s', (value) => {
  expect(() =>
    quoteRebate({ n_quote_fen: value as bigint, reserve_bp: 0n, r_own_bp: 5000n }),
  ).toThrow(InvalidAmount);
});

it.each(badRatios)('[AC-B2-03a#18] quote拒绝非法预留或本人比例：%s', (value) => {
  expect(() =>
    quoteRebate({ n_quote_fen: 1000n, reserve_bp: value as bigint, r_own_bp: 5000n }),
  ).toThrow(InvalidRatio);
  expect(() =>
    quoteRebate({ n_quote_fen: 1000n, reserve_bp: 0n, r_own_bp: value as bigint }),
  ).toThrow(InvalidRatio);
});

it('[AC-B2-03a#19] 运算边界0与10000有效；发布端的8000校验不在这里重复实现', () => {
  expect(quoteRebate({ n_quote_fen: 1n, reserve_bp: 0n, r_own_bp: 10000n })).toBe(1n);
  expect(quoteRebate({ n_quote_fen: 1n, reserve_bp: 10000n, r_own_bp: 10000n })).toBe(0n);
  expect(quoteRebate({ n_quote_fen: 1000n, reserve_bp: 0n, r_own_bp: 0n })).toBe(0n);
  const result = splitCommission(
    example({
      n_base_fen: 10000n,
      owner: person('owner', 5000n),
      direct: person('parent', 3000n),
      indirect: person('grandparent', 2000n),
    }),
  );
  expect(result.shares.map((share) => share.amount_fen)).toEqual([5000n, 3000n, 2000n]);
  expect(result.platform_retain_fen).toBe(0n);
});
