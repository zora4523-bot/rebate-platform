import { isDeepStrictEqual } from 'node:util';
import { quoteRebate, splitCommission } from '@couli/domain';
import type { SplitCommissionInput } from '@couli/domain';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { freezeInput, person } from '../../../spec/domain/commission/fixtures.ts';
import { splitReference } from '../../../spec/reference/split.ref.ts';
import {
  amountFen,
  checkProperty,
  commissionInput,
  FULL_COVERAGE,
  ratioBp,
} from './arbitraries.ts';

const amountOf = (input: SplitCommissionInput): bigint => input.n_base_fen;
const positive = (n: bigint): bigint => (n > 0n ? n : 0n);

it('[AC-B2-03a#20] BR-CALC-02/04/08：非负、逐份floor、留存与预留和淘礼金守恒', () => {
  expect(
    checkProperty('conservation', commissionInput, amountOf, (input) => {
      const result = splitCommission(input);
      const n = positive(input.n_base_fen);
      const afterReserve = (n * (10000n - input.reserve_bp)) / 10000n;
      const usedTlj = input.tlj_deduct_fen < afterReserve ? input.tlj_deduct_fen : afterReserve;
      const sum = result.shares.reduce((total, share) => total + share.amount_fen, 0n);
      return (
        result.reserve_fen === n - afterReserve &&
        result.base_fen === afterReserve - usedTlj &&
        result.base_fen >= 0n &&
        result.reserve_fen >= 0n &&
        result.shares.every(
          (share) => typeof share.amount_fen === 'bigint' && share.amount_fen >= 0n,
        ) &&
        result.shares.every((share) => {
          const beneficiary =
            share.role === 'self' || share.role === 'share' ? input.owner : input[share.role];
          if (beneficiary == null) return false;
          if (beneficiary.status === 'forfeited') return share.amount_fen === 0n;
          const scaled = result.base_fen * beneficiary.ratio_bp;
          return share.amount_fen * 10000n <= scaled && scaled < (share.amount_fen + 1n) * 10000n;
        }) &&
        sum <= result.base_fen &&
        result.platform_retain_fen === result.base_fen - sum &&
        result.platform_retain_fen >= 0n &&
        result.base_fen + result.reserve_fen + usedTlj === n &&
        (result.base_fen === 0n ||
          sum + result.platform_retain_fen + result.reserve_fen + input.tlj_deduct_fen === n)
      );
    }),
  ).toEqual(FULL_COVERAGE);
});

it('[AC-B2-03a#21] BR-CALC-02/04/05/08/13/24：与独立bigint参考实现逐分且逐受益人一致', () => {
  expect(
    checkProperty('reference-diff', commissionInput, amountOf, (input) =>
      isDeepStrictEqual(splitCommission(input), splitReference(input)),
    ),
  ).toEqual(FULL_COVERAGE);
});

it('[AC-B2-03a#22] 纯函数：相同输入结果相同，冻结输入仍可计算且不受上次调用影响', () => {
  expect(
    checkProperty('determinism', commissionInput, amountOf, (input) => {
      const snapshot = structuredClone(input);
      const first = splitCommission(freezeInput(input));
      splitCommission({ ...input, n_base_fen: 0n, indirect_enabled: !input.indirect_enabled });
      const second = splitCommission(input);
      return isDeepStrictEqual(first, second) && isDeepStrictEqual(input, snapshot);
    }),
  ).toEqual(FULL_COVERAGE);
});

it('[AC-B2-03a#23] BR-CALC-05：关闭间推不输出该受益人，开启时也最多两层', () => {
  expect(
    checkProperty('depth-and-toggle', commissionInput, amountOf, (input) => {
      const result = splitCommission(input);
      const disabled = splitCommission({ ...input, indirect_enabled: false });
      const indirectAllowed =
        input.indirect_enabled &&
        input.direct != null &&
        input.indirect != null &&
        input.indirect.user_id !== input.owner.user_id &&
        input.indirect.user_id !== input.direct.user_id;
      const roles = [
        input.order_type,
        ...(input.direct == null ? [] : ['direct']),
        ...(indirectAllowed ? ['indirect'] : []),
      ];
      const expectedWarning =
        input.indirect_enabled &&
        input.direct != null &&
        input.indirect != null &&
        !indirectAllowed;
      return (
        result.shares.length <= 3 &&
        new Set(result.shares.map((share) => share.role)).size === result.shares.length &&
        isDeepStrictEqual(
          result.shares.map((share) => share.role),
          roles,
        ) &&
        isDeepStrictEqual(result.warnings, expectedWarning ? ['INDIRECT_SAME_PERSON'] : []) &&
        disabled.shares.every((share) => share.role !== 'indirect') &&
        disabled.warnings.length === 0
      );
    }),
  ).toEqual(FULL_COVERAGE);
});

it('[AC-B2-03a#24] BR-CALC-02：reserve_bp=0时B等于不扣预留且不会出现负数', () => {
  expect(
    checkProperty('zero-reserve', commissionInput, amountOf, (input) => {
      const result = splitCommission({ ...input, reserve_bp: 0n });
      return (
        result.reserve_fen === 0n &&
        result.base_fen === positive(positive(input.n_base_fen) - input.tlj_deduct_fen)
      );
    }),
  ).toEqual(FULL_COVERAGE);
});

it('[AC-B2-03a#25] BR-CALC-13：任一角色forfeited恒零，其原份额只增平台留存，不转给其他角色', () => {
  expect(
    checkProperty('forfeited-isolation', commissionInput, amountOf, (input) => {
      const active: SplitCommissionInput = {
        ...input,
        indirect_enabled: true,
        owner: person('owner', input.owner.ratio_bp),
        direct: person('parent', input.direct?.ratio_bp ?? 0n),
        indirect: person('grandparent', input.indirect?.ratio_bp ?? 0n),
      };
      const before = splitCommission(active);
      return (['owner', 'direct', 'indirect'] as const).every((key) => {
        const beneficiary = active[key];
        if (beneficiary == null) return false;
        const result = splitCommission({
          ...active,
          [key]: { ...beneficiary, status: 'forfeited' },
        });
        const role = key === 'owner' ? input.order_type : key;
        const removed = before.shares.find((share) => share.role === role);
        return (
          removed !== undefined &&
          result.shares.length === before.shares.length &&
          result.shares.every((share, index) =>
            isDeepStrictEqual(
              share,
              share.role === role ? { ...removed, amount_fen: 0n } : before.shares[index],
            ),
          ) &&
          result.platform_retain_fen === before.platform_retain_fen + removed.amount_fen &&
          result.reserve_fen === before.reserve_fen
        );
      });
    }),
  ).toEqual(FULL_COVERAGE);
});

it('[AC-B2-03a#26] BR-CALC-20：报价扣预留后与同输入self或share本人份额逐分一致', () => {
  const quoteInput = fc.record({
    n: amountFen,
    reserve: ratioBp,
    own: fc.bigInt({ min: 0n, max: 8000n }),
  });
  expect(
    checkProperty(
      'quote-equality',
      quoteInput,
      (input) => input.n,
      ({ n, reserve, own }) => {
        const quote = quoteRebate(
          Object.freeze({ n_quote_fen: n, reserve_bp: reserve, r_own_bp: own }),
        );
        const base = (n * (10000n - reserve)) / 10000n;
        return (
          quote === (base * own) / 10000n &&
          (['self', 'share'] as const).every((order_type) => {
            const result = splitCommission({
              n_base_fen: n,
              reserve_bp: reserve,
              tlj_deduct_fen: 0n,
              order_type,
              indirect_enabled: false,
              owner: person('viewer', own),
            });
            return quote === result.shares.find((share) => share.role === order_type)?.amount_fen;
          })
        );
      },
    ),
  ).toEqual(FULL_COVERAGE);
});

it('[AC-B2-03a#27] BR-CALC-08/13：基数多次重算仍按最终B逐份floor，forfeited不恢复', () => {
  const sequence = fc.tuple(commissionInput, fc.array(amountFen, { minLength: 2, maxLength: 8 }));
  expect(
    checkProperty(
      'recalculation',
      sequence,
      ([input]) => input.n_base_fen,
      ([input, amounts]) => {
        let previous = splitCommission(input);
        const net = previous.shares.map((share) => share.amount_fen);
        for (const n of amounts) {
          const next = splitCommission({ ...input, n_base_fen: n });
          if (next.shares.length !== previous.shares.length) return false;
          for (const [index, share] of next.shares.entries()) {
            const old = previous.shares[index];
            const accumulated = net[index];
            if (old === undefined || accumulated === undefined) return false;
            net[index] = accumulated + share.amount_fen - old.amount_fen;
          }
          previous = next;
        }
        const finalN = amounts.at(-1);
        if (finalN === undefined) return false;
        const reference = splitReference({ ...input, n_base_fen: finalN });
        return (
          isDeepStrictEqual(previous, reference) &&
          isDeepStrictEqual(
            net,
            reference.shares.map((share) => share.amount_fen),
          )
        );
      },
    ),
  ).toEqual(FULL_COVERAGE);
});
