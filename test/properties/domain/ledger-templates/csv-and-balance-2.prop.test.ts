import { expect, it } from 'vitest';
import { checkCsvAndBalance, csvAndBalanceTimeout } from './csv-and-balance.ts';

it(
  '[AC-B2-01j#20] 第 2/6 片：片内每个模板按 CSV 精确出分录且 Σ=0，零不出凭证，输入不变（每个模板跑满 PROP_RUNS）',
  () => {
    expect(checkCsvAndBalance(1)).toBe(true);
  },
  csvAndBalanceTimeout(1),
);
