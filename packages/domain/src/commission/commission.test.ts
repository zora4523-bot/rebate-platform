// 单元测试：08 原文算例（BR-CALC-02/04/05/20/24），规则测试在 test/spec 与 test/properties。
import { expect, it } from 'vitest';
import { quoteRebate, splitCommission } from './commission.ts';
import type { SplitCommissionInput } from './commission.ts';

const input = (overrides: Partial<SplitCommissionInput> = {}): SplitCommissionInput => ({
  n_base_fen: 1000n,
  reserve_bp: 1500n,
  tlj_deduct_fen: 0n,
  order_type: 'self',
  indirect_enabled: false,
  owner: { user_id: 'c', ratio_bp: 5000n, status: 'active' },
  direct: { user_id: 'b', ratio_bp: 1000n, status: 'active' },
  indirect: { user_id: 'a', ratio_bp: 500n, status: 'active' },
  ...overrides,
});

it('[AC-B2-03a#1] BR-CALC-04 例 4：N=1000、预留 1500 → 425 / 85 / 留存 340 + 预留 150', () => {
  const result = splitCommission(input());
  expect(result.base_fen).toBe(850n);
  expect(result.reserve_fen).toBe(150n);
  expect(result.shares.map((share) => share.amount_fen)).toEqual([425n, 85n]);
  expect(result.platform_retain_fen).toBe(340n);
});

it('[AC-B2-03a#1] BR-CALC-05：例 4 开启间推 500 → 间推 42、留存 298', () => {
  const result = splitCommission(input({ indirect_enabled: true }));
  expect(result.shares.map((share) => share.amount_fen)).toEqual([425n, 85n, 42n]);
  expect(result.platform_retain_fen).toBe(298n);
});

it('[AC-B2-03a#1] BR-CALC-13：直推 forfeited 只增平台留存，间推照常', () => {
  const result = splitCommission(
    input({
      indirect_enabled: true,
      direct: { user_id: 'b', ratio_bp: 1000n, status: 'forfeited' },
    }),
  );
  expect(result.shares.map((share) => share.amount_fen)).toEqual([425n, 0n, 42n]);
  expect(result.platform_retain_fen).toBe(383n);
});

it('[AC-B2-03a#1] BR-CALC-02：N 为负 → B=0、预留 0，淘礼金超额截到 0', () => {
  expect(splitCommission(input({ n_base_fen: -320n })).base_fen).toBe(0n);
  expect(splitCommission(input({ n_base_fen: -320n })).reserve_fen).toBe(0n);
  expect(splitCommission(input({ tlj_deduct_fen: 900n })).base_fen).toBe(0n);
  expect(splitCommission(input({ tlj_deduct_fen: 50n })).base_fen).toBe(800n);
});

it('[AC-B2-03a#2] BR-CALC-20 例：N_quote=539、预留 1500、本人 5000 → 229', () => {
  expect(quoteRebate({ n_quote_fen: 539n, reserve_bp: 1500n, r_own_bp: 5000n })).toBe(229n);
  expect(quoteRebate({ n_quote_fen: 539n, reserve_bp: 0n, r_own_bp: 5000n })).toBe(269n);
});
