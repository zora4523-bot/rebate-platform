// B3-03p §9 item 5 · BR-AI-18 in the core: with AgentRunBodyDeps.outputReview, every run asks it
// for the sentence review of that run's app (forRun(appId, the run's signal), once per run) and
// guards the model text with it instead of the review fixed at build. A timeout there follows
// BR-AI-18 (held, reviewed once more before the run ends, replaced by agent.refuse.safety_timeout,
// cards kept); a pass delivers the text.
import { expect, it, vi } from 'vitest';
import type { SentenceReviewPort } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import { createAgentRunBody } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { RunSentenceReviewPort } from '../../../../apps/api/src/modules/agent/orchestrator/core/ports.ts';
import {
  inputFor,
  list,
  receiptContext,
  searchTools,
  syntheticBody,
  type Round,
} from '../stream-model-prereq/kit.ts';
import { APP_A, APP_B } from './kit.ts';

const ROUNDS: Round[] = [
  { calls: [{ name: 'search_products', args: { q: '合成保温杯' } }] },
  { text: '合成说明。' },
];

it('[AC-B3-03p#17][BR-AI-18] core 每个 run 按本 run 的 app 经 outputReview.forRun 取按句审核：超时的 app 文本替换为 safety_timeout、卡片照常；通过的 app 文本照常；不再用建构时固定的 review', async () => {
  const fixed = vi.fn<SentenceReviewPort['review']>(async () => 'block');
  const forRun = vi.fn<RunSentenceReviewPort['forRun']>((appId) => ({
    review: async () => (appId === APP_A ? 'timeout' : 'pass'),
  }));
  for (const [appId, text] of [
    [APP_A, '固定文案:agent.refuse.safety_timeout'],
    [APP_B, '合成说明。'],
    [APP_A, '固定文案:agent.refuse.safety_timeout'],
  ] as const) {
    const value = inputFor(appId);
    const out = receiptContext({ runId: value.runId, sessionId: value.sessionId });
    const { tools } = searchTools([
      { kind: 'ok', modelView: { items: [] }, cards: [list('synthetic-set-1', ['tb:synthetic-a'])] },
    ]);
    const asked = forRun.mock.calls.length;
    const result = await createAgentRunBody(
      syntheticBody(tools, ROUNDS, { review: { review: fixed }, outputReview: { forRun } }),
    )(value)(out.ctx);

    expect(result, appId).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(forRun.mock.calls.length - asked, `${appId}: one sentence review per run`).toBe(1);
    expect(forRun).toHaveBeenLastCalledWith(appId, out.controller.signal);
    expect(out.frames.map((frame) => frame.type), appId).toEqual(['product_list']);
    expect(out.texts.join(''), appId).toBe(text);
  }
  expect(fixed).not.toHaveBeenCalled();
});
