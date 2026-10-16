import { validateRuleVersion } from '@couli/domain';
import type { RuleVersionValidationError } from '@couli/domain';
import { expect, it } from 'vitest';
import {
  coordinate,
  errorsOf,
  expectOnlyErrors,
  freezeInput,
  RATIO_FIELDS,
  validInput,
} from './fixtures.ts';

// 月末最后一毫秒、月初零点、北京时间早8点前；所有比较到秒。
const TIMES = [
  {
    at: '2026-10-31T23:59:59.999+08:00',
    before: '2026-10-31T23:59:58+08:00',
    after: '2026-11-01T00:00:00+08:00',
  },
  {
    at: '2026-11-01T00:00:00+08:00',
    before: '2026-10-31T23:59:59.999+08:00',
    after: '2026-11-01T00:00:01+08:00',
  },
  {
    at: '2026-11-01T07:59:59+08:00',
    before: '2026-11-01T07:59:58+08:00',
    after: '2026-11-01T08:00:00+08:00',
  },
] as const;

it.each(TIMES)(
  '[AC-B2-03f#24] BR-CALC-11：等于发布时刻$at立即生效，未来也通过',
  ({ at, after }) => {
    const input = validInput();
    for (const effective_from of [at, after]) {
      expect(
        validateRuleVersion({
          ...input,
          publish_at: at,
          draft: { ...input.draft, effective_from },
        }),
      ).toEqual({ ok: true });
    }
  },
);

it.each(TIMES)('[AC-B2-03f#25] BR-CALC-11：早于发布时刻$at一秒拒绝', ({ at, before }) => {
  const input = validInput();
  expectOnlyErrors(
    validateRuleVersion({
      ...input,
      publish_at: at,
      draft: { ...input.draft, effective_from: before },
    }),
    [{ code: 'EFFECTIVE_BEFORE_PUBLISH' }],
  );
});

it.each(TIMES)(
  '[AC-B2-03f#26] BR-CALC-11：已发布版本$at严格递增，等于拒绝、后一秒通过',
  ({ at, before, after }) => {
    const input = validInput();
    const base = { ...input, publish_at: before, published_effective_froms: [at] };
    expectOnlyErrors(
      validateRuleVersion({ ...base, draft: { ...input.draft, effective_from: at } }),
      [{ code: 'EFFECTIVE_NOT_INCREASING' }],
    );
    expect(
      validateRuleVersion({ ...base, draft: { ...input.draft, effective_from: after } }),
    ).toEqual({ ok: true });
  },
);

it('[AC-B2-03f#27] BR-CALC-11：原例v3已发布11-01，v4设10-25拒绝，撤销v3后可发布', () => {
  const input = validInput();
  const candidate = {
    ...input,
    draft: { ...input.draft, effective_from: '2026-10-25T00:00:00+08:00' },
  };
  const future = '2026-11-01T00:00:00+08:00';
  const past = '2026-09-01T00:00:00+08:00';
  // 未排序的列表：不能只看第一项、最后一项，或只看已生效的项。
  for (const published_effective_froms of [
    [past, future],
    [future, past],
    [past, future, '2026-09-15T00:00:00+08:00'],
  ]) {
    expectOnlyErrors(validateRuleVersion({ ...candidate, published_effective_froms }), [
      { code: 'EFFECTIVE_NOT_INCREASING' },
    ]);
  }
  // 调用方过滤 revoked，纯函数只判断当前传入的已发布未撤销列表。
  expect(validateRuleVersion({ ...candidate, published_effective_froms: [past] })).toEqual({
    ok: true,
  });
});

it('[AC-B2-03f#28] BR-CALC-11：严格大于所有历史与未来已发布版本才通过', () => {
  const input = validInput();
  expect(
    validateRuleVersion({
      ...input,
      published_effective_froms: [
        '2026-11-01T00:00:00+08:00',
        '2026-09-01T00:00:00+08:00',
        '2026-10-25T00:00:00+08:00',
      ],
      draft: { ...input.draft, effective_from: '2026-11-01T00:00:01+08:00' },
    }),
  ).toEqual({ ok: true });
});

it('[AC-B2-03f#29] BR-CALC-11：同一秒的毫秒差不构成严格递增', () => {
  const input = validInput();
  expectOnlyErrors(
    validateRuleVersion({
      ...input,
      published_effective_froms: ['2026-11-01T00:00:00.001+08:00'],
      draft: { ...input.draft, effective_from: '2026-11-01T00:00:00.999+08:00' },
    }),
    [{ code: 'EFFECTIVE_NOT_INCREASING' }],
  );
});

it('[AC-B2-03f#30] BR-CALC-11：发布时间按秒比较，不因同秒毫秒差拒绝立即生效', () => {
  const input = validInput();
  expect(
    validateRuleVersion({
      ...input,
      publish_at: '2026-10-31T23:59:59.999+08:00',
      draft: { ...input.draft, effective_from: '2026-10-31T23:59:59+08:00' },
    }),
  ).toEqual({ ok: true });
});

it.each([
  '',
  'not-a-date',
  '2026-11-01T00:00:00',
  '2026-10-31T16:00:00Z',
  '2026-11-01T00:00:00+09:00',
  '2026-02-30T00:00:00+08:00',
  '2026-13-01T00:00:00+08:00',
  '2026-11-01T25:00:00+08:00',
])('[AC-B2-03f#31] BR-CALC-11：effective_from必须是合法ISO +08:00时刻 %s', (effective_from) => {
  const input = validInput();
  expectOnlyErrors(validateRuleVersion({ ...input, draft: { ...input.draft, effective_from } }), [
    { code: 'INVALID_EFFECTIVE_FROM' },
  ]);
});

it('[AC-B2-03f#32] BR-CALC-05/06/07/11：多处独立违规全部返回，错误顺序稳定且不改输入', () => {
  const input = validInput();
  const bad = input.draft.rules[0]!;
  const indirect = input.draft.rules[1]!;
  const duplicate = input.draft.rules[2]!;
  const missing = input.draft.rules.at(-1)!;
  const candidate = freezeInput({
    ...input,
    publish_at: '2026-11-01T00:00:00+08:00',
    published_effective_froms: ['2026-11-02T00:00:00+08:00'],
    activity_bonus_bp: -1n,
    draft: {
      ...input.draft,
      indirect_enabled: false,
      rules: [
        ...input.draft.rules
          .filter((row) => row !== missing)
          .map((row) => {
            if (row === bad) return { ...row, r_own_bp: -1n, r_direct_bp: -2n, r_indirect_bp: -3n };
            if (row === indirect) return { ...row, r_indirect_bp: 1n };
            return row;
          }),
        { ...duplicate },
      ],
      reserves: [
        { platform: 'taobao', reserve_bp: -1n },
        { platform: 'taobao', reserve_bp: 0n },
        { platform: 'pdd', reserve_bp: 0n },
      ],
    },
  });
  const snapshot = structuredClone(candidate);
  const result = validateRuleVersion(candidate);
  const expected: Omit<RuleVersionValidationError, 'detail'>[] = [
    { code: 'MISSING_RULE', ...coordinate(missing) },
    { code: 'DUPLICATE_RULE', ...coordinate(duplicate) },
    { code: 'MISSING_RESERVE', platform: 'jd' },
    { code: 'DUPLICATE_RESERVE', platform: 'taobao' },
    { code: 'RESERVE_OUT_OF_RANGE', platform: 'taobao' },
    ...RATIO_FIELDS.map(() => ({ code: 'RATIO_OUT_OF_RANGE' as const, ...coordinate(bad) })),
    { code: 'INDIRECT_DISABLED', ...coordinate(bad) },
    { code: 'INDIRECT_DISABLED', ...coordinate(indirect) },
    { code: 'ACTIVITY_BONUS_OUT_OF_RANGE' },
    { code: 'EFFECTIVE_BEFORE_PUBLISH' },
    { code: 'EFFECTIVE_NOT_INCREASING' },
  ];
  expectOnlyErrors(result, expected);
  const ratioErrors = errorsOf(result).filter((error) => error.code === 'RATIO_OUT_OF_RANGE');
  expect(ratioErrors).toHaveLength(3);
  for (const field of RATIO_FIELDS) {
    expect(ratioErrors.some((error) => error.detail.includes(field))).toBe(true);
  }
  expect(validateRuleVersion(validInput())).toEqual({ ok: true });
  expect(validateRuleVersion(candidate)).toEqual(result);
  expect(candidate).toEqual(snapshot);
});

it('[AC-B2-03f#33] 纯函数：冻结的合法草稿通过，调用方数据不被排序或改写', () => {
  const input = validInput();
  const frozen = freezeInput({
    ...input,
    platforms: [...input.platforms].reverse(),
    draft: {
      ...input.draft,
      rules: [...input.draft.rules].reverse(),
      reserves: [...input.draft.reserves].reverse(),
    },
  });
  const snapshot = structuredClone(frozen);
  expect(validateRuleVersion(frozen)).toEqual({ ok: true });
  expect(frozen).toEqual(snapshot);
});
