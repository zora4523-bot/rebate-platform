import { expect, it } from 'vitest';
import { parseIntentOutput } from '../../../../apps/api/src/modules/agent/orchestrator/intents/index.ts';
import { kit, request } from './kit.ts';

it.each([
  { agent_intent: 'page_guide', guide_route: 'Wallet' },
  { agent_intent: 'page_guide', guide_route: '' }, // schema accepts strings; membership belongs to handle
  { agent_intent: 'order_query' },
  { agent_intent: 'earnings_query' },
  { agent_intent: 'earnings_query', topic: 'withdrawal_progress' },
  { agent_intent: 'out_of_scope' },
  { agent_intent: 'rule_qa' },
  { agent_intent: 'search' },
  { agent_intent: 'find_by_link' },
  { agent_intent: 'handoff' },
  { agent_intent: 'clarify', slot: 'reference' },
  { agent_intent: 'clarify', slot: 'price' },
  { agent_intent: 'clarify', slot: 'platform' },
  { agent_intent: 'ref_ordinal', ordinal: 2 },
  { agent_intent: 'refine', conditions: { platform: 'jd', price_max_fen: 20000 } },
])('[AC-B3-05f#1][BR-AI-01] 模块协议接受完整合法形状 %j', (value) => {
  expect(parseIntentOutput(JSON.stringify(value))).toEqual({ kind: 'intent', value });
});

it.each([' \n%s\t', '```json\n%s\n```', '```\n%s\n```'])(
  '[AC-B3-05f#2][BR-AI-01] 接受外层空白或单层代码围栏 %s',
  (wrapper) => {
    expect(
      parseIntentOutput(
        wrapper.replace('%s', '{"agent_intent":"page_guide","guide_route":"Wallet"}'),
      ),
    ).toEqual({ kind: 'intent', value: { agent_intent: 'page_guide', guide_route: 'Wallet' } });
  },
);

it.each([
  { agent_intent: 'page_guide' },
  { agent_intent: 'page_guide', guide_route: null },
  { agent_intent: 'page_guide', guide_route: 42 },
  { agent_intent: 'page_guide', guide_route: 'Wallet', params: {} },
  { agent_intent: 'page_guide', guide_route: 'Wallet', text: '模型伪造金额' },
  { agent_intent: 'order_query', user_id: 'synthetic-other' },
  { agent_intent: 'earnings_query', topic: 'invented' },
  { agent_intent: 'out_of_scope', text: '模型原文' },
  { agent_intent: 'clarify' },
  { agent_intent: 'clarify', slot: 'unknown' },
  { agent_intent: 'clarify', slot: 'price', suggestions: [] },
  { agent_intent: 'ref_ordinal', ordinal: 0 },
  { agent_intent: 'ref_ordinal', ordinal: 1.5 },
  { agent_intent: 'ref_ordinal', ordinal: '2' },
  { agent_intent: 'refine', conditions: {} },
  { agent_intent: 'refine', conditions: { platform: 'invented' } },
  { agent_intent: 'refine', conditions: { price_max_fen: '20000' } },
  { agent_intent: 'refine', conditions: { platform: 'jd', user_id: 'synthetic-other' } },
  { agent_intent: 'unknown' },
  { agent_intent: 1 },
  { agent_intent: null },
])('[AC-B3-05f#3][BR-AI-01] 意图缺字段、类型错误、额外字段与未知枚举不能被静默修正 %j', (value) => {
  expect(parseIntentOutput(JSON.stringify(value))).toBeNull();
});

it.each([
  '普通回答',
  '',
  '[]',
  '[{"agent_intent":"page_guide"}]',
  'null',
  '42',
  '"文字"',
  '{}',
  '{"text":"普通对象"}',
])('[AC-B3-05f#4][BR-AI-01] 非意图输入返回 none，普通文字交回核心 %s', async (text) => {
  expect(parseIntentOutput(text)).toEqual({ kind: 'none' });
  const output = await kit().run(request(text));
  expect(output.result).toBeNull();
  expect(output.cards).toEqual([]);
  expect(output.texts).toEqual([]);
  expect(output.suggestions).toEqual([]);
});

it('[AC-B3-05f#5][BR-AI-18] 不能解析的意图对象不能回到普通文字通道', async () => {
  const text = '{"agent_intent":"out_of_scope",';
  expect(parseIntentOutput(text)).toBeNull();
  const output = await kit().run(request(text));
  expect(output.result).not.toBeNull();
  expect(output.texts.join('')).not.toContain(text);
  expect(output.cards).toEqual([]);
});
