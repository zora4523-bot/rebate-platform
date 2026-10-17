import { mayGoNegative, type NegativeBalanceInput } from '@couli/domain';
import { expect, it } from 'vitest';
import { negativeInput } from './fixtures.ts';

const ledgerTypes = [
  'REBATE_CREDIT',
  'SHARE_CREDIT',
  'REFERRAL_CREDIT',
  'CLAWBACK',
  'SETTLE_ADJUST',
  'WITHDRAW_FREEZE',
  'WITHDRAW_PAID',
  'WITHDRAW_RETURN',
  'WITHDRAW_FEE',
  'TAX_WITHHOLD',
  'REWARD',
  'ADMIN_ADJUST',
  'BAD_DEBT_WRITEOFF',
] as const;

it.each(ledgerTypes)('[AC-B2-01h#19] BR-FUND-10：%s 对负结果严格按白名单判定', (ledger_type) => {
  expect(mayGoNegative(negativeInput({ ledger_type, uniq_key: 'business-key' }))).toBe(
    ['CLAWBACK', 'SETTLE_ADJUST', 'ADMIN_ADJUST'].includes(ledger_type),
  );
});

it.each([
  ['CLAWBACK', 'FULL'],
  ['CLAWBACK', 'PART_REFUND'],
  ['CLAWBACK', 'RIGHTS'],
  ['CLAWBACK', 'PUNISH'],
  ['SETTLE_ADJUST', 'SETTLE_DIFF'],
  ['SETTLE_ADJUST', 'PRICE_COMPARE'],
  ['SETTLE_ADJUST', 'PRICE_PROTECT'],
  ['ADMIN_ADJUST', 'RESTORE'],
  ['ADMIN_ADJUST', 'RECON_FIX'],
  ['ADMIN_ADJUST', 'PAYOUT_RECOVERY'],
  ['ADMIN_ADJUST', 'ACCOUNT_CLOSED'],
  ['ADMIN_ADJUST', 'OTHER'],
])('[AC-B2-01h#20] BR-FUND-10：%s/%s 负向写入可扣至负数', (ledger_type, sub_type) => {
  expect(
    mayGoNegative(
      negativeInput({
        ledger_type,
        sub_type,
        uniq_key: 'business-key',
        available_delta_fen: -617n,
        resulting_available_fen: -400n,
      }),
    ),
  ).toBe(true);
});

it.each(['SETTLE_ADJUST', 'ADMIN_ADJUST'])(
  '[AC-B2-01h#21] BR-FUND-10：%s 正向补差或调账使余额从−400到−300，允许自然抵扣',
  (ledger_type) => {
    expect(
      mayGoNegative(
        negativeInput({ ledger_type, available_delta_fen: 100n, resulting_available_fen: -300n }),
      ),
    ).toBe(true);
  },
);

it.each(ledgerTypes)('[AC-B2-01h#22] %s 写后为零或正数不触犯负余额限制', (ledger_type) => {
  expect(mayGoNegative(negativeInput({ ledger_type, resulting_available_fen: 0n }))).toBe(true);
  expect(mayGoNegative(negativeInput({ ledger_type, resulting_available_fen: 200n }))).toBe(true);
});

it.each([
  'REBATE_CREDIT',
  'SHARE_CREDIT',
  'REFERRAL_CREDIT',
  'CLAWBACK',
  'SETTLE_ADJUST',
  'ADMIN_ADJUST',
])('[AC-B2-01h#23] BR-FUND-10：普通 %s 红冲不能借流水类型白名单扣负', (ledger_type) => {
  const input = negativeInput({ ledger_type, uniq_key: 'taobao:123:42:self:CREDIT:REVERSE' });
  expect(mayGoNegative(input)).toBe(false);
  expect(mayGoNegative({ ...input, resulting_available_fen: 0n })).toBe(true);
});

it.each(['REBATE_CREDIT', 'SHARE_CREDIT', 'REFERRAL_CREDIT'])(
  '[AC-B2-01h#24] BR-FUND-10：R14 %s 改派红冲明确上下文可扣负',
  (ledger_type) => {
    // Key format deliberately unspecified here: B2-01i owns R14 key construction.
    expect(
      mayGoNegative(
        negativeInput({
          ledger_type,
          uniq_key: 'opaque-reassign-reversal-key',
          reversal_kind: 'REASSIGN_REV',
          resulting_available_fen: -400n,
          available_delta_fen: -400n,
        }),
      ),
    ).toBe(true);
  },
);

it.each([
  { ledger_type: 'REASSIGN_REV' },
  { ledger_type: 'UNKNOWN' },
  { sub_type: 'REASSIGN_REV' },
  { uniq_key: 'taobao:REASSIGN_REV:42:self:CREDIT:REVERSE' },
  { uniq_key: 'taobao:CLAWBACK:42:self:CREDIT' },
  { ledger_type: 'WITHDRAW_FREEZE', reversal_kind: 'REASSIGN_REV' },
  { ledger_type: 'WITHDRAW_FEE', sub_type: 'RECON_FIX' },
] satisfies Partial<NegativeBalanceInput>[])(
  '[AC-B2-01h#25] 未知类型、键子串或借用子类型不可放行：%j',
  (overrides) => {
    expect(mayGoNegative(negativeInput(overrides))).toBe(false);
  },
);

it.each(['REBATE_CREDIT', 'SHARE_CREDIT', 'REFERRAL_CREDIT', 'WITHDRAW_RETURN'])(
  '[AC-B2-01h#26] BR-FUND-10：%s 后续入账自然抵扣，−400到200或−300均允许',
  (ledger_type) => {
    expect(
      mayGoNegative(
        negativeInput({ ledger_type, available_delta_fen: 600n, resulting_available_fen: 200n }),
      ),
    ).toBe(true);
    expect(
      mayGoNegative(
        negativeInput({ ledger_type, available_delta_fen: 100n, resulting_available_fen: -300n }),
      ),
    ).toBe(true);
  },
);

it('[AC-B2-01h#32] BR-FUND-10：普通入账红冲使已有负余额从−400降到−500，必须拒绝', () => {
  expect(
    mayGoNegative(
      negativeInput({
        uniq_key: 'taobao:1234567:42:self:CREDIT:REVERSE',
        available_delta_fen: -100n,
        resulting_available_fen: -500n,
      }),
    ),
  ).toBe(false);
});

it.each([
  { resulting_available_fen: -1 },
  { resulting_available_fen: '0' },
  { available_delta_fen: '-1' },
])('[AC-B2-01h#27] 非 bigint 金额不隐式转型放行：%j', (overrides) => {
  expect(
    mayGoNegative({
      ...negativeInput({ ledger_type: 'ADMIN_ADJUST' }),
      ...overrides,
    } as unknown as NegativeBalanceInput),
  ).toBe(false);
});
