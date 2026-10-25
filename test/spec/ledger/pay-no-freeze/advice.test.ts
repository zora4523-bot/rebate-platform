import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  recommendDailyCheckActions,
  type DailyCheckFinding,
} from '../../../../apps/api/src/modules/ledger/application/daily-check-advice.ts';

// pay- means the file name starts with exactly "pay-" (db/invariants/ledger/pay-*.sql). Other
// spellings are left out of the generator rather than pinned here, except the ones named below.
const payFile = fc.string({ maxLength: 12 }).map((rest) => `pay-${rest}.sql`);
const otherFile = fc.oneof(
  fc.constantFrom(
    '01_balance.sql',
    '02_voucher.sql',
    '01_pay-receipts.sql',
    'payout-holds.sql',
    'pay_receipts.sql',
    'pay.sql',
  ),
  fc.string({ maxLength: 16 }).filter((name) => !name.toLowerCase().startsWith('pay-')),
);
const finding = fc.record({
  file: fc.oneof(payFile, otherFile),
  scope: fc.constantFrom<'account' | 'global'>('account', 'global'),
});

it('[AC-B2-02o#10] 无差异时三项建议全为假', () => {
  expect(recommendDailyCheckActions([])).toEqual({
    createDiscrepancies: false,
    freezeWithdrawals: false,
    disableAutoSettlement: false,
  });
});

it('[AC-B2-02o#11] 只有 pay- 差异：建议差错单、不冻结提现；全局差异照旧关闭月结', () => {
  expect(recommendDailyCheckActions([{ file: 'pay-receipts.sql', scope: 'account' }])).toEqual({
    createDiscrepancies: true,
    freezeWithdrawals: false,
    disableAutoSettlement: false,
  });
  expect(
    recommendDailyCheckActions([
      { file: 'pay-receipts.sql', scope: 'account' },
      { file: 'pay-suspense.sql', scope: 'global' },
    ]),
  ).toEqual({
    createDiscrepancies: true,
    freezeWithdrawals: false,
    disableAutoSettlement: true,
  });
});

it('[AC-B2-02o#12] 任一非 pay- 差异（含名字里带 pay 的）即建议冻结提现，不论顺序', () => {
  for (const name of ['01_balance.sql', '01_pay-receipts.sql', 'payout-holds.sql', 'pay_x.sql']) {
    const findings: DailyCheckFinding[] = [
      { file: 'pay-receipts.sql', scope: 'account' },
      { file: name, scope: 'account' },
    ];
    const expected = {
      createDiscrepancies: true,
      freezeWithdrawals: true,
      disableAutoSettlement: false,
    };
    expect(recommendDailyCheckActions(findings)).toEqual(expected);
    expect(recommendDailyCheckActions([...findings].reverse())).toEqual(expected);
  }
});

it('[AC-B2-02o#13] 性质：差错单看有无差异，冻结看有无非 pay- 差异，关闭月结看有无全局差异', () => {
  fc.assert(
    fc.property(fc.array(finding, { maxLength: 8 }), (findings) => {
      expect(recommendDailyCheckActions(findings)).toEqual({
        createDiscrepancies: findings.length > 0,
        freezeWithdrawals: findings.some((f) => !f.file.startsWith('pay-')),
        disableAutoSettlement: findings.some((f) => f.scope === 'global'),
      });
    }),
    propParams(),
  );
});
