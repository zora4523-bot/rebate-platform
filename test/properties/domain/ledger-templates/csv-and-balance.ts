import { isDeepStrictEqual } from 'node:util';
import { buildVouchers } from '@couli/domain';
import { createPropStats, propParams, propRuns, type PropStats } from '@couli/testing';
import fc from 'fast-check';
import { expect } from 'vitest';
import {
  csvGroups,
  executableTemplates,
  parameters,
  validVouchers,
  voucherGroups,
} from '../../../spec/domain/ledger-templates/fixtures.ts';

export const CSV_AND_BALANCE_SHARDS = [
  [
    'ADJ:DEFERRED:PRICE_COMPARE',
    'ADJ:DEFERRED:PRICE_PROTECT',
    'ADJ:DEFERRED:RESTORE',
    'ADJ:DEFERRED:SETTLE_DIFF',
    'ADMIN_ADJUST:ACCOUNT_CLOSED',
    'ADMIN_ADJUST:ACCOUNT_CLOSED:REVERSE',
    'ADMIN_ADJUST:OTHER:BAD_DEBT:DECREASE',
    'ADMIN_ADJUST:OTHER:BAD_DEBT:DECREASE:REVERSE',
    'ADMIN_ADJUST:OTHER:BAD_DEBT:INCREASE',
    'ADMIN_ADJUST:OTHER:BAD_DEBT:INCREASE:REVERSE',
    'ADMIN_ADJUST:OTHER:COMMISSION_REVENUE:DECREASE',
    'ADMIN_ADJUST:OTHER:COMMISSION_REVENUE:DECREASE:REVERSE',
    'ADMIN_ADJUST:OTHER:COMMISSION_REVENUE:INCREASE',
    'ADMIN_ADJUST:OTHER:COMMISSION_REVENUE:INCREASE:REVERSE',
    'ADMIN_ADJUST:OTHER:MKT_EXPENSE:DECREASE',
    'ADMIN_ADJUST:OTHER:MKT_EXPENSE:DECREASE:REVERSE',
    'ADMIN_ADJUST:OTHER:MKT_EXPENSE:INCREASE',
    'ADMIN_ADJUST:OTHER:MKT_EXPENSE:INCREASE:REVERSE',
    'ADMIN_ADJUST:OTHER:UNION_RECEIVABLE:DECREASE',
    'ADMIN_ADJUST:OTHER:UNION_RECEIVABLE:DECREASE:REVERSE',
    'ADMIN_ADJUST:OTHER:UNION_RECEIVABLE:INCREASE',
    'ADMIN_ADJUST:OTHER:UNION_RECEIVABLE:INCREASE:REVERSE',
    'ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_ALIPAY:DECREASE',
    'ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_ALIPAY:DECREASE:REVERSE',
    'ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_ALIPAY:INCREASE',
    'ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_ALIPAY:INCREASE:REVERSE',
    'ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_BANK:DECREASE',
    'ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_BANK:DECREASE:REVERSE',
    'ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_BANK:INCREASE',
    'ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_BANK:INCREASE:REVERSE',
    'ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_WECHAT:DECREASE',
    'ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_WECHAT:DECREASE:REVERSE',
    'ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_WECHAT:INCREASE',
    'ADMIN_ADJUST:PAYOUT_RECOVERY:CASH_WECHAT:INCREASE:REVERSE',
  ],
  [
    'ADMIN_ADJUST:RECON_FIX:BAD_DEBT:DECREASE',
    'ADMIN_ADJUST:RECON_FIX:BAD_DEBT:DECREASE:REVERSE',
    'ADMIN_ADJUST:RECON_FIX:BAD_DEBT:INCREASE',
    'ADMIN_ADJUST:RECON_FIX:BAD_DEBT:INCREASE:REVERSE',
    'ADMIN_ADJUST:RECON_FIX:COMMISSION_REVENUE:DECREASE',
    'ADMIN_ADJUST:RECON_FIX:COMMISSION_REVENUE:DECREASE:REVERSE',
    'ADMIN_ADJUST:RECON_FIX:COMMISSION_REVENUE:INCREASE',
    'ADMIN_ADJUST:RECON_FIX:COMMISSION_REVENUE:INCREASE:REVERSE',
    'ADMIN_ADJUST:RECON_FIX:MKT_EXPENSE:DECREASE',
    'ADMIN_ADJUST:RECON_FIX:MKT_EXPENSE:DECREASE:REVERSE',
    'ADMIN_ADJUST:RECON_FIX:MKT_EXPENSE:INCREASE',
    'ADMIN_ADJUST:RECON_FIX:MKT_EXPENSE:INCREASE:REVERSE',
    'ADMIN_ADJUST:RECON_FIX:UNION_RECEIVABLE:DECREASE',
    'ADMIN_ADJUST:RECON_FIX:UNION_RECEIVABLE:DECREASE:REVERSE',
    'ADMIN_ADJUST:RECON_FIX:UNION_RECEIVABLE:INCREASE',
    'ADMIN_ADJUST:RECON_FIX:UNION_RECEIVABLE:INCREASE:REVERSE',
    'ADMIN_ADJUST:RESTORE:APPEAL',
    'ADMIN_ADJUST:RESTORE:PLATFORM',
    'ADMIN_ADJUST:RESTORE:USER',
    'BAD_DEBT_WRITEOFF',
    'CLAWBACK:FULL:BAD_DEBT',
    'CLAWBACK:FULL:PLATFORM:DECREASE',
    'CLAWBACK:FULL:PLATFORM:INCREASE',
    'CLAWBACK:FULL:USER',
    'CLAWBACK:PART_REFUND:BAD_DEBT',
    'CLAWBACK:PART_REFUND:PLATFORM:DECREASE',
    'CLAWBACK:PART_REFUND:PLATFORM:INCREASE',
    'CLAWBACK:PART_REFUND:USER',
    'CLAWBACK:PUNISH:BAD_DEBT',
  ],
  [
    'CLAWBACK:PUNISH:PLATFORM:DECREASE',
    'CLAWBACK:PUNISH:PLATFORM:INCREASE',
    'CLAWBACK:PUNISH:USER',
    'CLAWBACK:RIGHTS:BAD_DEBT',
    'CLAWBACK:RIGHTS:PLATFORM:DECREASE',
    'CLAWBACK:RIGHTS:PLATFORM:INCREASE',
    'CLAWBACK:RIGHTS:USER',
    'CREDIT:DIRECT',
    'CREDIT:INDIRECT',
    'CREDIT:PLATFORM',
    'CREDIT:SELF',
    'CREDIT:SHARE',
    'FORFEIT',
    'FORFEIT:DEFERRED',
    'FORFEIT:REASSIGN',
    'REASSIGN_CREDIT:DIRECT',
    'REASSIGN_CREDIT:INDIRECT',
  ],
  [
    'REASSIGN_CREDIT:PLATFORM',
    'REASSIGN_CREDIT:SELF',
    'REASSIGN_CREDIT:SHARE',
    'SETTLE_ADJUST:PRICE_COMPARE:BAD_DEBT',
    'SETTLE_ADJUST:PRICE_COMPARE:PLATFORM:DECREASE',
    'SETTLE_ADJUST:PRICE_COMPARE:PLATFORM:INCREASE',
    'SETTLE_ADJUST:PRICE_COMPARE:USER:DECREASE',
    'SETTLE_ADJUST:PRICE_COMPARE:USER:INCREASE',
    'SETTLE_ADJUST:PRICE_PROTECT:BAD_DEBT',
    'SETTLE_ADJUST:PRICE_PROTECT:PLATFORM:DECREASE',
    'SETTLE_ADJUST:PRICE_PROTECT:PLATFORM:INCREASE',
    'SETTLE_ADJUST:PRICE_PROTECT:USER:DECREASE',
    'SETTLE_ADJUST:PRICE_PROTECT:USER:INCREASE',
    'SETTLE_ADJUST:SETTLE_DIFF:BAD_DEBT',
    'SETTLE_ADJUST:SETTLE_DIFF:PLATFORM:DECREASE',
    'SETTLE_ADJUST:SETTLE_DIFF:PLATFORM:INCREASE',
    'SETTLE_ADJUST:SETTLE_DIFF:USER:DECREASE',
    'SETTLE_ADJUST:SETTLE_DIFF:USER:INCREASE',
    'UNION_RECEIPT:CASH_ALIPAY',
    'UNION_RECEIPT:CASH_BANK',
    'WITHDRAW:FREEZE',
    'WITHDRAW:RETURN',
    'WITHDRAW:SUCCESS:CASH_ALIPAY',
    'WITHDRAW:SUCCESS:CASH_BANK',
    'WITHDRAW:SUCCESS:CASH_WECHAT',
  ],
  ['REASSIGN_REV:USER'],
  ['REASSIGN_REV:PLATFORM'],
] as const;

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

export function checkCsvAndBalance(shard: number): boolean {
  const ids = CSV_AND_BALANCE_SHARDS[shard]!;
  const executable = executableTemplates();
  const selected = executable.filter(([id]) => ids.some((expectedId) => expectedId === id));
  expect(selected.map(([id]) => id)).toEqual(ids);
  const templates = selected.map(([id, rows]) => ({
    id,
    rows,
    amountRefs: [...new Set(rows.map((row) => row.amount_ref))],
    amountCount: new Set(rows.map((row) => row.amount_ref)).size,
    skeleton: parameters(rows, 0n),
  }));
  return checkProperty(
    `csv-and-balance:${shard + 1}`,
    fc.tuple(fen, fc.uuid(), fc.uuid()),
    ([amount, userId, withdrawalId], stats) => {
      recordAmount(stats, amount);
      return templates.every(({ id, rows, amountRefs, amountCount, skeleton }) => {
        stats.hit(id);
        const boundedAmount = amount / BigInt(amountCount);
        // executableTemplates has no TBD: parameters writes amount_ref on every row.
        // Replacing existing keys preserves insertion order, so this has the same keys,
        // key order and values as { ...parameters(rows, boundedAmount) } each round.
        const values = { ...skeleton };
        for (const amountRef of amountRefs) values[amountRef] = boundedAmount;
        if (Object.hasOwn(values, 'user_id')) values['user_id'] = userId;
        if (Object.hasOwn(values, 'withdrawal_id')) values['withdrawal_id'] = withdrawalId;
        const params = Object.freeze(values);
        const before = structuredClone(params);
        const vouchers = buildVouchers(id, params);
        return (
          vouchers.length === (boundedAmount === 0n ? 0 : 1) &&
          isDeepStrictEqual(voucherGroups(vouchers), csvGroups(rows, params)) &&
          validVouchers(vouchers) &&
          isDeepStrictEqual(params, before)
        );
      });
    },
  );
}

// CI (ubuntu-latest): original #20 took 516 s / 100000 runs = 5.16 ms/run.
// Multiply by locally profiled per-template shard shares, using their upper bounds.
const MS_PER_RUN = [1.05, 1.05, 1.05, 1.05, 0.95, 0.7] as const;

export function csvAndBalanceTimeout(shard: number): number {
  return Math.max(120_000, Math.ceil(propRuns() * MS_PER_RUN[shard]! * 1.5));
}
