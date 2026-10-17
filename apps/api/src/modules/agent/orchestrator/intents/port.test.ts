import { bridge } from '@couli/contracts-ts';
import { expect, it, vi } from 'vitest';
import type { AgentCaller } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import { createIntentPort } from './index.ts';
import type { IntentDeps, IntentRequest } from './index.ts';

// Synthetic only. BR-AI-01 细则「判定顺序」②③④ through the whole port: the server's clear
// reading of the user's text decides between personal queries, page_guide and rule_qa.
const GUEST = { userId: null, phoneBound: false };
const MEMBER = { userId: 'synthetic-user', phoneBound: true };
const CONFIGURED = [
  'Wallet',
  'WithdrawRecords',
  'AuthManage',
  'OrderList',
  'InviteShare',
  'Messages',
];

function copy(key: string): string {
  return `合成文案:${key}`;
}

function request(
  output: unknown,
  text: string,
  caller: Pick<AgentCaller, 'userId' | 'phoneBound'>,
): IntentRequest {
  return {
    text: JSON.stringify(output),
    input: {
      caller: {
        appId: 'synthetic-app',
        traceId: 'synthetic-trace',
        deviceId: 'synthetic-device',
        deviceHash: 'synthetic-hash',
        ipKey: 'synthetic-ip',
        ...caller,
      },
      sessionId: 'synthetic-session',
      runId: 'synthetic-run',
      userMessageId: 'synthetic-user-message',
      assistantMessageId: 'synthetic-assistant-message',
      text,
      redactedText: text as RedactedText,
      limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
    },
    proceed: {
      kind: 'proceed',
      modelText: text,
      placeholders: {},
      links: [],
      notices: [],
      untrustedInput: false,
      paramsRequested: false,
    },
  };
}

function harness(disabled: readonly string[] = []) {
  const off = new Set(disabled);
  const unused = () => Promise.reject(new Error('synthetic: clarification not expected'));
  const deps: IntentDeps = {
    routes: { configured: async () => CONFIGURED, contract: () => bridge.routes },
    flags: { enabled: async (_app, key) => !off.has(key) },
    tools: { registered: () => true },
    texts: { text: async (_app, key) => copy(key) },
    trace: { calls: async () => [], record: vi.fn() },
    clarification: {
      scope: unused,
      takeOnce: unused,
      options: unused,
      latestProducts: unused,
      fallbackNotice: unused,
      withoutCondition: unused,
    },
    continuation: {
      previousIntent: vi.fn(async () => null),
      run: vi.fn<IntentDeps['continuation']['run']>(async () => ({
        kind: 'done',
        finishReason: 'stop',
      })),
    },
  };
  const port = createIntentPort(deps);
  return {
    deps,
    async run(req: IntentRequest) {
      const cards: UnnumberedCard[] = [];
      const texts: string[] = [];
      const ctx: RunContext = {
        runId: req.input.runId,
        sessionId: req.input.sessionId,
        signal: new AbortController().signal,
        cardsDelivered: 0,
        text: (delta) => {
          texts.push(delta);
        },
        card: async (card) => {
          cards.push(card);
        },
        suggestions: vi.fn(),
        toolStatus: vi.fn(),
      };
      return { result: await port.handle(req, ctx), cards, texts, ctx };
    },
  };
}

function guideCard(route: string): UnnumberedCard {
  return {
    type: 'page_guide',
    schema_version: 1,
    data: { route, text_key: `agent.guide.${route}` },
    fallback_text: copy(`agent.guide.${route}`),
  };
}

const EARNINGS_OFF = ['agent.tools.get_my_earnings.enabled'];
const ORDERS_OFF = ['agent.tools.list_my_orders.enabled', 'agent.tools.explain_order.enabled'];

it.each([
  ['我这笔提现到账了吗', 'withdrawal_progress', 'WithdrawRecords'],
  ['那笔提现到哪了', 'withdrawal_progress', 'WithdrawRecords'],
  ['这笔提现怎么还没到', 'summary', 'WithdrawRecords'],
  ['那单的提现到账了吗', 'withdrawal_progress', 'WithdrawRecords'],
  ['这笔余额什么时候能提', 'summary', 'Wallet'],
  ['这笔收益多少', 'summary', 'Wallet'],
  ['这笔返了吗', 'summary', 'Wallet'],
] as const)(
  '[B3-05f][BR-AI-01] 收益问法不被量词改成订单，工具关闭时出收益对应引导卡：%s',
  async (text, topic, route) => {
    const h = harness(EARNINGS_OFF);
    const output = await h.run(request({ agent_intent: 'earnings_query', topic }, text, MEMBER));
    expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(output.cards).toEqual([guideCard(route)]);
    expect(output.texts).toEqual([]);
    expect(h.deps.continuation.run).not.toHaveBeenCalled();
  },
);

it('[B3-05f][BR-AI-01] 收益工具开启时原样转交模型的收益意图，不转订单', async () => {
  const h = harness();
  const model = { agent_intent: 'earnings_query', topic: 'withdrawal_progress' } as const;
  const req = request(model, '我这笔提现到账了吗', MEMBER);
  const output = await h.run(req);
  expect(output.cards).toEqual([]);
  expect(h.deps.continuation.run).toHaveBeenCalledExactlyOnceWith(model, req, output.ctx);
});

it.each([
  '那单返了吗',
  '这笔订单返了吗',
  '这单到账了吗',
  '昨天买的牛奶返利什么时候结算',
  '刚下单的怎么还没显示',
  '上一单的返利呢',
])('[B3-05f][BR-AI-01] 有订单类名词时仍按订单，工具关闭出 OrderList：%s', async (text) => {
  const h = harness(ORDERS_OFF);
  const output = await h.run(request({ agent_intent: 'earnings_query' }, text, MEMBER));
  expect(output.cards).toEqual([guideCard('OrderList')]);
  expect(h.deps.continuation.run).not.toHaveBeenCalled();
});

it.each([
  ['提现最低多少', 'earnings_query'],
  ['返利一般什么时候结算', 'earnings_query'],
  ['提现手续费是多少', 'earnings_query'],
  ['订单一般多久返利', 'order_query'],
  ['提现一般多久到账', 'earnings_query'],
  ['返利规则是什么', 'order_query'],
] as const)(
  '[B3-05f][BR-AI-01] 服务端判为泛规则时纠正模型的个人查询标签，游客不要求登录：%s',
  async (text, intent) => {
    const h = harness();
    const req = request({ agent_intent: intent }, text, GUEST);
    const output = await h.run(req);
    expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
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
  ['钱包在哪', 'earnings_query', 'Wallet'],
  ['怎么提现', 'earnings_query', 'Wallet'],
  ['订单列表在哪', 'order_query', 'OrderList'],
] as const)(
  '[B3-05f][BR-AI-01] 服务端判为页面位置时纠正个人查询标签，游客也出引导卡：%s',
  async (text, intent, route) => {
    const h = harness();
    const output = await h.run(request({ agent_intent: intent }, text, GUEST));
    expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(output.cards).toEqual([guideCard(route)]);
    expect(h.deps.continuation.run).not.toHaveBeenCalled();
  },
);

it.each([
  ['我的提现一般多久到账', 'rule_qa', 'agent.earnings.need_login'],
  ['这笔提现一般多久到账', 'earnings_query', 'agent.earnings.need_login'],
  ['那单一般多久返', 'rule_qa', 'agent.need_login'],
  ['我的订单最低返多少', 'rule_qa', 'agent.need_login'],
  ['我余额还有多少', 'rule_qa', 'agent.earnings.need_login'],
  ['合成查询请求', 'order_query', 'agent.need_login'],
] as const)(
  '[B3-05f][BR-AI-01] 指向本人数据或判定不明时保持个人查询，游客出 auth_required：%s',
  async (text, intent, key) => {
    const h = harness();
    const output = await h.run(request({ agent_intent: intent }, text, GUEST));
    expect(output.result).toEqual({ kind: 'done', finishReason: 'auth_required' });
    expect(output.cards.map((card) => card.type)).toEqual(['auth_required']);
    expect(output.texts).toEqual([copy(key)]);
    expect(h.deps.continuation.run).not.toHaveBeenCalled();
  },
);
