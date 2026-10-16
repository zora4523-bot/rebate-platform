import { expect, it } from 'vitest';
import type { ReviewVerdict } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import { flush, observe, proceed, refused, setup } from './kit.ts';

it.each(['合成保温杯', '感冒该吃什么药', '帮我找电子烟', '打开提现记录，withdrawal_id=W123'])(
  '[AC-B3-05d#1][BR-AI-18][BR-AI-01] 审核 block 优先于关键词与来源判断：%s',
  async (message) => {
    const r = setup('block');
    refused(await r.check(message), 'agent.refuse.unsafe');
    expect(r.review).toHaveBeenCalledTimes(1);
  },
);

it.each(['timeout', new Error('synthetic review unavailable')] as const)(
  '[AC-B3-05d#2][BR-AI-18] 审核超时或抛错按服务端失败退还：%s',
  async (verdict) => {
    const r = setup(verdict);
    refused(await r.check('感冒该吃什么药，帮我找电子烟'), 'agent.refuse.safety_unavailable', true);
    expect(r.review).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B3-05d#3][BR-AI-18] 未收到 pass 前不能提前按本地关键词拒答', async () => {
  const response = Promise.withResolvers<ReviewVerdict>();
  const r = setup(() => response.promise);
  const pending = r.check('感冒该吃什么药');
  const state = observe(pending);
  await flush();
  expect(r.review).toHaveBeenCalledTimes(1);
  expect(state.settled).toBe('pending');
  response.resolve('pass');
  refused(await pending, 'agent.refuse.advice');
});

it.each([
  { label: '默认 1000ms（BR-AI-18）', configured: undefined, deadline: 1000 },
  { label: '注入配置 250ms（合成配置）', configured: 250, deadline: 250 },
])(
  '[AC-B3-05d#4][BR-AI-18] 审核永不返回仍有 fail-close 截止：$label',
  async ({ configured, deadline }) => {
    const r = setup(() => new Promise<ReviewVerdict>(() => {}), configured);
    const state = observe(r.check('合成保温杯'));
    await r.scheduler.advance(deadline - 1);
    expect(state.settled).toBe('pending');
    await r.scheduler.advance(1);
    expect(state.settled).toBe('resolved');
    expect(state.value).toEqual({
      kind: 'refuse',
      textKey: 'agent.refuse.safety_unavailable',
      finishReason: 'safety',
      ending: 'input_review_timeout',
    });
    expect(r.review).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B3-05d#5][BR-AI-18] 截止后的 pass 不能把已退还拒答改成 proceed', async () => {
  const response = Promise.withResolvers<ReviewVerdict>();
  const r = setup(() => response.promise);
  const state = observe(r.check('合成保温杯'));
  await r.scheduler.advance(1000);
  expect(state.settled).toBe('resolved');
  const snapshot = structuredClone(state.value);
  response.resolve('pass');
  await flush();
  expect(state.value).toEqual(snapshot);
  expect(state.value).toMatchObject({ kind: 'refuse', ending: 'input_review_timeout' });
});

it('[AC-B3-05d#6][BR-AI-18][BR-AI-05] 审核使用脱敏形态，proceed 保留服务端占位表', async () => {
  // 08 未规定审核原文/脱敏文本；按任务书 §9.1 对 plan.md 的补充口径用模型脱敏形态。
  const r = setup();
  const result = proceed(await r.check('查订单 000000000000001', '查订单 ****0001'));
  expect(r.review).toHaveBeenCalledExactlyOnceWith('查订单 <num_1>');
  expect(result.modelText).toBe('查订单 <num_1>');
  expect(result.placeholders).toEqual({ '<num_1>': '000000000000001' });
  expect(result.modelText).not.toMatch(/\d{11,}/u);
  expect(result.modelText).not.toContain('****0001');
  expect(result.paramsRequested).toBe(true);
});
