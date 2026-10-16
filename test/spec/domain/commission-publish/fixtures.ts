import type {
  RuleVersionRow,
  RuleVersionValidationError,
  ValidateRuleVersionInput,
  ValidateRuleVersionResult,
} from '@couli/domain';
import { expect } from 'vitest';

export const PLATFORMS = ['taobao', 'jd', 'pdd'] as const;
export const LEVELS = ['L1', 'L2', 'L3'] as const;
export const ORDERS = ['self', 'share'] as const;
export const RATIO_FIELDS = ['r_own_bp', 'r_direct_bp', 'r_indirect_bp'] as const;

/** 全零方便隔离每一种拒绝原因；开发默认比例另有原例测试。 */
export function validInput(platforms: readonly string[] = PLATFORMS): ValidateRuleVersionInput {
  return {
    platforms: [...platforms],
    publish_at: '2026-10-01T00:00:00+08:00',
    published_effective_froms: [],
    draft: {
      indirect_enabled: true,
      effective_from: '2026-10-01T00:00:00+08:00',
      rules: platforms.flatMap((platform) =>
        LEVELS.flatMap((level) =>
          ORDERS.map((order_type) => ({
            platform,
            level,
            order_type,
            r_own_bp: 0n,
            r_direct_bp: 0n,
            r_indirect_bp: 0n,
          })),
        ),
      ),
      reserves: platforms.map((platform) => ({ platform, reserve_bp: 0n })),
    },
  };
}

export function withRules(
  input: ValidateRuleVersionInput,
  rules: readonly RuleVersionRow[],
): ValidateRuleVersionInput {
  return { ...input, draft: { ...input.draft, rules } };
}

export function coordinate(row: RuleVersionRow) {
  return { platform: row.platform, level: row.level, order_type: row.order_type };
}

export function errorsOf(result: ValidateRuleVersionResult): readonly RuleVersionValidationError[] {
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

/** 只固定诊断身份和定位信息，不绑定展示文案或跨类型的排序策略。 */
export function expectOnlyErrors(
  result: ValidateRuleVersionResult,
  expected: readonly Omit<RuleVersionValidationError, 'detail'>[],
): void {
  const errors = errorsOf(result);
  expect(errors).toHaveLength(expected.length);
  expect(errors).toEqual(
    expect.arrayContaining(expected.map((error) => expect.objectContaining(error))),
  );
  expect(errors.every((error) => error.detail.trim().length > 0)).toBe(true);
}

export function freezeInput(input: ValidateRuleVersionInput): ValidateRuleVersionInput {
  input.draft.rules.forEach(Object.freeze);
  input.draft.reserves.forEach(Object.freeze);
  Object.freeze(input.draft.rules);
  Object.freeze(input.draft.reserves);
  Object.freeze(input.draft);
  Object.freeze(input.platforms);
  Object.freeze(input.published_effective_froms);
  return Object.freeze(input);
}
