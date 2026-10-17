import { expect, it } from 'vitest';
import { productList } from '../orchestrator-core/kit.ts';
import { fallbackNotice, kit, OPTIONS, request } from './kit.ts';

it.each(['reference', 'price', 'platform'] as const)(
  '[AC-B3-05f#31][BR-AI-01] clarify 的 %s 槽位首次只出三个服务端快捷选项',
  async (slot) => {
    const h = kit();
    const output = await h.run(request({ agent_intent: 'clarify', slot }));
    expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(output.suggestions).toEqual([OPTIONS]);
    expect(output.cards).toEqual([]);
    expect(output.texts.join('')).not.toContain('agent_intent');
    expect(h.deps.clarification.takeOnce).toHaveBeenCalledExactlyOnceWith(
      {
        appId: 'synthetic-app',
        sessionId: 'synthetic-session',
        chainId: 'synthetic-chain',
      },
      slot,
    );
    expect(h.deps.clarification.withoutCondition).not.toHaveBeenCalled();
    expect(h.deps.clarification.latestProducts).not.toHaveBeenCalled();
  },
);

// Orchestrator mechanical fix (2026-10-17): the shared B3-05b productList fixture carries a
// quoted_at ending in Z, while the contract requires +08:00; the card is otherwise unchanged.
function contractTime<T>(card: T): T {
  return JSON.parse(
    JSON.stringify(card).replace(/"quoted_at":"([^"]+?)\.000Z"/g, '"quoted_at":"$1.000+08:00"'),
  ) as T;
}

it('[AC-B3-05f#32][BR-AI-01] 同一链跨 run 指代仍不明时取最新结果第一张，不再追问', async () => {
  const h = kit();
  const req = request({ agent_intent: 'clarify', slot: 'reference' });
  const first = await h.run(req);
  expect(first.suggestions).toEqual([OPTIONS]);
  // Each product is already assembled as a single-item product_list by the result-set port.
  const newestFirst = { ...contractTime(productList(1)), fallback_text: '合成最新结果第一商品' };
  const newestSecond = { ...contractTime(productList(1)), fallback_text: '合成最新结果第二商品' };
  h.state.products = [newestFirst, newestSecond];
  const next = { ...req, input: { ...req.input, runId: 'synthetic-next-run' } };
  const output = await h.run(next);
  expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(output.suggestions).toEqual([]);
  expect(output.cards).toHaveLength(2);
  expect(output.cards).toContainEqual(newestFirst);
  expect(output.cards).toContainEqual(fallbackNotice('reference'));
  expect(output.cards).not.toContainEqual(newestSecond);
  expect(h.deps.clarification.latestProducts).toHaveBeenCalledWith({
    appId: 'synthetic-app',
    sessionId: 'synthetic-session',
    chainId: 'synthetic-chain',
  });
  expect(h.deps.clarification.options).toHaveBeenCalledTimes(1);
  expect(h.deps.clarification.withoutCondition).not.toHaveBeenCalled();
});

it.each(['price', 'platform'] as const)(
  '[AC-B3-05f#33][BR-AI-01] 同一链的 %s 条件仍无法解析时丢弃该条件继续检索并出 notice',
  async (slot) => {
    const h = kit();
    const req = request({ agent_intent: 'clarify', slot });
    expect((await h.run(req)).suggestions).toEqual([OPTIONS]);
    const next = { ...req, input: { ...req.input, runId: 'synthetic-next-run' } };
    const output = await h.run(next);
    expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(output.suggestions).toEqual([]);
    expect(output.cards).toEqual([fallbackNotice(slot)]);
    expect(h.deps.clarification.withoutCondition).toHaveBeenCalledExactlyOnceWith(
      slot,
      next,
      output.ctx,
    );
    expect(h.deps.clarification.latestProducts).not.toHaveBeenCalled();
    expect(h.deps.clarification.options).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B3-05f#34][BR-AI-01] 同一链不同槽位各可追问一次，新链重新计数', async () => {
  const h = kit();
  for (const slot of ['reference', 'price', 'platform'] as const) {
    const output = await h.run(request({ agent_intent: 'clarify', slot }));
    expect(output.suggestions).toEqual([OPTIONS]);
  }
  h.state.chainId = 'synthetic-new-chain';
  const output = await h.run(request({ agent_intent: 'clarify', slot: 'price' }));
  expect(output.suggestions).toEqual([OPTIONS]);
  expect(h.deps.clarification.withoutCondition).not.toHaveBeenCalled();
  expect(h.deps.clarification.takeOnce).toHaveBeenLastCalledWith(
    {
      appId: 'synthetic-app',
      sessionId: 'synthetic-session',
      chainId: 'synthetic-new-chain',
    },
    'price',
  );
});

it.each(['app', 'session'])(
  '[AC-B3-05f#35][BR-AI-01] 追问次数不能串到另一个 %s',
  async (change) => {
    const h = kit();
    const req = request({ agent_intent: 'clarify', slot: 'price' });
    expect((await h.run(req)).suggestions).toEqual([OPTIONS]);
    const next = {
      ...req,
      input: {
        ...req.input,
        sessionId: change === 'session' ? 'synthetic-other-session' : req.input.sessionId,
        caller: {
          ...req.input.caller,
          appId: change === 'app' ? 'synthetic-other-app' : req.input.caller.appId,
        },
      },
    };
    expect((await h.run(next)).suggestions).toEqual([OPTIONS]);
    expect(h.deps.clarification.withoutCondition).not.toHaveBeenCalled();
  },
);
