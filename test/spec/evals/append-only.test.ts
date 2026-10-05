import { expect, it } from 'vitest';
import { checkAppendOnly } from '../../../packages/evals/src/index.ts';
import type { EvalCase } from '../../../packages/evals/src/index.ts';
import { sample } from './fixtures.ts';

it('[B3-01a] 空历史、未变化历史、新增题和输入重排均允许', () => {
  const first = sample({ id: 'syn-1' });
  const second = sample({ id: 'syn-2' });
  expect(checkAppendOnly([], [])).toEqual([]);
  expect(checkAppendOnly([], [first])).toEqual([]);
  expect(checkAppendOnly([first], [structuredClone(first)])).toEqual([]);
  expect(checkAppendOnly([first], [second, first])).toEqual([]);
  expect(checkAppendOnly([first, second], [second, first])).toEqual([]);
});

it.each([false, true])('[B3-01a] 历史题不能删除，已退役题也必须保留：retired=%s', (retired) => {
  const previous = sample({
    ...(retired ? { retired: { at: '2026-10-05', reason: '合成退役' } } : {}),
  });
  const problems = checkAppendOnly([previous], [sample({ id: 'syn-new' })]);
  expect(problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'removed' })]));
});

it('[B3-01a] changes 记录不能豁免删题', () => {
  expect(checkAppendOnly([sample()], [], [{ id: 'syn-001', reason: '合成变更说明' }])).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'removed' })]),
  );
});

it('[B3-01a] 可以带原因退役，也可以保留既有退役状态', () => {
  const active = sample();
  const retired = sample({ retired: { at: '2026-10-05', reason: '合成模板已淘汰' } });
  expect(checkAppendOnly([active], [retired])).toEqual([]);
  expect(checkAppendOnly([retired], [structuredClone(retired)])).toEqual([]);
});

it('[B3-01a] 已退役不能恢复，即使提供 changes 记录', () => {
  const retired = sample({ retired: { at: '2026-10-05', reason: '合成退役' } });
  expect(checkAppendOnly([retired], [sample()])).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'unretired' })]),
  );
  expect(checkAppendOnly([retired], [sample()], [{ id: 'syn-001', reason: '合成说明' }])).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'unretired' })]),
  );
});

const changedExpectations: {
  label: string;
  before: EvalCase['expect'];
  after: EvalCase['expect'];
}[] = [
  { label: 'intent', before: { intent: 'search' }, after: { intent: 'clarify' } },
  {
    label: '工具名',
    before: { intent: 'search', tools: [{ name: 'search' }] },
    after: { intent: 'search', tools: [{ name: 'synthetic_other_tool' }] },
  },
  {
    label: '深层工具参数',
    before: { intent: 'search', tools: [{ name: 'search', args: { filter: { color: 'blue' } } }] },
    after: { intent: 'search', tools: [{ name: 'search', args: { filter: { color: 'red' } } }] },
  },
  {
    label: '新增卡片断言',
    before: { intent: 'search' },
    after: { intent: 'search', cards: ['product_list'] },
  },
  {
    label: '删除 forbid',
    before: { intent: 'search', forbid: ['url_in_text'] },
    after: { intent: 'search' },
  },
  {
    label: '修改 forbid',
    before: { intent: 'search', forbid: ['url_in_text'] },
    after: { intent: 'search', forbid: ['amount_in_text'] },
  },
  {
    label: '数组顺序',
    before: { intent: 'search', cards: ['product_list', 'page_guide'] },
    after: { intent: 'search', cards: ['page_guide', 'product_list'] },
  },
];

it.each(changedExpectations)('[B3-01a] expect 改变必须记录：$label', ({ before, after }) => {
  const previous = [sample({ expect: before })];
  const next = [sample({ expect: after })];
  for (const changes of [undefined, [], [{ id: 'syn-other', reason: '别题的合成说明' }]]) {
    expect(checkAppendOnly(previous, next, changes)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'expect_changed' })]),
    );
  }
  expect(checkAppendOnly(previous, next, [{ id: 'syn-001', reason: '合成期望修订说明' }])).toEqual(
    [],
  );
});

it('[B3-01a] expect 对象键重排不算改变，数组中嵌套对象也按内容比较', () => {
  const previous = sample({
    expect: {
      intent: 'search',
      cards: ['product_list'],
      tools: [{ name: 'search', args: { z: [{ b: 2, a: 1 }], a: true } }],
    },
  });
  const next = sample({
    expect: {
      tools: [{ args: { a: true, z: [{ a: 1, b: 2 }] }, name: 'search' }],
      cards: ['product_list'],
      intent: 'search',
    },
  });
  expect(checkAppendOnly([previous], [next])).toEqual([]);
});

it('[B3-01a] 同时退役不能绕过 expect 变更记录', () => {
  const next = sample({
    expect: { intent: 'clarify' },
    retired: { at: '2026-10-05', reason: '合成退役' },
  });
  expect(checkAppendOnly([sample()], [next])).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'expect_changed' })]),
  );
});

it('[B3-01a] 已退役题的 expect 变更同样需要记录', () => {
  const previous = sample({ retired: { at: '2026-10-05', reason: '合成退役' } });
  const next = { ...previous, expect: { intent: 'clarify' as const } };
  expect(checkAppendOnly([previous], [next])).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'expect_changed' })]),
  );
  expect(
    checkAppendOnly([previous], [next], [{ id: previous.id, reason: '合成期望勘误' }]),
  ).toEqual([]);
});

it('[B3-01a] 同次更新中的删除、恢复和期望修改都要报告', () => {
  const previous = [
    sample({ id: 'syn-remove' }),
    sample({ id: 'syn-restore', retired: { at: '2026-10-05', reason: '合成退役' } }),
    sample({ id: 'syn-change' }),
  ];
  const next = [
    sample({ id: 'syn-restore' }),
    sample({ id: 'syn-change', expect: { intent: 'clarify' } }),
  ];
  expect(checkAppendOnly(previous, next)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'removed' }),
      expect.objectContaining({ code: 'unretired' }),
      expect.objectContaining({ code: 'expect_changed' }),
    ]),
  );
});
