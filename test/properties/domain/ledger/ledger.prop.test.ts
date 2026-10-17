import { isDeepStrictEqual } from 'node:util';
import { applyEntries, uniqKey, validateVoucher, type LedgerEntry } from '@couli/domain';
import { createPropStats, propParams, type PropStats } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { platformEntry, userEntry } from '../../../spec/domain/ledger/fixtures.ts';

// Independent bigint oracles deliberately do not call the implementation's money helpers.
// Bound arrays so every generated subtotal/result stays within signed PG bigint.
const positiveFen = fc.oneof(
  fc.constantFrom(1n, 3n, 617n, 2147483649n, 9007199254740993n),
  fc.bigInt({ min: 1n, max: 10000000000000000n }),
);

// Count observed magnitudes in disjoint buckets; zero comes from balances/net results,
// never from a voucher entry. Small even amounts are outside these four target buckets.
function recordAmounts(stats: PropStats, amounts: readonly bigint[]): void {
  for (const amount of amounts) {
    const magnitude = amount < 0n ? -amount : amount;
    if (magnitude === 0n) stats.hit('zero');
    else if (magnitude === 1n) stats.hit('one');
    else if (magnitude > 2147483648n) stats.hit('gt_2_31');
    else if (magnitude % 2n === 1n) stats.hit('odd');
  }
}

function checkProperty<T>(
  name: string,
  arbitrary: fc.Arbitrary<T>,
  predicate: (value: T, stats: PropStats) => boolean,
): boolean {
  const stats = createPropStats(`domain:ledger:${name}`);
  try {
    fc.assert(
      fc.property(arbitrary, (value) => {
        stats.hit('generated');
        return predicate(value, stats);
      }),
      propParams(),
    );
    return true;
  } finally {
    stats.flush();
  }
}

const vouchers = fc.array(positiveFen, { minLength: 1, maxLength: 12 }).chain((amounts) => {
  const total = amounts.reduce((sum, amount) => sum + amount, 0n);
  const entries = [
    platformEntry(total),
    ...amounts.map((amount, index) => userEntry(-amount, 'available', `user-${index}`)),
  ];
  return fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length });
});

it('[AC-B2-01h#28] BR-FUND-16：任意合法多分录凭证Σ=0且通过；破坏一分必拒绝', () => {
  expect(
    checkProperty('balanced-vouchers', vouchers, (entries, stats) => {
      const before = structuredClone(entries);
      const sum = entries.reduce((total, entry) => total + entry.amount_fen, 0n);
      recordAmounts(stats, [...entries.map((entry) => entry.amount_fen), sum]);
      const accepted = validateVoucher(entries);
      // Increase a positive debit, ensuring corruption does not produce a zero entry.
      const corrupted = entries.map((entry) =>
        entry.amount_fen > 0n ? { ...entry, amount_fen: entry.amount_fen + 1n } : entry,
      );
      const rejected = validateVoucher(corrupted);
      return (
        sum === 0n &&
        accepted.ok &&
        !rejected.ok &&
        rejected.errors.some((error) => error.code === 'UNBALANCED') &&
        isDeepStrictEqual(entries, before)
      );
    }),
  ).toBe(true);
}, 120_000);

const signedEntry = fc
  .tuple(positiveFen, fc.boolean(), fc.constantFrom('available' as const, 'frozen' as const))
  .map(([amount, debit, sub]) => userEntry(debit ? amount : -amount, sub));

it('[AC-B2-01h#29] BR-FUND-16：任意分批与一次推导结果相同，分别符合两子户独立净额', () => {
  expect(
    checkProperty(
      'batch-equivalence',
      fc.tuple(fc.array(signedEntry, { minLength: 1, maxLength: 12 }), fc.nat()),
      ([entries, seed], stats) => {
        // Prefund all debits so every split is legal, not just the final net balance.
        const available = entries.reduce(
          (sum, entry) =>
            sum +
            (entry.sub_account === 'available' && entry.amount_fen > 0n ? entry.amount_fen : 0n),
          0n,
        );
        const frozen = entries.reduce(
          (sum, entry) =>
            sum + (entry.sub_account === 'frozen' && entry.amount_fen > 0n ? entry.amount_fen : 0n),
          0n,
        );
        const balance = { account_id: 'user-42', available_fen: available, frozen_fen: frozen };
        recordAmounts(stats, [...entries.map((entry) => entry.amount_fen), available, frozen]);
        const split = seed % (entries.length + 1);
        const once = applyEntries(balance, entries);
        const batches = applyEntries(
          applyEntries(balance, entries.slice(0, split)),
          entries.slice(split),
        );
        const individually = entries.reduce(
          (current, entry) => applyEntries(current, [entry]),
          balance,
        );
        const expected = {
          ...balance,
          available_fen:
            available -
            entries.reduce(
              (sum, entry) => sum + (entry.sub_account === 'available' ? entry.amount_fen : 0n),
              0n,
            ),
          frozen_fen:
            frozen -
            entries.reduce(
              (sum, entry) => sum + (entry.sub_account === 'frozen' ? entry.amount_fen : 0n),
              0n,
            ),
        };
        return (
          isDeepStrictEqual(once, expected) &&
          isDeepStrictEqual(batches, expected) &&
          isDeepStrictEqual(individually, expected)
        );
      },
    ),
  ).toBe(true);
}, 120_000);

it('[AC-B2-01h#30] BR-FUND-10：任意冻结扣减，成功结果恒非负；越界必须拒绝', () => {
  const cases = fc.tuple(positiveFen, fc.constantFrom(-1n, 0n, 1n), fc.boolean());
  expect(
    checkProperty('frozen-floor', cases, ([frozen, offset, credit], stats) => {
      // Include exact zero and a one-fen overdraft, as well as credits to frozen.
      const debit = frozen + offset;
      const amount = credit ? -frozen : debit;
      const balance = { account_id: 'user-42', available_fen: 0n, frozen_fen: frozen };
      const before = { ...balance };
      const entries = amount === 0n ? [] : [userEntry(amount, 'frozen')];
      const expected = frozen - amount;
      recordAmounts(stats, [
        frozen,
        balance.available_fen,
        expected,
        ...entries.map((entry) => entry.amount_fen),
      ]);
      try {
        const result = applyEntries(balance, entries);
        return (
          expected >= 0n &&
          result.frozen_fen === expected &&
          result.available_fen === 0n &&
          isDeepStrictEqual(balance, before)
        );
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return expected < 0n && isDeepStrictEqual(balance, before);
      }
    }),
  ).toBe(true);
}, 120_000);

it('[AC-B2-01h#31] BR-FUND-16：原凭证与REVERSE逐科目/子户净额为零，余额恢复', () => {
  expect(
    checkProperty(
      'reverse-cancels',
      fc.tuple(positiveFen, positiveFen),
      ([credit, freeze], stats) => {
        const original: readonly LedgerEntry[] = [
          platformEntry(credit),
          userEntry(-credit),
          userEntry(freeze),
          userEntry(-freeze, 'frozen'),
        ];
        const reverse = original.map((entry) => ({ ...entry, amount_fen: -entry.amount_fen }));
        const combined = [...original, ...reverse];
        const net = new Map<string, bigint>();
        for (const entry of combined) {
          const key = `${entry.account_id}/${entry.sub_account ?? 'platform'}`;
          net.set(key, (net.get(key) ?? 0n) + entry.amount_fen);
        }
        const initial = { account_id: 'user-42', available_fen: freeze, frozen_fen: 0n };
        recordAmounts(stats, [credit, freeze, initial.frozen_fen]);
        const originalKey = 'taobao:123:42:self:CREDIT';
        return (
          uniqKey({ kind: 'REVERSE', original_uniq_key: originalKey }) ===
            `${originalKey}:REVERSE` &&
          validateVoucher(original).ok &&
          validateVoucher(reverse).ok &&
          [...net.values()].every((value) => value === 0n) &&
          isDeepStrictEqual(applyEntries(applyEntries(initial, original), reverse), initial) &&
          isDeepStrictEqual(applyEntries(initial, combined), initial)
        );
      },
    ),
  ).toBe(true);
}, 120_000);
