import { expect, it } from 'vitest';
import type { TemplateCall } from '../../../../apps/api/src/modules/agent/orchestrator/intents/index.ts';
import { copy, kit, request } from './kit.ts';

it('[AC-B3-05f#28][BR-AI-18] out_of_scope 丢弃模型输出，只给固定拒答', async () => {
  const h = kit();
  const output = await h.run(request({ agent_intent: 'out_of_scope' }, '给我讲个故事'));
  expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(output.texts).toEqual([copy('agent.refuse.out_of_scope')]);
  expect(output.cards).toEqual([]);
  expect(output.suggestions).toEqual([]);
  expect(h.deps.continuation.run).not.toHaveBeenCalled();
  expect(h.traces.at(-1)?.value.text_replaced_by_template).toBe(true);
});

// BR-AI-07 T5/T6 and BR-AI-01 收益查询. These summaries are trusted tool facts; no model
// output determines reason/status. Card assembly belongs to B3-08 / B3-16 and is not duplicated.
it.each<{ call: TemplateCall; key: string }>([
  {
    call: { name: 'explain_order', orders: [{ reason_code: 'REFUND', display_status: 'INVALID' }] },
    key: 'order_reason.REFUND.summary',
  },
  {
    call: {
      name: 'list_my_orders',
      orders: [{ reason_code: 'PART_REFUND', display_status: 'CREDITED_PART_CLAWED' }],
    },
    key: 'order_reason.PART_REFUND.summary',
  },
  {
    call: { name: 'explain_order', orders: [{ reason_code: null, display_status: 'WAITING' }] },
    key: 'order_status.WAITING.summary',
  },
  {
    call: {
      name: 'list_my_orders',
      orders: [
        { reason_code: 'REFUND', display_status: 'INVALID' },
        { reason_code: null, display_status: 'PAID' },
      ],
    },
    key: 'order_list.summary',
  },
  { call: { name: 'list_my_orders', orders: [] }, key: 'order_list.empty' },
  { call: { name: 'search_rules', matched: true }, key: 'agent.rule.found' },
  { call: { name: 'search_rules', matched: false }, key: 'agent.rule.not_found' },
  { call: { name: 'get_my_earnings', status: 'shown' }, key: 'agent.earnings.summary' },
  { call: { name: 'get_my_earnings', status: 'unavailable' }, key: 'agent.earnings.unavailable' },
])(
  '[AC-B3-05f#29][BR-AI-07][BR-AI-01] 本 run 调过 $call.name 后只用 $key',
  async ({ call, key }) => {
    const h = kit();
    h.calls.push(call);
    const output = await h.run(
      request('模型伪造结论：已到账 99999 元，见 https://example.invalid'),
    );
    expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(output.texts).toEqual([copy(key)]);
    expect(output.cards).toEqual([]);
    expect(output.suggestions).toEqual([]);
    expect(h.deps.trace.calls).toHaveBeenCalledWith('synthetic-app', 'synthetic-run');
    expect(h.deps.texts.text).toHaveBeenCalledWith('synthetic-app', key);
    expect(h.traces.at(-1)?.value.text_replaced_by_template).toBe(true);
    expect(h.deps.continuation.run).not.toHaveBeenCalled();
  },
);

it('[AC-B3-05f#30][BR-AI-07] 模板替换按 run 隔离，不沿用上一个 run 的订单事实', async () => {
  const h = kit();
  h.calls.push({ name: 'explain_order', orders: [{ reason_code: null, display_status: 'PAID' }] });
  expect((await h.run(request('模型原文'))).texts).toEqual([copy('order_status.PAID.summary')]);
  h.calls.length = 0;
  const req = request('普通合成说明');
  const next = { ...req, input: { ...req.input, runId: 'synthetic-next-run' } };
  const output = await h.run(next);
  expect(output.result).toBeNull();
  expect(output.texts).toEqual([]);
  expect(h.deps.trace.calls).toHaveBeenLastCalledWith('synthetic-app', 'synthetic-next-run');
});
