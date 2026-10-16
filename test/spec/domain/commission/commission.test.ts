import { quoteRebate, splitCommission } from '@couli/domain';
import { expect, it } from 'vitest';
import { splitReference } from '../../reference/split.ref.ts';
import { example, freezeInput, person, readExamples } from './fixtures.ts';

const examples = readExamples();

it.each(examples)(
  '[AC-B2-03a#1] $id $rule：$note',
  ({ input, expected, expectedAmounts, source, rule, note }) => {
    const result = splitCommission(freezeInput(input));
    expect(result).toEqual(expected);
    expect(
      [input.order_type, 'direct', 'indirect'].map(
        (role) => result.shares.find((share) => share.role === role)?.amount_fen ?? 0n,
      ),
    ).toEqual(expectedAmounts);
    expect(splitReference(input)).toEqual(expected);
    expect(examples.length).toBeGreaterThanOrEqual(20);
    expect(new Set(examples.map((row) => row.id)).size).toBe(examples.length);
    expect(['08', 'derived']).toContain(source);
    expect(rule).toMatch(/^BR-CALC-\d+$/);
    expect(note.length).toBeGreaterThan(0);
  },
);

it.each(examples.filter((row) => row.quote))(
  '[AC-B2-03a#2] $id 报价与同输入分账逐分一致',
  ({ input, expected }) => {
    const quote = quoteRebate({
      n_quote_fen: input.n_base_fen,
      reserve_bp: input.reserve_bp,
      r_own_bp: input.owner.ratio_bp,
    });
    expect(quote).toBe(expected.shares[0]?.amount_fen);
    expect(quote).toBe(splitCommission(input).shares[0]?.amount_fen);
  },
);

it('[AC-B2-03a#3] BR-CALC-24：调用方给share就只给分享者及其两层上级，不产生self份额', () => {
  const result = splitCommission(example({ order_type: 'share' }));
  expect(result.shares).toEqual([
    { role: 'share', user_id: 'owner', ratio_bp: 5000n, amount_fen: 617n },
    { role: 'direct', user_id: 'parent', ratio_bp: 1000n, amount_fen: 123n },
    { role: 'indirect', user_id: 'grandparent', ratio_bp: 500n, amount_fen: 61n },
  ]);
  expect(result.warnings).toEqual([]);
});

it('[AC-B2-03a#4] BR-CALC-04/24：每个角色使用调用方为该受益人选定的比例，不复用本人比例', () => {
  const result = splitCommission(
    example({
      n_base_fen: 1235n,
      order_type: 'share',
      owner: person('sharer', 4100n),
      direct: person('sharer-parent', 2300n),
      indirect: person('sharer-grandparent', 1300n),
    }),
  );
  expect(result.shares).toEqual([
    { role: 'share', user_id: 'sharer', ratio_bp: 4100n, amount_fen: 506n },
    { role: 'direct', user_id: 'sharer-parent', ratio_bp: 2300n, amount_fen: 284n },
    { role: 'indirect', user_id: 'sharer-grandparent', ratio_bp: 1300n, amount_fen: 160n },
  ]);
  expect(result.platform_retain_fen).toBe(285n);
});

it('[AC-B2-03a#5] BR-CALC-05：可选关系省略与null一致；没有直推关系不允许跳到间推', () => {
  const input = {
    n_base_fen: 1000n,
    reserve_bp: 0n,
    tlj_deduct_fen: 0n,
    order_type: 'self' as const,
    indirect_enabled: true,
    owner: person('owner', 5000n),
  };
  const expected = {
    base_fen: 1000n,
    reserve_fen: 0n,
    platform_retain_fen: 500n,
    shares: [{ role: 'self', user_id: 'owner', ratio_bp: 5000n, amount_fen: 500n }],
    warnings: [],
  };
  expect(splitCommission(input)).toEqual(expected);
  expect(splitCommission({ ...input, direct: null, indirect: null })).toEqual(expected);
  expect(splitCommission({ ...input, indirect: person('grandparent', 500n) })).toEqual(expected);
});

it('[AC-B2-03a#6] BR-CALC-05：关闭间推即使传同人也不输出间推或间推告警', () => {
  const result = splitCommission(
    example({ indirect_enabled: false, indirect: person('owner', 500n) }),
  );
  expect(result.shares.map((share) => share.role)).toEqual(['self', 'direct']);
  expect(result.platform_retain_fen).toBe(494n);
  expect(result.warnings).toEqual([]);
});

it('[AC-B2-03a#7] BR-CALC-08：三份各自floor，不能先算平台再把余款倒推给用户', () => {
  const result = splitCommission(
    example({
      n_base_fen: 3n,
      owner: person('owner', 2600n),
      direct: person('parent', 2600n),
      indirect: person('grandparent', 2600n),
    }),
  );
  expect(result.shares.map((share) => share.amount_fen)).toEqual([0n, 0n, 0n]);
  expect(result.platform_retain_fen).toBe(3n);
});

it('[AC-B2-03a#8] BR-CALC-02：不同N可得同一B；用户份额不变而平台预留仍须重算', () => {
  const after = splitCommission(example({ n_base_fen: 1453n, reserve_bp: 1500n }));
  expect(after.base_fen).toBe(1235n);
  // 1453→1454 在15%预留下基数均为1235，预留从218变219。
  const sameBase = splitCommission(example({ n_base_fen: 1454n, reserve_bp: 1500n }));
  expect(sameBase.base_fen).toBe(after.base_fen);
  expect(sameBase.shares).toEqual(after.shares);
  expect([after.reserve_fen, sameBase.reserve_fen]).toEqual([218n, 219n]);
  expect(sameBase.platform_retain_fen).toBe(after.platform_retain_fen);
});

it('[AC-B2-03a#9] BR-CALC-20：先floor报价基数再floor本人份额，不能合并乘法只取整一次', () => {
  expect(quoteRebate({ n_quote_fen: 3n, reserve_bp: 1500n, r_own_bp: 8000n })).toBe(1n);
  expect(quoteRebate({ n_quote_fen: 1n, reserve_bp: 1500n, r_own_bp: 5000n })).toBe(0n);
  expect(quoteRebate({ n_quote_fen: 1000n, reserve_bp: 0n, r_own_bp: 5500n })).toBe(550n);
});

it('[AC-B2-03a#10] 纯函数：不改输入且跨调用没有残留份额或警告', () => {
  const input = freezeInput(example());
  const original = structuredClone(input);
  const first = splitCommission(input);
  splitCommission(example({ indirect: person('owner', 500n), order_type: 'share' }));
  expect(splitCommission(input)).toEqual(first);
  expect(input).toEqual(original);
  expect(first).toEqual(splitReference(original));
});
