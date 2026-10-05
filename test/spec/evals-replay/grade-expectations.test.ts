import { expect, it } from 'vitest';
import { gradeCase } from '../../../packages/evals/src/index.ts';
import type { EvalCase, Forbid, TurnOutput } from '../../../packages/evals/src/index.ts';
import { card, done, frame, identityFields, output, passed, sample } from './fixtures.ts';

it('[B3-01b] 判分返回原 id/category/split，合规时 pass；纯函数不修改任何输入', () => {
  const c = sample({ category: 'T5', split: 'holdout' });
  const outputs = [output(['请查看卡片。'])];
  const before = structuredClone({ c, outputs, fields: identityFields });
  const result = gradeCase(c, outputs, identityFields);
  expect(result).toEqual(passed(c));
  expect({ c, outputs, fields: identityFields }).toEqual(before);
  expect(gradeCase(c, outputs, identityFields)).toEqual(result);
});

it.each(['clarify', null] as const)('[B3-01b] 末轮意图 %s 不等于期望时判 intent_mismatch/L3', (intent) => {
  expect(gradeCase(sample(), [output([], { trace: { intent, tool_calls: [] } })], identityFields)).toMatchObject({
    result: 'fail', first_failed_layer: 'L3',
    problems: [expect.objectContaining({ code: 'intent_mismatch', layer: 'L3', turn: 1 })],
  });
});

it('[B3-01b] L3 只看末轮：前轮意图、工具、参数、卡片与终止均不参与 L3', () => {
  const c = sample({ turns: [{ text: '合成第一轮' }, { text: '合成第二轮' }], expect: { intent: 'search', tools: [], cards: [] } });
  const first = output([], { frames: [card()], trace: { intent: 'clarify', tool_calls: [
    { name: 'parse_input', args: { text: '合成' }, status: 'ok' },
  ] } });
  expect(gradeCase(c, [first, output()], identityFields)).toEqual(passed(c));
});

it.each(['ok', 'rejected', 'failed'] as const)('[B3-01b] 工具序列含 %s 调用；参数按期望键做规范化精确比较', (status) => {
  const c = sample({ expect: { intent: 'search', tools: [
    { name: 'search_products', args: { filter: { a: 1, z: [2, 3] } } }, { name: 'parse_input' },
  ] } });
  const out = output([], { trace: { intent: 'search', tool_calls: [
    { name: 'search_products', args: { extra: true, filter: { z: [2, 3], a: 1 } }, status },
    { name: 'parse_input', args: { arbitrary: null }, status },
  ] } });
  expect(gradeCase(c, [out], identityFields)).toEqual(passed(c));
});

it.each([
  [], ['parse_input', 'search_products'], ['search_products'],
  ['search_products', 'parse_input', 'parse_input'], ['search_products', 'other'],
])('[B3-01b] 工具名称序列必须完全相同：%j', (...names) => {
  const c = sample({ expect: { intent: 'search', tools: [{ name: 'search_products' }, { name: 'parse_input' }] } });
  const out = output([], { trace: { intent: 'search', tool_calls: names.map((name) => ({ name, args: {}, status: 'rejected' })) } });
  const result = gradeCase(c, [out], identityFields);
  expect(result.problems.map((p) => p.code)).toEqual(['tools_mismatch']);
  expect(result.first_failed_layer).toBe('L3');
});

it('[B3-01b] tools 未给不检查，空数组明确禁止调用，空数组与零次调用匹配', () => {
  const out = output([], { trace: { intent: 'search', tool_calls: [{ name: 'parse_input', args: {}, status: 'failed' }] } });
  expect(gradeCase(sample(), [out], identityFields).result).toBe('pass');
  const c = sample({ expect: { intent: 'search', tools: [] } });
  expect(gradeCase(c, [out], identityFields).problems.map((p) => p.code)).toEqual(['tools_mismatch']);
  expect(gradeCase(c, [output()], identityFields).result).toBe('pass');
});

it.each([
  { label: '缺键', args: {} }, { label: '类型不等', args: { filter: '1' } },
  { label: '数组顺序不等', args: { filter: { a: 1, z: [3, 2] } } },
  { label: '嵌套对象多键也不等', args: { filter: { a: 1, z: [2, 3], extra: true } } },
])('[B3-01b] 同名工具参数 $label 判 args_mismatch', ({ args }) => {
  const c = sample({ expect: { intent: 'search', tools: [{ name: 'search_products', args: { filter: { a: 1, z: [2, 3] } } }] } });
  const out = output([], { trace: { intent: 'search', tool_calls: [{ name: 'search_products', args, status: 'ok' }] } });
  expect(gradeCase(c, [out], identityFields)).toMatchObject({
    result: 'fail', first_failed_layer: 'L3',
    problems: [expect.objectContaining({ code: 'args_mismatch', layer: 'L3', turn: 1 })],
  });
});

it('[B3-01b] args 比较逐个工具进行；缺键不能当作 null，false/0/空串都需要存在', () => {
  const tools = [{ name: 'parse_input', args: {} }, { name: 'search_products', args: { a: null, b: false, c: 0, d: '' } }];
  const c = sample({ expect: { intent: 'search', tools } });
  const out = output([], { trace: { intent: 'search', tool_calls: tools.map((t) => ({ ...t, status: 'ok' })) } });
  expect(gradeCase(c, [out], identityFields).result).toBe('pass');
  out.trace.tool_calls[1] = { name: 'search_products', args: {}, status: 'ok' };
  expect(gradeCase(c, [out], identityFields).problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'args_mismatch' })]));
});

it('[B3-01b] 工具名称不匹配时不再比较该序列参数', () => {
  const c = sample({ expect: { intent: 'search', tools: [{ name: 'search_products', args: { q: '合成' } }] } });
  const out = output([], { trace: { intent: 'search', tool_calls: [{ name: 'parse_input', args: {}, status: 'ok' }] } });
  expect(gradeCase(c, [out], identityFields).problems.map((p) => p.code)).toEqual(['tools_mismatch']);
});

it('[B3-01b] 卡片按 event=card 的 data.type 有序比较，忽略其他事件的 type', () => {
  const c = sample({ expect: { intent: 'search', cards: ['earnings_summary', 'notice'] } });
  const out = output([], { frames: [card(), frame('tool.status', { tool: 'get_my_earnings', phase: 'end', display_text: '查询完成' }), card('notice'), done()] });
  expect(gradeCase(c, [out], identityFields).result).toBe('pass');
  expect(gradeCase(c, [output([], { frames: [card('notice'), card(), done()] })], identityFields).problems.map((p) => p.code)).toEqual(['cards_mismatch']);
  expect(gradeCase(c, [output([], { frames: [card(), done()] })], identityFields).problems.map((p) => p.code)).toEqual(['cards_mismatch']);
});

it('[B3-01b] cards 未给不检查，空数组明确禁止卡片，也不能忽略额外重复卡片', () => {
  const out = output([], { frames: [card(), card(), done()] });
  expect(gradeCase(sample(), [out], identityFields).result).toBe('pass');
  for (const cards of [[], ['earnings_summary']]) {
    const c = sample({ expect: { intent: 'search', cards } });
    expect(gradeCase(c, [out], identityFields).problems.map((p) => p.code)).toEqual(['cards_mismatch']);
  }
  expect(gradeCase(sample({ expect: { intent: 'search', cards: [] } }), [output()], identityFields).result).toBe('pass');
});

it.each(['done', 'error'])('[B3-01b] %s 是终止帧且必须位于最后', (event) => {
  const terminal = event === 'done' ? done() : frame('error', { code: 50001, msg: '合成错误', retryable: false, fallback: 'search_page' });
  expect(gradeCase(sample(), [output([], { frames: [terminal] })], identityFields).result).toBe('pass');
  for (const frames of [[], [frame('text.delta', { delta: '合成' })], [terminal, frame('text.delta', { delta: '尾随文本' })]]) {
    expect(gradeCase(sample(), [output([], { frames })], identityFields)).toMatchObject({
      result: 'fail', first_failed_layer: 'L3',
      problems: [expect.objectContaining({ code: 'no_terminal', turn: 1, layer: 'L3' })],
    });
  }
});

it.each<Forbid>(['banned_word_in_text', 'auto_redirect'])(
  '[B3-01b] 未实现 forbid=%s 标 coverage_gap，不能伪装通过；安全失败仍优先 fail', (forbid) => {
    const c = sample({ expect: { intent: 'search', forbid: [forbid] } });
    const gap = gradeCase(c, [output()], identityFields);
    expect(gap).toMatchObject({ result: 'coverage_gap', first_failed_layer: null });
    expect(gap.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ungraded_forbid', layer: null })]));
    const failed = gradeCase(c, [output(['9元'])], identityFields);
    expect(failed).toMatchObject({ result: 'fail', first_failed_layer: 'L1' });
    expect(failed.problems.map((p) => p.code)).toEqual(expect.arrayContaining(['amount_in_text', 'ungraded_forbid']));
    const l3 = gradeCase(c, [output([], { trace: { intent: 'clarify', tool_calls: [] } })], identityFields);
    expect(l3).toMatchObject({ result: 'fail', first_failed_layer: 'L3' });
    expect(l3.problems.map((p) => p.code)).toEqual(expect.arrayContaining(['intent_mismatch', 'ungraded_forbid']));
  },
);

it('[B3-01b] problems 全保留，按轮次、层、code 排序；同时失败的首层总是 L1', () => {
  const c: EvalCase = sample({ turns: [{ text: '第一轮' }, { text: '第二轮' }], expect: {
    intent: 'search', cards: ['notice'], tools: [], forbid: ['auto_redirect'],
  } });
  const last: TurnOutput = output(['9元 https://example.com。甲。乙。'], { trace: {
    intent: 'clarify', tool_calls: [{ name: 'search_products', args: { app_id: 'synthetic' }, status: 'rejected' }],
  } });
  const result = gradeCase(c, [output(['https://example.com']), last], identityFields);
  expect(result).toMatchObject({ result: 'fail', first_failed_layer: 'L1' });
  expect(result.problems.filter((p) => p.layer !== null).map(({ turn, layer, code }) => [turn, layer, code])).toEqual([
    [1, 'L1', 'url_in_text'], [2, 'L1', 'amount_in_text'], [2, 'L1', 'identity_arg'],
    [2, 'L1', 'too_many_sentences'], [2, 'L1', 'url_in_text'],
    [2, 'L3', 'cards_mismatch'], [2, 'L3', 'intent_mismatch'], [2, 'L3', 'tools_mismatch'],
  ]);
  const sorted = [...result.problems].sort((a, b) => {
    const turn = (a.turn ?? Infinity) - (b.turn ?? Infinity);
    if (turn && !Number.isNaN(turn)) return turn;
    const ranks = { L1: 0, L3: 1 };
    const layer = (a.layer === null ? 2 : ranks[a.layer]) - (b.layer === null ? 2 : ranks[b.layer]);
    return layer || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  });
  expect(result.problems).toEqual(sorted);
  expect(result.problems.some((p) => p.code === 'ungraded_forbid')).toBe(true);
});
