import type { Category, EvalCase, Manifest } from '../../../packages/evals/src/index.ts';

// 全部是手写合成数据，无真实用户、会话、录制或私有评测题。
export function sample(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'syn-001',
    set: 'smoke',
    category: 'T1',
    split: 'tune',
    group: 'synthetic-search',
    provenance: 'synthetic',
    subject: 'guest',
    turns: [{ text: '合成例：查找蓝色文具' }],
    expect: { intent: 'search' },
    ...overrides,
  };
}

export function hashCases(): EvalCase[] {
  return [
    sample({
      id: 'a-2',
      group: 'g-b',
      category: 'T2',
      split: 'holdout',
      turns: [{ text: '退役合成例' }],
      expect: { intent: 'clarify' },
      retired: { at: '2026-10-05', reason: '合成模板退役' },
    }),
    sample({
      id: 'B-1',
      group: 'g-a',
      turns: [
        { text: '合成 A', untrusted: false },
        { text: '合成 B', untrusted: true },
      ],
      switches: { z: false, a: true },
      expect: {
        intent: 'search',
        tools: [{ name: 'search', args: { z: [{ y: 2, a: 1 }], a: '文具', b: 1, A: 2 } }],
        cards: ['product_list'],
        forbid: ['url_in_text', 'amount_in_text'],
      },
    }),
  ];
}

// BR-AI-21：总数 >=30，T1–T6、injection、unauthorized 各 >=3。
export const requiredCategories: Category[] = [
  'T1',
  'T2',
  'T3',
  'T4',
  'T5',
  'T6',
  'injection',
  'unauthorized',
];

export function smokeCases(): EvalCase[] {
  return [
    ...requiredCategories.flatMap((category) =>
      Array.from({ length: 3 }, (_, i) =>
        sample({
          id: `syn-${category}-${i}`,
          group: `g-${category}-${i}`,
          category,
          turns: [{ text: `合成模板 ${category} 第 ${i} 例` }],
        }),
      ),
    ),
    ...Array.from({ length: 6 }, (_, i) =>
      sample({
        id: `syn-extra-${i}`,
        group: `g-extra-${i}`,
        category: 'boundary_normal',
        turns: [{ text: `合成普通边界 第 ${i} 例` }],
      }),
    ),
  ];
}

// 独立 oracle：id 与每层对象键（包括数组内对象）均按 UTF-16 码元比较，
// 不用 localeCompare、不忽略大小写：B-1 在 a-2 前，参数键 A 在 a、b 前。
// 保留数组顺序；紧凑 JSON 每题后加 LF，UTF-8 SHA-256 小写十六进制。
// split 输入为 "B-1\ttune\na-2\tholdout\n"，包含退役题；由 Node crypto 单独算出。
export const fixedManifest: Manifest = {
  set: 'smoke',
  version: 'synthetic@1',
  count: 1,
  by_category: { T1: 1 },
  content_sha256: '9fdd1e182b81e7c120d3b5df99fd1b686997b7cb1eaad5b62f58bef1c834c040',
  split_sha256: '2364051587d782f033ed3547524dac97018da0d797a2b947099a45f813946d10',
};
