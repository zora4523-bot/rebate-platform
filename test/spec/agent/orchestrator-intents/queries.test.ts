import { expect, it, vi } from 'vitest';
import { copy, expectGuide, GUEST, kit, MEMBER, request, UNBOUND } from './kit.ts';

it.each([
  ['order_query', GUEST, 'login', 'agent.need_login'],
  ['order_query', UNBOUND, 'bind_phone', 'agent.need_phone'],
  ['earnings_query', GUEST, 'login', 'agent.earnings.need_login'],
  ['earnings_query', UNBOUND, 'bind_phone', 'agent.earnings.need_phone'],
] as const)(
  '[AC-B3-05f#17][BR-AI-01] %s 主体 %j 必须先完成身份验证',
  async (intent, caller, reason, key) => {
    for (const available of [true, false]) {
      const h = kit();
      if (!available) {
        h.disabled.add('agent.tools.get_my_earnings.enabled');
        h.disabled.add('agent.tools.list_my_orders.enabled');
        h.disabled.add('agent.tools.explain_order.enabled');
        h.disabled.add('agent.page_guide.enabled');
        h.registered.clear();
      }
      const output = await h.run(request({ agent_intent: intent }, '合成查询请求', caller));
      expect(output.result).toEqual({ kind: 'done', finishReason: 'auth_required' });
      expect(output.cards).toEqual([
        {
          type: 'auth_required',
          schema_version: 1,
          data: { platform: null, reason, resume_link_id: null },
          fallback_text: copy(key),
        },
      ]);
      expect(output.texts).toEqual([copy(key)]);
      expect(output.suggestions).toEqual([]);
      expect(h.deps.flags.enabled).not.toHaveBeenCalled();
      expect(h.deps.tools.registered).not.toHaveBeenCalled();
      expect(h.deps.continuation.run).not.toHaveBeenCalled();
      expect(h.traces.at(-1)?.value.text_replaced_by_template).toBe(true);
    }
  },
);

it.each(['untrustedInput', 'paramsRequested'] as const)(
  '[AC-B3-05f#18][BR-AI-01] 页面来源标记 %s 不取消本人查询的身份要求',
  async (flag) => {
    const h = kit();
    const output = await h.run(
      request({ agent_intent: 'order_query' }, '合成订单查询', GUEST, { [flag]: true }),
    );
    expect(output.result).toEqual({ kind: 'done', finishReason: 'auth_required' });
    expect(output.cards.map((card) => card.type)).toEqual(['auth_required']);
    expect(output.texts).toEqual([copy('agent.need_login')]);
  },
);

it.each([
  ['summary', '我余额还有多少', 'Wallet'],
  ['withdrawal_progress', '我的提现到哪了', 'WithdrawRecords'],
] as const)(
  '[AC-B3-05f#19][BR-AI-01] 已绑手机 %s 在工具关闭或尚未注册时降为 %s',
  async (topic, question, route) => {
    for (const unavailable of ['disabled', 'unregistered']) {
      const h = kit();
      if (unavailable === 'disabled') h.disabled.add('agent.tools.get_my_earnings.enabled');
      else h.registered.delete('get_my_earnings');
      const output = await h.run(request({ agent_intent: 'earnings_query', topic }, question));
      expectGuide(output, route);
      expect(h.deps.continuation.run).not.toHaveBeenCalled();
      expect(h.traces.at(-1)?.value.text_replaced_by_template).toBe(true);
    }
  },
);

it('[AC-B3-05f#20][BR-AI-01] 订单两个只读工具均关闭才降到 OrderList', async () => {
  const h = kit();
  h.disabled.add('agent.tools.list_my_orders.enabled');
  h.disabled.add('agent.tools.explain_order.enabled');
  expectGuide(
    await h.run(request({ agent_intent: 'order_query' }, '昨天买的牛奶返利什么时候结算')),
    'OrderList',
  );
  expect(h.deps.continuation.run).not.toHaveBeenCalled();
});

it.each(['list_my_orders', 'explain_order'])(
  '[AC-B3-05f#21][BR-AI-01] 仍有 %s 可用时不误降级为页面引导',
  async (tool) => {
    const h = kit();
    h.disabled.add(
      `agent.tools.${tool === 'list_my_orders' ? 'explain_order' : 'list_my_orders'}.enabled`,
    );
    const req = request({ agent_intent: 'order_query' }, '昨天买的牛奶返利什么时候结算');
    const output = await h.run(req);
    expect(output.cards).toEqual([]);
    expect(output.texts).toEqual([]);
    expect(h.deps.continuation.run).toHaveBeenCalledExactlyOnceWith(
      { agent_intent: 'order_query' },
      req,
      output.ctx,
    );
  },
);

it.each(['earnings_query', 'order_query'] as const)(
  '[AC-B3-05f#22][BR-AI-01] %s 降级仍须遵守页面开关及输入来源限制',
  async (intent) => {
    for (const blocker of ['disabled', 'untrustedInput', 'paramsRequested'] as const) {
      const h = kit();
      h.disabled.add('agent.tools.get_my_earnings.enabled');
      h.disabled.add('agent.tools.list_my_orders.enabled');
      h.disabled.add('agent.tools.explain_order.enabled');
      if (blocker === 'disabled') h.disabled.add('agent.page_guide.enabled');
      const flags = blocker === 'disabled' ? {} : { [blocker]: true };
      const output = await h.run(request({ agent_intent: intent }, '合成本人查询', MEMBER, flags));
      expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
      expect(output.cards).toEqual([]);
      expect(output.suggestions).toEqual([]);
      expect(output.texts).toEqual([copy('agent.guide.unavailable')]);
      expect(h.deps.continuation.run).not.toHaveBeenCalled();
    }
  },
);

it('[AC-B3-05f#23][BR-AI-01] 收益工具可用时转交后续工具路径，不擅自出引导卡', async () => {
  const h = kit();
  const req = request({ agent_intent: 'earnings_query' }, '我还有多少钱能提');
  const output = await h.run(req);
  expect(output.cards).toEqual([]);
  expect(output.texts).toEqual([]);
  expect(h.deps.continuation.run).toHaveBeenCalledExactlyOnceWith(
    { agent_intent: 'earnings_query' },
    req,
    output.ctx,
  );
});

// BR-AI-01 判定顺序②: intentionally wrong model labels cannot bypass personal-data rules.
it.each([
  ['我的返利什么时候结算', 'earnings_query', 'agent.earnings.need_login'],
  ['余额呢', 'earnings_query', 'agent.earnings.need_login'],
  ['提现到哪了', 'earnings_query', 'agent.earnings.need_login'],
  ['昨天买的牛奶返利什么时候结算', 'order_query', 'agent.need_login'],
  ['那单返了吗', 'order_query', 'agent.need_login'],
] as const)(
  '[AC-B3-05f#24][BR-AI-01] 本人查询优先于模型给的 page_guide/rule_qa：%s',
  async (question, intent, key) => {
    for (const modelOutput of [
      { agent_intent: 'page_guide', guide_route: 'Wallet' },
      { agent_intent: 'rule_qa' },
    ]) {
      const h = kit();
      const output = await h.run(request(modelOutput, question, GUEST));
      expect(output.result).toEqual({ kind: 'done', finishReason: 'auth_required' });
      expect(output.cards.map((card) => card.type)).toEqual(['auth_required']);
      expect(output.texts).toEqual([copy(key)]);
      expect(h.traces.at(-1)?.value.intent).toBe(intent);
    }
  },
);

it('[AC-B3-05f#25][BR-AI-01] 省略主语承接上文订单，不能仅按是否含“我”判断', async () => {
  const h = kit();
  h.deps.continuation.previousIntent = vi.fn(async () => 'order_query' as const);
  const output = await h.run(request({ agent_intent: 'earnings_query' }, '那返了吗', GUEST));
  expect(output.texts).toEqual([copy('agent.need_login')]);
  expect(output.result).toEqual({ kind: 'done', finishReason: 'auth_required' });
  expect(h.traces.at(-1)?.value.intent).toBe('order_query');
});

it.each(['返利一般什么时候结算', '提现最低多少'])(
  '[AC-B3-05f#26][BR-AI-01] 泛规则问法交给规则路径，不要求游客登录：%s',
  async (question) => {
    const h = kit();
    const req = request({ agent_intent: 'rule_qa' }, question, GUEST);
    const output = await h.run(req);
    expect(output.cards).toEqual([]);
    expect(output.texts).toEqual([]);
    expect(h.deps.continuation.run).toHaveBeenCalledExactlyOnceWith(
      { agent_intent: 'rule_qa' },
      req,
      output.ctx,
    );
  },
);

it.each([
  ['钱包在哪', 'Wallet'],
  ['怎么提现', 'Wallet'],
  ['提现记录在哪', 'WithdrawRecords'],
  ['订单列表在哪', 'OrderList'],
])('[AC-B3-05f#27][BR-AI-01] 页面位置与操作入口优先于泛规则：%s', async (question, route) => {
  const h = kit();
  const output = await h.run(request({ agent_intent: 'rule_qa' }, question, GUEST));
  expectGuide(output, route);
  expect(h.deps.continuation.run).not.toHaveBeenCalled();
});
