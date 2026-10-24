// B3-03p §10 · BR-AI-18 on the output side with runs in flight at the same time: the sentence
// review that createStreamOutputReview(...).forRun(appId, signal) returns stays bound to that run's
// app and signal. Ports of two apps are taken before any review starts, in both orders, and their
// reviews interleave; two runs of one app overlap. Each review must answer by its own app's
// agent.safety.timeout_ms counted from its own start, whatever the other run does meanwhile.
// The synthetic transport answers by review text (hold, pass, or pass when the test opens a gate),
// so verdicts never depend on request order; time is manual (stream-review kit).
import { afterEach, expect, it, vi } from 'vitest';
import type { SentenceReviewPort } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import type { AliyunReviewFetch } from '../../../../apps/api/src/modules/agent/guard/review/index.ts';
import type { RunSentenceReviewPort } from '../../../../apps/api/src/modules/agent/orchestrator/core/ports.ts';
import { createStreamOutputReview } from '../../../../apps/api/src/modules/agent/stream/mount/output-review.ts';
import { TIMEOUT_KEY } from '../stream-model-prereq/kit.ts';
import { requestContent } from '../stream-review/kit.ts';
import { APP_A, APP_B, flush, reviewRig, track, type Box, type ReviewRig } from './kit.ts';

afterEach(() => vi.unstubAllGlobals());

type App = typeof APP_A | typeof APP_B;

const BUDGET = { [APP_A]: 300, [APP_B]: 2000 } as const;

const HOLD = '合成说明挂起。';
const PASS = '合成说明通过。';
const LATE = '合成说明稍后通过。';

const TIMED_OUT = { done: true, value: 'timeout', error: undefined };
const PASSED = { done: true, value: 'pass', error: undefined };

function runSignal(): AbortSignal {
  return new AbortController().signal;
}

/** A promise the test opens by hand (no time involved). */
function gate(): { readonly opened: Promise<void>; open(): void } {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { opened, open: () => open() };
}

type Reply = 'none' | 'hang' | Promise<void>;

/**
 * Synthetic output review transport keyed by the reviewed text: 'none' answers RiskLevel none at
 * once, 'hang' never answers, a promise answers none once it resolves. Unknown text hangs.
 */
function contentFetch(replies: ReadonlyMap<string, Reply>) {
  const seen: { service: string | null; content: string }[] = [];
  const fetch = vi.fn<AliyunReviewFetch>(async (_url, init) => {
    const request = requestContent(init);
    seen.push(request);
    const reply = replies.get(request.content) ?? 'hang';
    if (reply === 'hang') return new Promise<never>(() => {});
    if (reply !== 'none') await reply;
    return {
      status: 200,
      text: async () => JSON.stringify({ Code: 200, Data: { RiskLevel: 'none' } }),
    };
  });
  return { fetch, seen };
}

/** Ports of one run per app, all taken before any review starts, in the given order. */
function take(output: RunSentenceReviewPort, aFirst: boolean): Record<App, SentenceReviewPort> {
  if (aFirst) {
    const a = output.forRun(APP_A, runSignal());
    const b = output.forRun(APP_B, runSignal());
    return { [APP_A]: a, [APP_B]: b };
  }
  const b = output.forRun(APP_B, runSignal());
  const a = output.forRun(APP_A, runSignal());
  return { [APP_A]: a, [APP_B]: b };
}

interface Probe {
  readonly label: string;
  readonly box: Box<unknown>;
  readonly start: number;
  readonly budget: number;
}

/**
 * Each held review is still running 1 ms before start + budget and answers 'timeout' exactly at
 * start + budget (probes are walked in the order their deadlines fall).
 */
async function expectEachBudget(time: ReviewRig['time'], probes: readonly Probe[]): Promise<void> {
  const byDeadline = [...probes].sort((x, y) => x.start + x.budget - (y.start + y.budget));
  for (const probe of byDeadline) {
    const due = probe.start + probe.budget;
    await time.to(due - 1);
    expect(
      probe.box.done,
      `${probe.label}: still under review at ${String(probe.budget - 1)} ms`,
    ).toBe(false);
    await time.to(due);
    await flush();
    expect(probe.box, `${probe.label}: timeout at ${String(probe.budget)} ms`).toEqual(TIMED_OUT);
  }
}

const INTERLEAVED = ([true, false] as const).flatMap((aFirst) =>
  ([APP_A, APP_B] as const).flatMap((first) =>
    ([0, 120] as const).map((read) => [aFirst ? 'A→B' : 'B→A', first, read] as const),
  ),
);

it.each(INTERLEAVED)(
  '[AC-B3-03p#22][BR-AI-18] 输出审核两个 app 交错进行（forRun 顺序 %s，先审 %s，配置读取 %i ms）：一个 app 的一句挂起时另一个 app 的审核开始并通过；两句都挂起时各按本 app 的时限（300 / 2000ms）从各自开始计时超时，互不串用',
  async (order, first, read) => {
    const wire = contentFetch(
      new Map<string, Reply>([
        [HOLD, 'hang'],
        [PASS, 'none'],
      ]),
    );
    const s = reviewRig({
      values: { [APP_A]: BUDGET[APP_A], [APP_B]: BUDGET[APP_B] },
      read,
      patch: { fetch: wire.fetch },
    });
    const output = createStreamOutputReview(s.deps);
    const aFirst = order === 'A→B';
    const second: App = first === APP_A ? APP_B : APP_A;

    // One app's sentence hangs; the other app's run starts its review meanwhile and passes.
    const ports = take(output, aFirst);
    const t0 = s.time.t;
    const held = track(ports[first].review(HOLD));
    await s.time.to(t0 + 100);
    const passed = track(ports[second].review(PASS));
    await s.time.to(t0 + 100 + read);
    await flush();
    expect(passed, `${second} passes while ${first} is held`).toEqual(PASSED);
    expect(held.done, `${first} still held after ${second} passed`).toBe(false);
    await expectEachBudget(s.time, [
      { label: `${first} held`, box: held, start: t0, budget: BUDGET[first] },
    ]);

    // Both held, the second one 100 ms later: each times out by its own app's value.
    const again = take(output, aFirst);
    const t1 = s.time.t;
    const early = track(again[first].review(HOLD));
    await s.time.to(t1 + 100);
    const late = track(again[second].review(HOLD));
    await expectEachBudget(s.time, [
      { label: `${first} (started first)`, box: early, start: t1, budget: BUDGET[first] },
      {
        label: `${second} (started 100 ms later)`,
        box: late,
        start: t1 + 100,
        budget: BUDGET[second],
      },
    ]);

    expect(s.configValue).toHaveBeenCalledWith(APP_A, TIMEOUT_KEY);
    expect(s.configValue).toHaveBeenCalledWith(APP_B, TIMEOUT_KEY);
    expect(wire.seen, 'one output review request per review').toHaveLength(4);
    expect(wire.seen.map((request) => request.service)).toEqual(
      Array.from({ length: 4 }, () => 'llm_response_moderation'),
    );
    expect(s.unexpectedFetch).not.toHaveBeenCalled();
  },
);

it.each([0, 120] as const)(
  '[AC-B3-03p#23][BR-AI-18] 输出审核同一 app 两个并发 run 各自独立（配置读取 %i ms）：错开开始的两句各从自己开始计 300ms 超时；一个 run 超时时另一个 run 在途的审核照常通过；一个 run 的 signal 中止不提前结束另一个 run 的审核',
  async (read) => {
    const later = gate();
    const wire = contentFetch(
      new Map<string, Reply>([
        [HOLD, 'hang'],
        [PASS, 'none'],
        [LATE, later.opened],
      ]),
    );
    const s = reviewRig({ values: { [APP_A]: 300 }, read, patch: { fetch: wire.fetch } });
    const output = createStreamOutputReview(s.deps);

    // Two runs, both held, the second one 200 ms later.
    const one = output.forRun(APP_A, runSignal());
    const two = output.forRun(APP_A, runSignal());
    const t0 = s.time.t;
    const first = track(one.review(HOLD));
    await s.time.to(t0 + 200);
    const second = track(two.review(HOLD));
    await expectEachBudget(s.time, [
      { label: 'run one', box: first, start: t0, budget: 300 },
      { label: 'run two (started 200 ms later)', box: second, start: t0 + 200, budget: 300 },
    ]);

    // Run three times out while run four's review is in flight; run four then passes.
    const three = output.forRun(APP_A, runSignal());
    const four = output.forRun(APP_A, runSignal());
    const t1 = s.time.t;
    const timedOut = track(three.review(HOLD));
    await s.time.to(t1 + 100);
    const inFlight = track(four.review(LATE));
    await s.time.to(t1 + 300);
    await flush();
    expect(timedOut, 'run three: timeout at 300 ms').toEqual(TIMED_OUT);
    expect(inFlight.done, 'run four: still under review when run three timed out').toBe(false);
    await s.time.to(t1 + 350);
    later.open();
    await flush();
    expect(inFlight, 'run four: passes within its own 300 ms').toEqual(PASSED);

    // Aborting run five's signal leaves run six's review to its own deadline.
    const stop = new AbortController();
    const five = output.forRun(APP_A, stop.signal);
    const six = output.forRun(APP_A, runSignal());
    const t2 = s.time.t;
    track(five.review(HOLD));
    const kept = track(six.review(HOLD));
    await s.time.to(t2 + 50);
    stop.abort();
    await flush();
    await expectEachBudget(s.time, [
      { label: 'run six after run five was aborted', box: kept, start: t2, budget: 300 },
    ]);

    expect(s.configValue).toHaveBeenCalledWith(APP_A, TIMEOUT_KEY);
    expect(s.unexpectedFetch).not.toHaveBeenCalled();
  },
);
