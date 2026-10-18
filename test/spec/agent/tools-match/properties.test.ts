import { findSpecInTitle, normalizeSpec } from '@couli/domain';
import { createPropStats, propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { assignMatchTags } from '../../../../apps/api/src/modules/agent/tools/match/index.ts';
import { card, ManualScheduler } from './kit.ts';

it('[AC-B3-04d#53] 规格纯函数：同输入同结果，匹配片段来自 NFKC 标题，数值不得串位', () => {
  // 保留先红的原始 NotImplemented，不让 fast-check 包装成其他异常。
  normalizeSpec('24盒');
  findSpecInTitle('24盒', '合成24盒');
  const stats = createPropStats('B3-04d-spec-purity');
  try {
    const result = fc.check(
      fc.property(
        fc.integer({ min: 1, max: 9999 }),
        fc.constantFrom('盒', '箱', '袋', '瓶', '包', '件'),
        fc.boolean(),
        fc.boolean(),
        (value, unit, fullWidth, same) => {
          stats.hit(`${unit}:${fullWidth ? 'full-width' : 'ascii'}:${same ? 'same' : 'different'}`);
          const digits = String(same ? value : value + 1);
          const titleDigits = fullWidth
            ? [...digits].map((digit) => String.fromCharCode(digit.charCodeAt(0) + 0xfee0)).join('')
            : digits;
          // 此属性的标题不含空白；有空白时去空白的行为由 #2、#25、#36 单独断言。
          const input = Object.freeze({
            spec: `${value}${unit}`,
            title: `合成商品${titleDigits}${unit}装`,
          });
          const before = JSON.stringify(input);
          const normalized = normalizeSpec(input.spec);
          const found = findSpecInTitle(input.spec, input.title);
          return (
            JSON.stringify(input) === before &&
            JSON.stringify(normalized) === JSON.stringify(normalizeSpec(input.spec)) &&
            found === findSpecInTitle(input.spec, input.title) &&
            (same ? found === `${value}${unit}` : found === null) &&
            (found === null || input.title.normalize('NFKC').includes(found))
          );
        },
      ),
      propParams(),
    );
    expect({ failed: result.failed, counterexample: result.counterexample }).toEqual({
      failed: false,
      counterexample: null,
    });
  } finally {
    stats.flush();
  }
});

it('[AC-B3-04d#54] 随机卡片条件：逐卡优先级、纯函数与新数组性质始终成立', async () => {
  const deps = { provider: async () => 'rules' as const, scheduler: new ManualScheduler() };
  await assignMatchTags([card()], { relaxed: false }, 'app-a', deps);
  const stats = createPropStats('B3-04d-card-purity');
  try {
    const result = await fc.check(
      fc.asyncProperty(
        fc.array(
          fc.record({
            price: fc.oneof(
              fc.constantFrom(999, 1000, 4500, 5000, 5001),
              fc.integer({ min: 1, max: 10000000 }),
            ),
            matches: fc.boolean(),
            coupon: fc.boolean(),
            presale: fc.boolean(),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.boolean(),
        fc.boolean(),
        async (rows, relaxed, withSpec) => {
          stats.hit(
            `${relaxed ? 'relaxed-round' : 'original-round'}:${withSpec ? 'spec' : 'no-spec'}`,
          );
          const input = Object.freeze(
            rows.map((row, index) =>
              Object.freeze(
                card({
                  product_key: `tb:synthetic-${index}`,
                  title: row.matches ? '合成牛奶24盒' : '合成牛奶12盒',
                  // 原始轮价格已由搜索复筛，本段只在放宽轮收到越界价。
                  final_price_fen: relaxed ? row.price : 4500,
                  coupon_fen: row.coupon ? 1 : 0,
                  is_presale: row.presale,
                  benefit_tags: Object.freeze([]),
                }),
              ),
            ),
          );
          const conditions = Object.freeze({
            relaxed,
            priceMinFen: 1000,
            priceMaxFen: 5000,
            ...(withSpec ? { spec: '24盒' } : {}),
          });
          const before = JSON.stringify({ input, conditions });
          const output = await assignMatchTags(input, conditions, 'app-a', deps);
          const again = await assignMatchTags(input, conditions, 'app-a', deps);
          return (
            output !== input &&
            output.length === input.length &&
            JSON.stringify(output) === JSON.stringify(again) &&
            JSON.stringify({ input, conditions }) === before &&
            output.every((item, index) => {
              const row = rows[index]!;
              const violatesSpec = withSpec && !row.matches;
              const expectedTag =
                relaxed && (violatesSpec || row.price < 1000 || row.price > 5000)
                  ? 'relaxed'
                  : violatesSpec
                    ? 'spec_unconfirmed'
                    : 'matched';
              const expectedText = withSpec && expectedTag === 'matched' ? '24盒' : null;
              return (
                item.product_key === input[index]?.product_key &&
                item.match_tag === expectedTag &&
                item.spec_text === expectedText
              );
            })
          );
        },
      ),
      propParams(),
    );
    expect({ failed: result.failed, counterexample: result.counterexample }).toEqual({
      failed: false,
      counterexample: null,
    });
  } finally {
    stats.flush();
  }
});
