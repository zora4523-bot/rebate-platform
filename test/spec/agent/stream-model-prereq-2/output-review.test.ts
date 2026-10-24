// B3-03p §9 items 5–6 · BR-AI-18 on the output side: createStreamOutputReview's sentence review of
// one run is bounded by agent.safety.timeout_ms of that run's app, read through the content
// configuration port for each run (two apps never share a value; missing: 1000 ms; invalid: the
// configuration layer's default), with the wait for that read inside the same deadline. A read
// that fails or never answers is fail-close ('timeout'). The review request itself hangs unless a
// verdict is scripted (synthetic transport of the stream-review kit, manual time).
import { afterEach, expect, it, vi } from 'vitest';
import { createStreamOutputReview } from '../../../../apps/api/src/modules/agent/stream/mount/output-review.ts';
import { TIMEOUT_KEY } from '../stream-model-prereq/kit.ts';
import { requestContent } from '../stream-review/kit.ts';
import { APP_A, APP_B, expectReviewBudget, flush, reviewRig, track } from './kit.ts';

afterEach(() => vi.unstubAllGlobals());

function runSignal(): AbortSignal {
  return new AbortController().signal;
}

const TIMED_OUT = { done: true, value: 'timeout', error: undefined };

it('[AC-B3-03p#8][BR-AI-18] 输出按句审核时限按本 run 的 app 读 agent.safety.timeout_ms：两个 app 配不同值各自生效，交替请求互不串用，请求走输出侧审核服务', async () => {
  const s = reviewRig({ values: { [APP_A]: 300, [APP_B]: 2500 } });
  const output = createStreamOutputReview(s.deps);
  for (const [appId, budget] of [
    [APP_A, 300],
    [APP_B, 2500],
    [APP_A, 300],
    [APP_B, 2500],
  ] as const) {
    const reads = s.configValue.mock.calls.length;
    const sent = s.calls.length;
    await expectReviewBudget(output.forRun(appId, runSignal()), s.time, budget, appId);
    expect(s.configValue.mock.calls.length, `${appId}: read for this run`).toBeGreaterThan(reads);
    expect(s.configValue).toHaveBeenLastCalledWith(appId, TIMEOUT_KEY);
    expect(s.calls.length, `${appId}: one review request`).toBe(sent + 1);
    expect(requestContent(s.calls[sent]!.init).service).toBe('llm_response_moderation');
  }
  expect(s.unexpectedFetch).not.toHaveBeenCalled();
});

it('[AC-B3-03p#9][BR-AI-18] 输出审核：未配置 agent.safety.timeout_ms 的 app 用默认 1000ms，与已配置的 app 互不影响', async () => {
  const s = reviewRig({ values: { [APP_A]: 300 } });
  const output = createStreamOutputReview(s.deps);
  await expectReviewBudget(output.forRun(APP_B, runSignal()), s.time, 1000, APP_B);
  expect(s.configValue).toHaveBeenCalledWith(APP_B, TIMEOUT_KEY);
  await expectReviewBudget(output.forRun(APP_A, runSignal()), s.time, 300, APP_A);
  await expectReviewBudget(output.forRun(APP_B, runSignal()), s.time, 1000, APP_B);
});

// One-element rows: it.each spreads an array row, and [1500] must reach the test as an array.
const INVALID: [unknown][] = [[0], [-100], ['1500'], [null], [false], [[1500]], [{ ms: 1500 }]];

it.each(INVALID)(
  '[AC-B3-03p#10][BR-AI-18] 输出审核：非法值 %j 按配置层既有口径取默认 1000ms，不放宽为无限等待；另一 app 的合法值照常生效',
  async (value) => {
    const s = reviewRig({ values: { [APP_A]: value, [APP_B]: 2500 } });
    const output = createStreamOutputReview(s.deps);
    await expectReviewBudget(output.forRun(APP_A, runSignal()), s.time, 1000, APP_A);
    await expectReviewBudget(output.forRun(APP_B, runSignal()), s.time, 2500, APP_B);
    await expectReviewBudget(output.forRun(APP_A, runSignal()), s.time, 1000, APP_A);
  },
);

it('[AC-B3-03p#11][BR-AI-18] 输出审核每次请求按当前 app 现读：同一 app 改值、删除后，下一个 run 即按新值或默认值', async () => {
  const s = reviewRig({ values: { [APP_A]: 300 } });
  const output = createStreamOutputReview(s.deps);
  await expectReviewBudget(output.forRun(APP_A, runSignal()), s.time, 300, 'first');
  s.table.set(APP_A, 1800);
  await expectReviewBudget(output.forRun(APP_A, runSignal()), s.time, 1800, 'changed');
  s.table.delete(APP_A);
  await expectReviewBudget(output.forRun(APP_A, runSignal()), s.time, 1000, 'deleted');
  s.table.set(APP_A, 450);
  await expectReviewBudget(output.forRun(APP_A, runSignal()), s.time, 450, 'set again');
});

it.each([
  [200, 300, 300],
  [200, 2500, 2500],
  [900, 2500, 2500],
  [900, 300, 900],
] as const)(
  '[AC-B3-03p#12][BR-AI-18] 输出审核：读取配置耗时 %i ms、配 %i ms 时读取等待计入同一时限，第 %i ms 判 timeout（不是读取时间加时限）',
  async (read, budget, at) => {
    const s = reviewRig({ values: { [APP_A]: budget }, read });
    const port = createStreamOutputReview(s.deps).forRun(APP_A, runSignal());
    const start = s.time.t;
    const box = track(port.review('合成说明。'));
    if (at > read) {
      await s.time.to(start + at - 1);
      expect(box.done, `still under review at ${String(at - 1)} ms`).toBe(false);
    }
    await s.time.to(start + at);
    await flush();
    expect(box, `timeout at ${String(at)} ms`).toEqual(TIMED_OUT);
  },
);

it('[AC-B3-03p#13][BR-AI-18] 输出审核：同一 run 的每次审核各有本 app 的完整时限（再审一次不与前一句共用到点时间）', async () => {
  const s = reviewRig({ values: { [APP_A]: 300, [APP_B]: 2500 } });
  const output = createStreamOutputReview(s.deps);
  const port = output.forRun(APP_A, runSignal());
  await expectReviewBudget(port, s.time, 300, 'first sentence');
  await expectReviewBudget(port, s.time, 300, 'review again before the run ends');
  const other = output.forRun(APP_B, runSignal());
  await expectReviewBudget(other, s.time, 2500, 'other app, first sentence');
  await expectReviewBudget(other, s.time, 2500, 'other app, again');
});

it.each([
  ['none', 'pass'],
  ['high', 'block'],
  ['medium', 'block'],
] as const)(
  '[AC-B3-03p#14][BR-AI-18] 输出审核在本 app 时限内返回时照常映射（RiskLevel %s → %s），请求走输出侧审核服务',
  async (answer, verdict) => {
    const s = reviewRig({ values: { [APP_A]: 300 }, answers: [answer] });
    const port = createStreamOutputReview(s.deps).forRun(APP_A, runSignal());
    expect(await port.review('合成说明。')).toBe(verdict);
    expect(s.calls).toHaveLength(1);
    expect(requestContent(s.calls[0]!.init).service).toBe('llm_response_moderation');
    expect(s.configValue).toHaveBeenCalledWith(APP_A, TIMEOUT_KEY);
    expect(s.unexpectedFetch).not.toHaveBeenCalled();
  },
);

it.each(['reject', 'hang'] as const)(
  '[AC-B3-03p#15][BR-AI-18] 输出审核：读取 agent.safety.timeout_ms 失败（%s）按 fail-close 判 timeout，最迟在默认 1000ms 内，不放宽为无限等待',
  async (read) => {
    const s = reviewRig({ values: { [APP_A]: 300 }, read });
    const port = createStreamOutputReview(s.deps).forRun(APP_A, runSignal());
    const start = s.time.t;
    const box = track(port.review('合成说明。'));
    await s.time.to(start + 1000);
    await flush();
    expect(box).toEqual(TIMED_OUT);
    expect(s.configValue).toHaveBeenCalledWith(APP_A, TIMEOUT_KEY);
  },
);

it.each([
  { appEnv: 'test' },
  { appEnv: 'local' },
  { credentials: undefined },
  { endpoint: 'http://review.example.invalid/' },
] as const)(
  '[AC-B3-03p#16][BR-AI-18] 输出审核不在线（%j）时每句立即判 timeout，不发任何网络请求',
  async (patch) => {
    const s = reviewRig({ values: { [APP_A]: 300 }, answers: ['none'], patch });
    const port = createStreamOutputReview(s.deps).forRun(APP_A, runSignal());
    const box = track(port.review('合成说明。'));
    await flush();
    expect(box).toEqual(TIMED_OUT);
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.unexpectedFetch).not.toHaveBeenCalled();
  },
);
