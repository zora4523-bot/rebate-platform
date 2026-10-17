import { validateVoucher, type LedgerEntry, type VoucherValidationCode } from '@couli/domain';
import { expect, it } from 'vitest';
import { platformEntry, userEntry } from './fixtures.ts';

it.each([1n, 617n, 2147483649n, 9007199254740993n])(
  '[AC-B2-01h#6] BR-FUND-16：非零 bigint 借贷平衡凭证 %s 分通过且不改输入',
  (amount) => {
    const entries = Object.freeze([
      Object.freeze(platformEntry(amount)),
      Object.freeze(userEntry(-amount)),
    ]);
    expect(validateVoucher(entries)).toEqual({ ok: true });
    expect(entries).toEqual([platformEntry(amount), userEntry(-amount)]);
  },
);

it('[AC-B2-01h#7] BR-FUND-16：三条以上分录及同子户多条分录按总和校验', () => {
  expect(
    validateVoucher([
      platformEntry(1234n),
      userEntry(-617n),
      userEntry(-123n),
      {
        account_id: 'revenue',
        account_code: 'COMMISSION_REVENUE',
        sub_account: null,
        amount_fen: -494n,
      },
    ]),
  ).toEqual({ ok: true });
});

const invalidCases: readonly {
  label: string;
  entries: unknown;
  code: VoucherValidationCode;
  index: number | null;
}[] = [
  { label: '空凭证', entries: [], code: 'ENTRY_COUNT', index: null },
  { label: '单条凭证', entries: [platformEntry(1n)], code: 'ENTRY_COUNT', index: null },
  { label: '非数组', entries: null, code: 'ENTRY_COUNT', index: null },
  {
    label: '差一分',
    entries: [platformEntry(617n), userEntry(-616n)],
    code: 'UNBALANCED',
    index: null,
  },
  {
    label: '全部借方',
    entries: [platformEntry(1n), userEntry(1n)],
    code: 'UNBALANCED',
    index: null,
  },
  {
    label: '超过 Number 精度的差一分',
    entries: [platformEntry(9007199254740993n), userEntry(-9007199254740992n)],
    code: 'UNBALANCED',
    index: null,
  },
  ...[0n, 1, -1, '1', null, undefined, 1.5, NaN, Infinity].map((amount_fen) => ({
    label: `非法金额 ${String(amount_fen)}`,
    entries: [platformEntry(1n), { ...userEntry(-1n), amount_fen }],
    code: 'INVALID_AMOUNT' as const,
    index: 1,
  })),
  ...['', null, undefined].flatMap((value) => [
    {
      label: `缺科目ID ${String(value)}`,
      entries: [{ ...platformEntry(1n), account_id: value }, userEntry(-1n)],
      code: 'INVALID_ACCOUNT' as const,
      index: 0,
    },
    {
      label: `缺科目代码 ${String(value)}`,
      entries: [platformEntry(1n), { ...userEntry(-1n), account_code: value }],
      code: 'INVALID_ACCOUNT' as const,
      index: 1,
    },
  ]),
  ...[null, undefined, '', 'balance'].map((sub_account) => ({
    label: `用户子户非法 ${String(sub_account)}`,
    entries: [platformEntry(1n), { ...userEntry(-1n), sub_account }],
    code: 'INVALID_SUB_ACCOUNT' as const,
    index: 1,
  })),
  {
    label: '平台不应使用用户子户',
    entries: [{ ...platformEntry(1n), sub_account: 'available' }, userEntry(-1n)],
    code: 'INVALID_SUB_ACCOUNT',
    index: 0,
  },
  {
    label: '平台子户字段必须显式为 null',
    entries: [
      { account_id: 'union', account_code: 'UNION_RECEIVABLE', amount_fen: 1n },
      userEntry(-1n),
    ],
    code: 'INVALID_SUB_ACCOUNT',
    index: 0,
  },
];

it.each(invalidCases)(
  '[AC-B2-01h#8] BR-FUND-16：$label 返回定位错误',
  ({ entries, code, index }) => {
    const result = validateVoucher(entries as readonly LedgerEntry[]);
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([{ code, entry_index: index }]),
    });
  },
);

it('[AC-B2-01h#9] 多条非法金额分别报错，不用数值转换凑平', () => {
  const entries = [
    { ...platformEntry(1n), amount_fen: '1' },
    { ...userEntry(-1n), amount_fen: '-1' },
  ];
  const result = validateVoucher(entries as unknown as readonly LedgerEntry[]);
  expect(result).toEqual({
    ok: false,
    errors: [
      { code: 'INVALID_AMOUNT', entry_index: 0 },
      { code: 'INVALID_AMOUNT', entry_index: 1 },
    ],
  });
});
