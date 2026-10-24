// B3-03p §9 item 6 · BR-AI-18 on the input side: the wait for agent.safety.timeout_ms counts toward
// the same review deadline (B3-03n read it first and then started a full budget, so a slow read
// stretched the limit). A message is refused as review unavailable (agent.refuse.safety_unavailable,
// ending input_review_timeout: not counted, refunded) at the configured value after the check
// started, or as soon as a slower read returns; a read that fails or never answers stays
// fail-close. The review request itself hangs (synthetic transport of the stream-review kit).
import { afterEach, expect, it, vi } from 'vitest';
import { createStreamReview } from '../../../../apps/api/src/modules/agent/stream/mount/review.ts';
import { inputFor, TIMEOUT_KEY, UNAVAILABLE } from '../stream-model-prereq/kit.ts';
import { APP_A, flush, reviewRig, track, type ReviewRig } from './kit.ts';

afterEach(() => vi.unstubAllGlobals());

const REFUSED = { done: true, value: UNAVAILABLE, error: undefined };

function startCheck(s: ReviewRig, appId: string) {
  const check = createStreamReview(s.deps).inputCheck;
  return track(check.check(inputFor(appId), new AbortController().signal));
}

it.each([
  [200, 300],
  [200, 2500],
  [900, 2500],
] as const)(
  '[AC-B3-03p#18][BR-AI-18] 输入审核：读取配置耗时 %i ms、配 %i ms 时读取等待计入同一时限，到配置值即按审核不可用拒绝并退额度（不是读取时间加时限）',
  async (read, budget) => {
    const s = reviewRig({ values: { [APP_A]: budget }, read });
    const start = s.time.t;
    const box = startCheck(s, APP_A);
    await s.time.to(start + budget - 1);
    expect(box.done, `still under review at ${String(budget - 1)} ms`).toBe(false);
    await s.time.to(start + budget);
    await flush();
    expect(box, `refused at ${String(budget)} ms`).toEqual(REFUSED);
    expect(s.configValue).toHaveBeenCalledWith(APP_A, TIMEOUT_KEY);
  },
);

it.each([
  [900, 300],
  [700, 500],
] as const)(
  '[AC-B3-03p#19][BR-AI-18] 输入审核：配置读取（%i ms）慢于配置值（%i ms）时，读到值即按审核不可用拒绝并退额度，不再另等一整个时限',
  async (read, budget) => {
    const s = reviewRig({ values: { [APP_A]: budget }, read });
    const start = s.time.t;
    const box = startCheck(s, APP_A);
    await s.time.to(start + read);
    await flush();
    expect(box, `refused once the value is read at ${String(read)} ms`).toEqual(REFUSED);
  },
);

it('[AC-B3-03p#20][BR-AI-18] 输入审核：读取等待计入时限之外，读取失败立即、读取不返回最迟默认 1000ms 仍按 fail-close 拒绝并退额度；恢复后下一条按配置值', async () => {
  const s = reviewRig({ values: { [APP_A]: 600 }, read: 400 });
  let start = s.time.t;
  let box = startCheck(s, APP_A);
  await s.time.to(start + 599);
  expect(box.done, 'slow read: still under review at 599 ms').toBe(false);
  await s.time.to(start + 600);
  await flush();
  expect(box, 'slow read: refused at 600 ms').toEqual(REFUSED);

  s.mode.read = 'reject';
  box = startCheck(s, APP_A);
  await flush();
  expect(box, 'failed read: refused at once').toEqual(REFUSED);

  s.mode.read = 'hang';
  start = s.time.t;
  box = startCheck(s, APP_A);
  await s.time.to(start + 1000);
  await flush();
  expect(box, 'read never answers: refused by the default 1000 ms').toEqual(REFUSED);

  s.mode.read = 0;
  start = s.time.t;
  box = startCheck(s, APP_A);
  await s.time.to(start + 599);
  expect(box.done, 'recovered: still under review at 599 ms').toBe(false);
  await s.time.to(start + 600);
  await flush();
  expect(box, 'recovered: refused at 600 ms').toEqual(REFUSED);
});
