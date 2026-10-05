import { expect, it } from 'vitest';
import { checkManifest, computeManifest } from '../../../packages/evals/src/index.ts';
import type { EvalCase, EvalSet, Manifest } from '../../../packages/evals/src/index.ts';
import { fixedManifest, hashCases, sample } from './fixtures.ts';

it('[B3-01a] 固定哈希：UTF-8、递归键排序、id 排序、每题末尾 LF，退役也参与两个摘要', () => {
  expect(computeManifest('smoke', 'synthetic@1', hashCases())).toEqual(fixedManifest);
});

it('[B3-01a] 题目输入顺序与对象键插入顺序不影响清单，数组内对象也规范化', () => {
  const reordered = hashCases()
    .reverse()
    .map((item) => {
      const { expect, turns, ...rest } = item;
      return { expect, turns, ...rest };
    });
  const active = reordered.find((item) => item.id === 'B-1');
  if (!active) throw new Error('Missing synthetic fixture');
  active.switches = { a: true, z: false };
  active.expect = {
    forbid: ['url_in_text', 'amount_in_text'],
    cards: ['product_list'],
    tools: [{ args: { A: 2, b: 1, a: '文具', z: [{ a: 1, y: 2 }] }, name: 'search' }],
    intent: 'search',
  };
  expect(computeManifest('smoke', 'synthetic@1', reordered)).toEqual(fixedManifest);
});

it('[B3-01a] 空清单计数为零，两个摘要均为 SHA-256 空串的固定值', () => {
  expect(computeManifest('smoke', 'synthetic@empty', [])).toEqual({
    set: 'smoke',
    version: 'synthetic@empty',
    count: 0,
    by_category: {},
    content_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    split_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
});

it.each<EvalSet>(['smoke', 'find', 'badcase', 'baseline-pairs', 'judges'])(
  '[B3-01a] 清单保存调用者指定的 set=%s 与版本引用',
  (set) => {
    const manifest = computeManifest(set, 'synthetic@v2', [sample({ set })]);
    expect(manifest).toMatchObject({
      set,
      version: 'synthetic@v2',
      count: 1,
      by_category: { T1: 1 },
    });
  },
);

it('[B3-01a] count 和 by_category 只计未退役；相同类别必须累加', () => {
  const manifest = computeManifest('smoke', 'synthetic@1', [
    sample({ id: 'syn-1' }),
    sample({ id: 'syn-2' }),
    sample({ id: 'syn-3', category: 'T5' }),
    sample({ id: 'syn-4', category: 'T5', retired: { at: '2026-10-05', reason: '合成退役' } }),
  ]);
  expect(manifest.count).toBe(3);
  expect(manifest.by_category).toEqual({ T1: 2, T5: 1 });
});

it('[B3-01a] 内容和数组顺序变动必须改变内容摘要，但不改变切分摘要', () => {
  const edits: ((item: EvalCase) => void)[] = [
    (item) => {
      item.turns.reverse();
    },
    (item) => {
      item.expect.forbid?.reverse();
    },
    (item) => {
      item.turns = [{ text: '另一合成题' }];
    },
    (item) => {
      item.expect.intent = 'clarify';
    },
  ];
  for (const edit of edits) {
    const cases = hashCases();
    const active = cases.find((item) => item.id === 'B-1');
    if (!active) throw new Error('Missing synthetic fixture');
    edit(active);
    const manifest = computeManifest('smoke', 'synthetic@1', cases);
    expect(manifest.content_sha256).not.toBe(fixedManifest.content_sha256);
    expect(manifest.split_sha256).toBe(fixedManifest.split_sha256);
  }
});

it('[B3-01a] 退役题内容仍受哈希保护，不能静默修改', () => {
  const cases = hashCases().map((item) =>
    item.retired ? { ...item, turns: [{ text: '被修改的合成退役题' }] } : item,
  );
  const manifest = computeManifest('smoke', 'synthetic@1', cases);
  expect(manifest.content_sha256).not.toBe(fixedManifest.content_sha256);
  expect(manifest.split_sha256).toBe(fixedManifest.split_sha256);
  expect(manifest.count).toBe(1);
});

it('[B3-01a] 改变退役题 split 也改变两个摘要，但计数保持不变', () => {
  const cases = hashCases().map((item): EvalCase =>
    item.retired ? { ...item, split: 'validate' } : item,
  );
  const manifest = computeManifest('smoke', 'synthetic@1', cases);
  expect(manifest.content_sha256).not.toBe(fixedManifest.content_sha256);
  expect(manifest.split_sha256).not.toBe(fixedManifest.split_sha256);
  expect(manifest.count).toBe(1);
});

it('[B3-01a] 独立固定清单核对通过，输入题目可逆序', () => {
  expect(checkManifest(fixedManifest, hashCases())).toEqual([]);
  expect(checkManifest(fixedManifest, hashCases().reverse())).toEqual([]);
});

const mismatches: { field: string; patch: Partial<Manifest> }[] = [
  { field: 'count', patch: { count: 2 } },
  { field: 'by_category', patch: { by_category: { T1: 2 } } },
  { field: 'by_category', patch: { by_category: {} } },
  { field: 'by_category', patch: { by_category: { T1: 1, T2: 1 } } },
  { field: 'content_sha256', patch: { content_sha256: '0'.repeat(64) } },
  { field: 'split_sha256', patch: { split_sha256: '0'.repeat(64) } },
  {
    field: 'content_sha256',
    patch: { content_sha256: fixedManifest.content_sha256.toUpperCase() },
  },
];

it.each(mismatches)('[B3-01a] 清单不一致报 manifest_mismatch 并指出 $field', ({ field, patch }) => {
  const problems = checkManifest({ ...fixedManifest, ...patch }, hashCases());
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.every((problem) => problem.code === 'manifest_mismatch')).toBe(true);
  expect(problems.some((problem) => problem.message.includes(field))).toBe(true);
});

it('[B3-01a] 一次核对报告所有不一致字段', () => {
  const problems = checkManifest(
    {
      ...fixedManifest,
      count: 99,
      by_category: {},
      content_sha256: '0'.repeat(64),
      split_sha256: '0'.repeat(64),
    },
    hashCases(),
  );
  for (const field of ['count', 'by_category', 'content_sha256', 'split_sha256']) {
    expect(
      problems.some(
        (problem) => problem.code === 'manifest_mismatch' && problem.message.includes(field),
      ),
    ).toBe(true);
  }
});
