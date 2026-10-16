// 单元测试：发布校验的内部时刻解析与错误顺序；规则测试在 test/spec 与 test/properties。
import { expect, it } from 'vitest';
import { parseInstantSeconds, validateRuleVersion } from './publish-validation.ts';
import type { ValidateRuleVersionInput } from './publish-validation.ts';

const LEVELS = ['L1', 'L2', 'L3'] as const;
const ORDERS = ['self', 'share'] as const;

const input = (): ValidateRuleVersionInput => ({
  platforms: ['taobao'],
  publish_at: '2026-10-01T00:00:00+08:00',
  published_effective_froms: [],
  draft: {
    indirect_enabled: false,
    effective_from: '2026-10-01T00:00:00+08:00',
    rules: LEVELS.flatMap((level) =>
      ORDERS.map((order_type) => ({
        platform: 'taobao',
        level,
        order_type,
        r_own_bp: 5000n,
        r_direct_bp: 1000n,
        r_indirect_bp: 0n,
      })),
    ),
    reserves: [{ platform: 'taobao', reserve_bp: 0n }],
  },
});

it('[AC-B2-03f#24] 解析 +08:00 时刻到 UTC 秒，截掉小数秒', () => {
  expect(parseInstantSeconds('1970-01-01T08:00:00+08:00')).toBe(0);
  expect(parseInstantSeconds('1970-01-01T08:00:01.999+08:00')).toBe(1);
  expect(parseInstantSeconds('2026-11-01T00:00:00+08:00')).toBe(1_793_462_400);
  expect(parseInstantSeconds('2024-02-29T00:00:00+08:00')).not.toBeNull();
});

it('[AC-B2-03f#31] 非法时刻返回 null，不归一化', () => {
  for (const text of [
    '2025-02-29T00:00:00+08:00',
    '2026-04-31T00:00:00+08:00',
    '2026-11-01T23:60:00+08:00',
    '2026-11-01T23:00:60+08:00',
    '2026-11-01T00:00:00.+08:00',
    '2026-11-01 00:00:00+08:00',
    ' 2026-11-01T00:00:00+08:00',
  ]) {
    expect(parseInstantSeconds(text)).toBeNull();
  }
});

it('[AC-B2-03f#1] 开发默认比例的单平台版本通过', () => {
  expect(validateRuleVersion(input())).toEqual({ ok: true });
});

it('[AC-B2-03f#32] 非法的发布时刻与已发布时刻单独报告，不抛错', () => {
  const base = input();
  const result = validateRuleVersion({
    ...base,
    publish_at: 'bad',
    published_effective_froms: ['bad', '2026-11-01T00:00:00+08:00'],
  });
  expect(result).toEqual({
    ok: false,
    errors: [
      expect.objectContaining({ code: 'INVALID_PUBLISH_AT' }),
      expect.objectContaining({ code: 'INVALID_PUBLISHED_EFFECTIVE_FROM' }),
      expect.objectContaining({ code: 'EFFECTIVE_NOT_INCREASING' }),
    ],
  });
});

it('[AC-B2-03f#11] 合计按等级最大值：负值不拉低合计，关闭间推时间推项按 0 计', () => {
  const base = input();
  const result = validateRuleVersion({
    ...base,
    draft: {
      ...base.draft,
      rules: base.draft.rules.map((row) =>
        row.level === 'L1' && row.order_type === 'self'
          ? { ...row, r_own_bp: 7001n, r_direct_bp: -5000n, r_indirect_bp: 1n }
          : row,
      ),
    },
  });
  expect(result.ok ? [] : result.errors.map((error) => error.code)).toEqual([
    'RATIO_OUT_OF_RANGE',
    'INDIRECT_DISABLED',
    'TOTAL_RATIO_EXCEEDED',
  ]);
});
