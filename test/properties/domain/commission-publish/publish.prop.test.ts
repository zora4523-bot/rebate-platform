import { isDeepStrictEqual } from 'node:util';
import { validateRuleVersion } from '@couli/domain';
import type {
  RuleVersionRow,
  RuleVersionValidationCode,
  ValidateRuleVersionInput,
} from '@couli/domain';
import { createPropStats, propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  freezeInput,
  LEVELS,
  ORDERS,
  PLATFORMS,
  validInput,
} from '../../../spec/domain/commission-publish/fixtures.ts';

const bp = fc.bigInt({ min: 0n, max: 8000n });
const rowSeeds = fc.tuple(bp, bp, bp);
const groupSeeds = fc.record({
  cuts: fc.tuple(bp, bp, bp),
  rows: fc.tuple(rowSeeds, rowSeeds, rowSeeds),
});

/** 按每组独立预算生成，不调用被测校验器筛选合法数据。 */
const legalVersions: fc.Arbitrary<ValidateRuleVersionInput> = fc
  .record({
    platforms: fc.constantFrom<readonly string[]>(['pdd'], PLATFORMS, [...PLATFORMS, 'meituan']),
    enabled: fc.boolean(),
    bonus: bp,
    explicitBonus: fc.boolean(),
    time: fc.constantFrom(
      '2026-10-31T23:59:59.999+08:00',
      '2026-11-01T00:00:00+08:00',
      '2026-11-01T07:59:59+08:00',
    ),
    reverse: fc.boolean(),
  })
  .chain((settings) =>
    fc
      .record({
        groups: fc.array(groupSeeds, {
          minLength: settings.platforms.length * 2,
          maxLength: settings.platforms.length * 2,
        }),
        reserves: fc.array(fc.bigInt({ min: 0n, max: 10000n }), {
          minLength: settings.platforms.length,
          maxLength: settings.platforms.length,
        }),
      })
      .map(({ groups, reserves }) => {
        const bonus = settings.explicitBonus ? settings.bonus : 0n;
        const budget = 8000n - bonus;
        const rules: RuleVersionRow[] = [];
        for (const [platformIndex, platform] of settings.platforms.entries()) {
          for (const [orderIndex, order_type] of ORDERS.entries()) {
            const group = groups[platformIndex * 2 + orderIndex]!;
            const [a, b, c] = group.cuts
              .map((cut) => cut % (budget + 1n))
              .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)) as [
              bigint,
              bigint,
              bigint,
            ];
            const caps = [a, b - a, settings.enabled ? c - b : 0n] as const;
            for (const [levelIndex, level] of LEVELS.entries()) {
              const seeds = group.rows[levelIndex]!;
              rules.push({
                platform,
                level,
                order_type,
                r_own_bp: seeds[0] % (caps[0] + 1n),
                r_direct_bp: seeds[1] % (caps[1] + 1n),
                r_indirect_bp: seeds[2] % (caps[2] + 1n),
              });
            }
          }
        }
        const base = validInput(settings.platforms);
        return {
          ...base,
          ...(settings.explicitBonus ? { activity_bonus_bp: bonus } : {}),
          publish_at: settings.time,
          published_effective_froms: ['2026-09-15T00:00:00+08:00', '2026-09-01T00:00:00+08:00'],
          draft: {
            indirect_enabled: settings.enabled,
            effective_from: settings.time,
            rules: settings.reverse ? rules.reverse() : rules,
            reserves: settings.platforms.map((platform, index) => ({
              platform,
              reserve_bp: reserves[index]!,
            })),
          },
        };
      }),
  );

function checkProperty<T>(
  name: string,
  arbitrary: fc.Arbitrary<T>,
  predicate: (value: T) => boolean,
): boolean {
  const stats = createPropStats(`domain:commission-publish:${name}`);
  try {
    fc.assert(
      fc.property(arbitrary, (value) => {
        stats.hit('generated');
        return predicate(value);
      }),
      propParams(),
    );
    return true;
  } finally {
    stats.flush();
  }
}

it('[AC-B2-03f#34] BR-CALC-05/06/07/11：独立预算生成的合法版本恒通过且保持输入不变', () => {
  expect(
    checkProperty('valid', legalVersions, (input) => {
      const before = structuredClone(input);
      const frozen = freezeInput(input);
      const first = validateRuleVersion(frozen);
      return (
        isDeepStrictEqual(first, { ok: true }) &&
        isDeepStrictEqual(validateRuleVersion(frozen), first) &&
        isDeepStrictEqual(input, before)
      );
    }),
  ).toBe(true);
}, 600_000);

const CORRUPTIONS = [
  { kind: 'missing', code: 'MISSING_RULE' },
  { kind: 'r_own_bp', code: 'RATIO_OUT_OF_RANGE' },
  { kind: 'r_direct_bp', code: 'RATIO_OUT_OF_RANGE' },
  { kind: 'r_indirect_bp', code: 'RATIO_OUT_OF_RANGE' },
  { kind: 'disabled', code: 'INDIRECT_DISABLED' },
] as const satisfies readonly { kind: string; code: RuleVersionValidationCode }[];

it.each(CORRUPTIONS)(
  '[AC-B2-03f#35] BR-CALC-05/06/07：随机破坏一行$kind恒拒绝且返回对应定位和错误码',
  ({ kind, code }) => {
    const cases = fc.tuple(legalVersions, fc.nat(), fc.boolean());
    expect(
      checkProperty(`corrupt-${kind}`, cases, ([input, choice, negative]) => {
        const index = choice % input.draft.rules.length;
        const target = input.draft.rules[index]!;
        let rules: readonly RuleVersionRow[];
        if (kind === 'missing')
          rules = input.draft.rules.filter((_, rowIndex) => rowIndex !== index);
        else if (kind === 'disabled')
          rules = input.draft.rules.map((row, rowIndex) => ({
            ...row,
            r_indirect_bp: rowIndex === index ? 1n : 0n,
          }));
        else
          rules = input.draft.rules.map((row, rowIndex) =>
            rowIndex === index
              ? {
                  ...row,
                  [kind]: negative ? -1n : 8001n,
                }
              : row,
          );
        const candidate = freezeInput({
          ...input,
          draft: {
            ...input.draft,
            rules,
            indirect_enabled: kind === 'disabled' ? false : input.draft.indirect_enabled,
          },
        });
        const before = structuredClone(candidate);
        const result = validateRuleVersion(candidate);
        return (
          !result.ok &&
          result.errors.some(
            (error) =>
              error.code === code &&
              error.platform === target.platform &&
              error.level === target.level &&
              error.order_type === target.order_type &&
              error.detail.trim().length > 0 &&
              (code !== 'RATIO_OUT_OF_RANGE' || error.detail.includes(kind)),
          ) &&
          isDeepStrictEqual(validateRuleVersion(candidate), result) &&
          isDeepStrictEqual(candidate, before)
        );
      }),
    ).toBe(true);
  },
  600_000,
);
