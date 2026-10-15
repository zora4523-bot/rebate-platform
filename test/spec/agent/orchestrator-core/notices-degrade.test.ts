import { expect, it } from 'vitest';
import { FLASH, PLUS, input, notice, proceed, productList, setup } from './kit.ts';

it('[AC-B3-05b#53][BR-AI-14][BR-AI-06] notices 已发后预算用尽仍降级，提示只发一次', async () => {
  // BR-AI-14 / plan U-11: input notices are not delivered model/tool content.
  const titleNotice = {
    ...notice('合成标题提示'),
    data: { level: 'info' as const, text_key: 'agent.notice.title_based', actions: [] },
  };
  const prepared = proceed({ notices: [titleNotice] });
  const r = setup([], { budget: true, proceed: prepared });
  const card = productList(1);
  const result = { kind: 'done', finishReason: 'budget' } as const;
  r.degraded.mockImplementation(async (request, ctx) => {
    expect(request).toEqual({ reason: 'budget', input: input(), proceed: prepared });
    expect(ctx.signal).toBe(r.ctx.signal);
    expect(r.content()).toEqual([{ kind: 'card', card: titleNotice }]);
    expect(r.ctx.cardsDelivered).toBe(1);
    await ctx.card(card);
    return result;
  });

  expect(await r.run()).toEqual(result);
  expect(r.degraded).toHaveBeenCalledTimes(1);
  expect(r.complete).toHaveBeenCalledTimes(1);
  expect(r.requests).toEqual([]);
  expect(r.execute).not.toHaveBeenCalled();
  expect(r.events).toEqual([
    { kind: 'card', card: titleNotice },
    { kind: 'card', card },
  ]);
  r.replayed();
});

it('[AC-B3-05b#54][BR-AI-14][BR-AI-06] notices 已发后主备模型都失败仍降级，提示只发一次', async () => {
  const titleNotice = {
    ...notice('合成标题提示'),
    data: { level: 'info' as const, text_key: 'agent.notice.title_based', actions: [] },
  };
  const prepared = proceed({ notices: [titleNotice] });
  const r = setup([], { failAfter: 0, proceed: prepared });
  const card = productList(1);
  const result = { kind: 'done', finishReason: 'fallback' } as const;
  r.degraded.mockImplementation(async (request, ctx) => {
    expect(request).toEqual({ reason: 'models_failed', input: input(), proceed: prepared });
    expect(ctx.signal).toBe(r.ctx.signal);
    expect(r.content()).toEqual([{ kind: 'card', card: titleNotice }]);
    expect(r.ctx.cardsDelivered).toBe(1);
    await ctx.card(card);
    return result;
  });

  expect(await r.run()).toEqual(result);
  expect(r.degraded).toHaveBeenCalledTimes(1);
  expect(r.complete).toHaveBeenCalledTimes(1);
  expect(r.requests.map((request) => request.model)).toEqual([FLASH, PLUS]);
  expect(r.execute).not.toHaveBeenCalled();
  expect(r.events).toEqual([
    { kind: 'card', card: titleNotice },
    { kind: 'card', card },
  ]);
  r.replayed();
});
