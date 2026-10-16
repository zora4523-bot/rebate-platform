import { validateRuleVersion } from '@couli/domain';
import { expect, it } from 'vitest';
import {
  coordinate,
  errorsOf,
  expectOnlyErrors,
  ORDERS,
  PLATFORMS,
  RATIO_FIELDS,
  validInput,
  withRules,
} from './fixtures.ts';

it.each([500n, 600n])('[AC-B2-03f#11] BR-CALC-07：原例6500+1000+%s跨等级最大值相加', (indirect) => {
  const input = validInput();
  const candidate = withRules(
    input,
    input.draft.rules.map((row) => {
      if (row.platform !== 'taobao' || row.order_type !== 'self') return row;
      return {
        ...row,
        r_own_bp: row.level === 'L3' ? 6500n : 0n,
        r_direct_bp: row.level === 'L2' ? 1000n : 0n,
        r_indirect_bp: row.level === 'L1' ? indirect : 0n,
      };
    }),
  );
  if (indirect === 500n) expect(validateRuleVersion(candidate)).toEqual({ ok: true });
  else
    expectOnlyErrors(validateRuleVersion(candidate), [
      { code: 'TOTAL_RATIO_EXCEEDED', platform: 'taobao', order_type: 'self' },
    ]);
});

it('[AC-B2-03f#12] BR-CALC-07：原例L3本人6500与L2直推1500合计8000通过', () => {
  const input = validInput();
  expect(
    validateRuleVersion(
      withRules(
        input,
        input.draft.rules.map((row) => ({
          ...row,
          r_own_bp: row.level === 'L3' ? 6500n : 0n,
          r_direct_bp: row.level === 'L2' ? 1500n : 0n,
        })),
      ),
    ),
  ).toEqual({ ok: true });
});

it.each(PLATFORMS.flatMap((platform) => ORDERS.map((order_type) => ({ platform, order_type }))))(
  '[AC-B2-03f#13] BR-CALC-07：每组独立检查8001边界 $platform/$order_type',
  ({ platform, order_type }) => {
    const input = validInput();
    expectOnlyErrors(
      validateRuleVersion(
        withRules(
          input,
          input.draft.rules.map((row) => {
            if (row.platform !== platform || row.order_type !== order_type) return row;
            return {
              ...row,
              r_own_bp: row.level === 'L1' ? 8000n : 0n,
              r_direct_bp: row.level === 'L2' ? 1n : 0n,
            };
          }),
        ),
      ),
      [{ code: 'TOTAL_RATIO_EXCEEDED', platform, order_type }],
    );
  },
);

it('[AC-B2-03f#14] BR-CALC-07：各平台和订单类型不混算，等级之间取max不求和', () => {
  const input = validInput();
  const groups = PLATFORMS.flatMap((platform) =>
    ORDERS.map((order_type) => ({ platform, order_type })),
  );
  expect(
    validateRuleVersion(
      withRules(
        input,
        input.draft.rules.map((row) => {
          const group = groups.findIndex(
            (g) => g.platform === row.platform && g.order_type === row.order_type,
          );
          const field = RATIO_FIELDS[group % RATIO_FIELDS.length]!;
          return { ...row, [field]: 8000n };
        }),
      ),
    ),
  ).toEqual({ ok: true });
});

it.each(
  RATIO_FIELDS.flatMap((field) =>
    [-1n, 8001n, 50000n, 9007199254740993n].map((value) => ({ field, value })),
  ),
)('[AC-B2-03f#15] BR-CALC-07：单项$field=$value逐条拒绝，不截断大整数', ({ field, value }) => {
  const input = validInput();
  const target = input.draft.rules.at(-1)!;
  const result = validateRuleVersion(
    withRules(
      input,
      input.draft.rules.map((row) => (row === target ? { ...row, [field]: value } : row)),
    ),
  );
  const errors = errorsOf(result);
  expect(errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'RATIO_OUT_OF_RANGE',
        ...coordinate(target),
        detail: expect.stringContaining(field),
      }),
    ]),
  );
});

it.each(RATIO_FIELDS.flatMap((field) => [0n, 8000n].map((value) => ({ field, value }))))(
  '[AC-B2-03f#16] BR-CALC-07：单项$field=$value上下界可取',
  ({ field, value }) => {
    const input = validInput();
    expect(
      validateRuleVersion(
        withRules(
          input,
          input.draft.rules.map((row) => ({ ...row, [field]: value })),
        ),
      ),
    ).toEqual({ ok: true });
  },
);

it.each(PLATFORMS.flatMap((platform) => [-1n, 10001n].map((value) => ({ platform, value }))))(
  '[AC-B2-03f#17] BR-CALC-06：预留$platform=$value超出0–10000拒绝',
  ({ platform, value }) => {
    const input = validInput();
    expectOnlyErrors(
      validateRuleVersion({
        ...input,
        draft: {
          ...input.draft,
          reserves: input.draft.reserves.map((row) =>
            row.platform === platform ? { ...row, reserve_bp: value } : row,
          ),
        },
      }),
      [{ code: 'RESERVE_OUT_OF_RANGE', platform }],
    );
  },
);

it.each([0n, 8001n, 10000n])(
  '[AC-B2-03f#18] BR-CALC-06/07：预留%s不占用8000用户份额上限',
  (reserve_bp) => {
    const input = validInput();
    expect(
      validateRuleVersion({
        ...input,
        draft: {
          ...input.draft,
          rules: input.draft.rules.map((row) => ({ ...row, r_own_bp: 8000n })),
          reserves: input.draft.reserves.map((row) => ({ ...row, reserve_bp })),
        },
      }),
    ).toEqual({ ok: true });
  },
);

it.each(validInput().draft.rules)(
  '[AC-B2-03f#19] BR-CALC-05：关闭间推时任一行非零均拒绝 $platform/$level/$order_type',
  (target) => {
    const input = validInput();
    expectOnlyErrors(
      validateRuleVersion({
        ...input,
        draft: {
          ...input.draft,
          indirect_enabled: false,
          rules: input.draft.rules.map((row) =>
            row.platform === target.platform &&
            row.level === target.level &&
            row.order_type === target.order_type
              ? { ...row, r_indirect_bp: 1n }
              : row,
          ),
        },
      }),
      [{ code: 'INDIRECT_DISABLED', ...coordinate(target) }],
    );
  },
);

it.each([false, true])('[AC-B2-03f#20] BR-CALC-05：间推开关%s允许全零版本', (indirect_enabled) => {
  const input = validInput();
  expect(validateRuleVersion({ ...input, draft: { ...input.draft, indirect_enabled } })).toEqual({
    ok: true,
  });
});

it.each([1000n, 1001n])(
  '[AC-B2-03f#21] BR-CALC-07：活动加成%s计入所有平台和订单类型',
  (activity_bonus_bp) => {
    const input = validInput();
    const candidate = {
      ...withRules(
        input,
        input.draft.rules.map((row) => ({ ...row, r_own_bp: 7000n })),
      ),
      activity_bonus_bp,
    };
    if (activity_bonus_bp === 1000n) expect(validateRuleVersion(candidate)).toEqual({ ok: true });
    else
      expectOnlyErrors(
        validateRuleVersion(candidate),
        PLATFORMS.flatMap((platform) =>
          ORDERS.map((order_type) => ({
            code: 'TOTAL_RATIO_EXCEEDED' as const,
            platform,
            order_type,
          })),
        ),
      );
  },
);

it.each([-1n, 8001n])(
  '[AC-B2-03f#22] BR-CALC-07：活动加成单项%s也必须在0–8000',
  (activity_bonus_bp) => {
    expect(errorsOf(validateRuleVersion({ ...validInput(), activity_bonus_bp }))).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ACTIVITY_BONUS_OUT_OF_RANGE' })]),
    );
  },
);

it.each([0n, 8000n])('[AC-B2-03f#23] BR-CALC-07：活动加成单项%s含上下界', (activity_bonus_bp) => {
  expect(validateRuleVersion({ ...validInput(), activity_bonus_bp })).toEqual({ ok: true });
});
