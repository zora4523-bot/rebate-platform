import { isDeepStrictEqual } from 'node:util';
import { buildVouchers } from '@couli/domain';
import { createPropStats, propParams, type PropStats } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  csvGroups,
  executableTemplates,
  isTbd,
  parameters,
  readTemplates,
  rejectsRangeError,
  reversedGroups,
  validVouchers,
  voucherGroups,
} from '../../../spec/domain/ledger-templates/fixtures.ts';

// Include zero, odd/tail fen, values beyond JS safe integers and the PG int64 boundary.
// Independent native bigint oracles intentionally do not share @couli/money internals.
const fen = fc.oneof(
  fc.constantFrom(0n, 1n, 617n, 2147483649n, 9007199254740993n, 9223372036854775807n),
  fc.bigInt({ min: 0n, max: 9223372036854775807n }),
);

function checkProperty<T>(
  name: string,
  arbitrary: fc.Arbitrary<T>,
  predicate: (value: T, stats: PropStats) => boolean,
): boolean {
  const stats = createPropStats(`domain:ledger-templates:${name}`);
  try {
    fc.assert(
      fc.property(arbitrary, (value) => predicate(value, stats)),
      propParams(),
    );
    return true;
  } finally {
    stats.flush();
  }
}

function recordAmount(stats: PropStats, amount: bigint): void {
  stats.hit('generated');
  if (amount === 0n) stats.hit('zero');
  if (amount === 1n) stats.hit('one');
  if (amount % 2n === 1n) stats.hit('odd');
  if (amount > 2147483648n) stats.hit('gt_2_31');
  if (amount > 9007199254740991n) stats.hit('gt_safe_integer');
  if (amount === 9223372036854775807n) stats.hit('int64_max');
}

it('[AC-B2-01j#20] 任意非负金额按 CSV 精确出分录且 Σ=0，零不出凭证，输入不变', async () => {
  const templates = executableTemplates();
  expect(templates.map(([id]) => id)).toEqual(
    expect.arrayContaining(['CREDIT:SELF', 'CREDIT:PLATFORM', 'WITHDRAW:SUCCESS:CASH_WECHAT']),
  );
  const { CSV_AND_BALANCE_SHARDS } = await import('./csv-and-balance.ts');
  expect(CSV_AND_BALANCE_SHARDS).toHaveLength(6);
  for (const shard of CSV_AND_BALANCE_SHARDS) expect(shard.length).toBeGreaterThan(0);
  const ids = CSV_AND_BALANCE_SHARDS.flat();
  expect(ids).toHaveLength(107);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual(templates.map(([id]) => id).sort());
}, 120_000);

it('[AC-B2-01j#21] 任意非负金额：红冲与原单逐科目抵消；未定红冲及原模板必须拒绝', () => {
  const templates = readTemplates();
  const pairs = [...templates].filter(([id]) => id.endsWith(':REVERSE'));
  expect(
    checkProperty(
      'reverse-cancellation-or-tbd',
      fc.tuple(fen, fc.nat()),
      ([amount, choice], stats) => {
        recordAmount(stats, amount);
        if (pairs.length === 0) return false;
        const [reverseId, reverseRows] = pairs[choice % pairs.length]!;
        const originalId = reverseId.slice(0, -':REVERSE'.length);
        const originalRows = templates.get(originalId);
        if (originalRows === undefined) return false;
        stats.hit(reverseId);
        const params = Object.freeze(parameters(originalRows, amount));
        if (isTbd(originalRows) || isTbd(reverseRows)) {
          stats.hit('tbd_rejected');
          return (
            rejectsRangeError(() => buildVouchers(originalId, params)) &&
            rejectsRangeError(() => buildVouchers(reverseId, params))
          );
        }
        stats.hit('executable_reverse');
        const original = buildVouchers(originalId, params);
        const reverse = buildVouchers(reverseId, params);
        const net = new Map<string, bigint>();
        for (const voucher of [...original, ...reverse]) {
          for (const entry of voucher.entries) {
            const key = JSON.stringify([
              entry.account,
              entry.sub_account,
              entry.ledger_type,
              entry.sub_type,
            ]);
            net.set(key, (net.get(key) ?? 0n) + entry.amount_fen);
          }
        }
        return (
          original.length === (amount === 0n ? 0 : 1) &&
          reverse.length === original.length &&
          isDeepStrictEqual(voucherGroups(original), csvGroups(originalRows, params)) &&
          isDeepStrictEqual(voucherGroups(reverse), csvGroups(reverseRows, params)) &&
          isDeepStrictEqual(voucherGroups(reverse), reversedGroups(original)) &&
          validVouchers(original) &&
          validVouchers(reverse) &&
          [...net.values()].every((value) => value === 0n)
        );
      },
    ),
  ).toBe(true);
}, 120_000);
