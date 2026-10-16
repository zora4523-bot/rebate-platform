import { validateRuleVersion } from '@couli/domain';
import { expect, it } from 'vitest';
import { coordinate, expectOnlyErrors, PLATFORMS, validInput, withRules } from './fixtures.ts';

it('[AC-B2-03f#1] BR-CALC-06：18行开发默认比例及3行零预留齐全时通过', () => {
  const input = validInput();
  expect(
    validateRuleVersion({
      ...input,
      draft: {
        ...input.draft,
        indirect_enabled: false,
        rules: input.draft.rules.map((row) => ({ ...row, r_own_bp: 5000n, r_direct_bp: 1000n })),
      },
    }),
  ).toEqual({ ok: true });
});

it.each(validInput().draft.rules)(
  '[AC-B2-03f#2] BR-CALC-06：缺少 $platform/$level/$order_type 整个版本拒绝',
  (missing) => {
    const input = validInput();
    const rules = input.draft.rules.filter(
      (row) =>
        row.platform !== missing.platform ||
        row.level !== missing.level ||
        row.order_type !== missing.order_type,
    );
    expectOnlyErrors(validateRuleVersion(withRules(input, rules)), [
      { code: 'MISSING_RULE', ...coordinate(missing) },
    ]);
  },
);

it.each(PLATFORMS)('[AC-B2-03f#3] BR-CALC-06：缺少 %s 预留不得回退旧版本', (platform) => {
  const input = validInput();
  expectOnlyErrors(
    validateRuleVersion({
      ...input,
      draft: {
        ...input.draft,
        reserves: input.draft.reserves.filter((row) => row.platform !== platform),
      },
    }),
    [{ code: 'MISSING_RESERVE', platform }],
  );
});

it('[AC-B2-03f#4] BR-CALC-06：空草稿逐条报告18个缺失组合和3个平台预留', () => {
  const input = validInput();
  expectOnlyErrors(
    validateRuleVersion({
      ...input,
      draft: { ...input.draft, rules: [], reserves: [] },
    }),
    [
      ...input.draft.rules.map((row) => ({ code: 'MISSING_RULE' as const, ...coordinate(row) })),
      ...PLATFORMS.map((platform) => ({ code: 'MISSING_RESERVE' as const, platform })),
    ],
  );
});

it.each(validInput().draft.rules)(
  '[AC-B2-03f#5] BR-CALC-06：重复 $platform/$level/$order_type 即使值相同也拒绝',
  (duplicate) => {
    const input = validInput();
    expectOnlyErrors(
      validateRuleVersion(withRules(input, [...input.draft.rules, { ...duplicate }])),
      [{ code: 'DUPLICATE_RULE', ...coordinate(duplicate) }],
    );
  },
);

it.each(PLATFORMS)('[AC-B2-03f#6] BR-CALC-06：每平台只能有一条预留 %s', (platform) => {
  const input = validInput();
  expectOnlyErrors(
    validateRuleVersion({
      ...input,
      draft: { ...input.draft, reserves: [...input.draft.reserves, { platform, reserve_bp: 1n }] },
    }),
    [{ code: 'DUPLICATE_RESERVE', platform }],
  );
});

it('[AC-B2-03f#7] BR-CALC-06：总行数正确仍不能用重复组合替代缺失组合', () => {
  const input = validInput();
  const missing = input.draft.rules[0]!;
  const duplicate = input.draft.rules[1]!;
  expectOnlyErrors(
    validateRuleVersion(withRules(input, [duplicate, ...input.draft.rules.slice(1)])),
    [
      { code: 'MISSING_RULE', ...coordinate(missing) },
      { code: 'DUPLICATE_RULE', ...coordinate(duplicate) },
    ],
  );
});

it('[AC-B2-03f#8] BR-CALC-06：规则和预留中的未配置平台均拒绝并可定位', () => {
  const input = validInput();
  const extra = { ...input.draft.rules[0]!, platform: 'meituan' };
  expectOnlyErrors(
    validateRuleVersion({
      ...input,
      draft: {
        ...input.draft,
        rules: [...input.draft.rules, extra],
        reserves: [...input.draft.reserves, { platform: 'meituan', reserve_bp: 0n }],
      },
    }),
    [
      { code: 'UNKNOWN_PLATFORM', ...coordinate(extra) },
      { code: 'UNKNOWN_PLATFORM', platform: 'meituan' },
    ],
  );
});

it('[AC-B2-03f#9] BR-CALC-06：加入美团后缺6行和1条预留均拒绝，补齐通过', () => {
  const platforms = [...PLATFORMS, 'meituan'];
  const input = validInput();
  const expanded = validInput(platforms);
  expectOnlyErrors(validateRuleVersion({ ...input, platforms }), [
    ...expanded.draft.rules
      .filter((row) => row.platform === 'meituan')
      .map((row) => ({ code: 'MISSING_RULE' as const, ...coordinate(row) })),
    { code: 'MISSING_RESERVE', platform: 'meituan' },
  ]);
  expect(validateRuleVersion(expanded)).toEqual({ ok: true });
});

it('[AC-B2-03f#10] BR-CALC-06：平台清单以参数为准，单平台与行顺序打乱均可通过', () => {
  const input = validInput(['pdd']);
  expect(validateRuleVersion(withRules(input, [...input.draft.rules].reverse()))).toEqual({
    ok: true,
  });
});
