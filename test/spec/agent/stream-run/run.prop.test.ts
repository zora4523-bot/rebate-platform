// B3-03b properties (规划/04 §8.1–8.2, 02 §9.2, BR-AI-12, BR-AI-13, BR-AI-23 细则「受理记录与收尾」).
// 1. Any interleaving of body writes (valid and invalid cards), the body's ending (done, error,
//    throw, never returning), a cancel, the guard turning 30501 / 10004, the sink closing and a
//    sink write failing (the first write, meta, included): start() resolves; registry.finish is
//    called once, after settle completed, with a valid terminal that equals the one sent (if any); at most one terminal frame and only last, exactly one
//    when the sink never failed and was not closed before the end; the stream passes the contract
//    checks; settle is called exactly once (also when writes fail); the card count given to settle
//    and returned in RunFinal each equal the card frames the test sink accepted (counted here); the
//    last recorded run facts match; done.quota_left is settle's value; the signal aborts at most
//    once and its reason never changes; nothing is written after start() resolved.
// 2. One trigger at a time (none, cancel, guard 30501 / 10004, close) on a healthy sink: the ending
//    and the terminal frame equal what the scenario predicts (computed here, not taken from output).
// Property bodies only return booleans; one Vitest assertion wraps each fc.assert. Runs and seed
// only from propParams().
import { isDeepStrictEqual } from 'node:util';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import type {
  RunBody,
  RunConfig,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import {
  IDS,
  fixtureCardFrame,
  frameIsValid,
  isTerminal,
  never,
  parseSse,
  rig,
  streamProblems,
  unnumbered,
  type Frame,
} from './kit.ts';

const CONFIG: RunConfig = {
  maxRunMs: 12_000,
  heartbeatMs: 4_000,
  disconnectGraceMs: 3_000,
  guardPollMs: 2_000,
  signalPollMs: 500,
};

type Op = { gap: number; kind: 'text' | 'tool' | 'card' | 'quote' | 'badcard' | 'suggest' };
interface Scenario {
  ops: Op[];
  outcome: 'done' | 'error' | 'throw' | 'hang';
  cancelAt: number | null;
  guard: { at: number; code: 30501 | 10004 } | null;
  closeAt: number | null;
  failAt: number | null;
}

const at = fc.integer({ min: 0, max: 15_000 });
const scenario: fc.Arbitrary<Scenario> = fc.record({
  ops: fc.array(
    fc.record({
      gap: fc.integer({ min: 0, max: 3_000 }),
      kind: fc.constantFrom('text', 'tool', 'card', 'quote', 'badcard', 'suggest'),
    }),
    { maxLength: 6 },
  ),
  outcome: fc.constantFrom('done', 'error', 'throw', 'hang'),
  cancelAt: fc.option(at, { nil: null }),
  guard: fc.option(fc.record({ at, code: fc.constantFrom(30501 as const, 10004 as const) }), {
    nil: null,
  }),
  closeAt: fc.option(at, { nil: null }),
  failAt: fc.option(fc.integer({ min: 1, max: 8 }), { nil: null }),
});

interface Observed {
  ok: boolean;
  frames: Frame[];
  ending: string;
  cardsToSettle: number;
  cardsFinal: number;
  acceptedCards: number;
  lastFacts: unknown;
  healthy: boolean;
}

async function observe(s: Scenario): Promise<Observed | undefined> {
  const r = rig({ config: CONFIG, acceptedBeforeMs: 1_000 });
  r.sink.failAt = s.failAt;
  let aborts = 0;
  let firstReason: unknown = undefined;
  let signal: AbortSignal | undefined;
  const body: RunBody = async (ctx) => {
    signal = ctx.signal;
    ctx.signal.addEventListener('abort', () => {
      aborts += 1;
      if (aborts === 1) firstReason = ctx.signal.reason;
    });
    for (const op of s.ops) {
      await r.time.sleep(op.gap);
      try {
        if (op.kind === 'text') ctx.text('继续为你查询');
        if (op.kind === 'tool') ctx.toolStatus('search_products', 'start', '正在查询京东商品');
        if (op.kind === 'card') await ctx.card(unnumbered(fixtureCardFrame('product_list')));
        if (op.kind === 'quote') await ctx.card(unnumbered(fixtureCardFrame('rebate_quote')));
        if (op.kind === 'suggest') ctx.suggestions([{ text: '换一批', send_text: '请换一批商品' }]);
        if (op.kind === 'badcard') {
          await ctx.card({ type: 'notice', schema_version: 1, data: {}, fallback_text: '' });
        }
      } catch {
        // refused writes are the body's problem; the run goes on
      }
    }
    if (s.outcome === 'hang') return never();
    if (s.outcome === 'throw') throw new Error('boom');
    if (s.outcome === 'error') {
      return {
        kind: 'error',
        error: { code: 50302, msg: 'AI 暂不可用', retryable: true, fallback: 'search_page' },
      };
    }
    return { kind: 'done', finishReason: 'stop' };
  };
  const p = r.manager.start(r.start, body);
  let endedAt: number | null = null;
  p.then(
    () => (endedAt = r.time.t),
    () => undefined,
  );
  const later = (ms: number | null, act: () => unknown): void => {
    if (ms === null) return;
    r.time
      .sleep(ms)
      .then(act)
      .catch(() => undefined);
  };
  later(s.cancelAt, () => r.manager.cancel(IDS.run, 'u:u-demo-1'));
  later(
    s.guard?.at ?? null,
    () => (r.guard.answer = s.guard === null ? null : { code: s.guard.code }),
  );
  later(s.closeAt, () => r.sink.close());
  if (!(await r.time.drive(p, 40_000))) return undefined;
  const final = await p.catch(() => undefined);
  if (final === undefined || endedAt === null) return undefined;
  const written = r.sink.chunks.length;
  const failuresAtEnd = r.sink.failures;
  const closedBeforeEnd = r.sink.closedAt !== null && r.sink.closedAt <= endedAt;
  await r.time.by(20_000);
  const lines = parseSse(r.sink.chunks);
  if (lines === undefined) return undefined;
  const frames = lines.filter((l): l is Frame => 'event' in l);
  const terminals = frames.filter(isTerminal);
  const last = frames[frames.length - 1];
  const call = r.admission.calls[0];
  const facts = r.registry.factLog.filter((f) => f.runId === IDS.run);
  const saved = r.registry.savedFinal.get(IDS.run);
  const sentTerminal = terminals[0];
  const healthy = failuresAtEnd === 0 && !closedBeforeEnd;
  const ok =
    (healthy ? terminals.length === 1 : terminals.length <= 1) &&
    (terminals.length === 0 || (last !== undefined && isTerminal(last))) &&
    streamProblems(frames).length === 0 &&
    r.sink.chunks.length === written &&
    r.admission.calls.length === 1 &&
    r.registry.finished.length === 1 &&
    saved !== undefined &&
    frameIsValid({ event: saved.event, id: 1, data: saved.data }) &&
    (sentTerminal === undefined ||
      isDeepStrictEqual(
        { event: sentTerminal.event, data: sentTerminal.data },
        JSON.parse(JSON.stringify(saved)),
      )) &&
    r.log.indexOf('settle:done') < r.log.indexOf('finish') &&
    call !== undefined &&
    (last?.event !== 'done' || last.data['quota_left'] === 17) &&
    aborts <= 1 &&
    (signal === undefined || !signal.aborted || signal.reason === firstReason);
  return {
    ok,
    frames,
    ending: final.ending,
    cardsToSettle: call?.outcome.cardsDelivered ?? -1,
    cardsFinal: final.cardsDelivered,
    acceptedCards: frames.filter((f) => f.event === 'card').length,
    lastFacts: facts[facts.length - 1]?.facts,
    healthy,
  };
}

async function holds(s: Scenario): Promise<boolean> {
  const o = await observe(s);
  return (
    o !== undefined &&
    o.ok &&
    o.cardsToSettle === o.acceptedCards &&
    o.cardsFinal === o.acceptedCards &&
    isDeepStrictEqual(o.lastFacts, { ending: o.ending, cardsDelivered: o.acceptedCards })
  );
}

it('[04 §8.1][BR-AI-23] 任意交错下：终止帧至多一个且在最后（连接健康时恰好一个），settle 恰好一次且卡数等于测试桩接受的卡片帧数，signal 只中止一次', async () => {
  await expect(fc.assert(fc.asyncProperty(scenario, holds), propParams())).resolves.toBeUndefined();
}, 900_000);

type Trigger =
  | { kind: 'none' }
  | { kind: 'cancel'; at: number }
  | { kind: 'guard'; at: number; code: 30501 | 10004 }
  | { kind: 'close'; at: number };

const single = fc.record({
  ops: fc.array(
    fc.record({
      gap: fc.integer({ min: 0, max: 1_500 }),
      kind: fc.constantFrom('text', 'tool', 'card', 'quote', 'badcard', 'suggest'),
    }),
    { maxLength: 6 },
  ),
  outcome: fc.constantFrom('done', 'error', 'throw', 'hang'),
  trigger: fc.oneof(
    fc.constant<Trigger>({ kind: 'none' }),
    fc.integer({ min: 100, max: 7_000 }).map((at): Trigger => ({ kind: 'cancel', at })),
    fc
      .record({
        at: fc.integer({ min: 100, max: 7_000 }),
        code: fc.constantFrom(30501 as const, 10004 as const),
      })
      .map((g): Trigger => ({ kind: 'guard', ...g })),
    fc.integer({ min: 100, max: 7_000 }).map((at): Trigger => ({ kind: 'close', at })),
  ),
});

/**
 * What the scenario predicts. Ops end by 9 000 ms, the time limit is at 11 000 ms (accepted 1 000
 * ms before start, maxRunMs 12 000), and every trigger in 100..7 000 ms (after start registered the run) takes effect by 10 000 ms
 * (cancel poll 500, guard poll 2 000, grace 3 000); with a trigger the body never returns.
 */
function predicted(
  t: Trigger,
  outcome: Scenario['outcome'],
): { ending: string; terminal: unknown } {
  if (t.kind === 'cancel') return { ending: 'cancelled', terminal: ['done', 'cancelled'] };
  if (t.kind === 'guard') {
    return t.code === 30501
      ? { ending: 'disabled', terminal: ['error', 30501] }
      : { ending: 'consent_withdrawn', terminal: ['error', 10004] };
  }
  if (t.kind === 'close') return { ending: 'disconnected', terminal: null };
  if (outcome === 'done') return { ending: 'stop', terminal: ['done', 'stop'] };
  if (outcome === 'error') return { ending: 'server_error', terminal: ['error', 50302] };
  if (outcome === 'throw') return { ending: 'server_error', terminal: ['error', 50001] };
  return { ending: 'timeout', terminal: ['done', 'timeout'] };
}

it('[BR-AI-12][BR-AI-13][02 §9.2][BR-AI-14] 单一触发、连接健康：结局与终止帧等于按场景独立推算的值，卡数等于接受的卡片帧数', async () => {
  const property = fc.asyncProperty(single, async (s) => {
    const outcome = s.trigger.kind === 'none' ? s.outcome : 'hang';
    const o = await observe({
      ops: s.ops,
      outcome,
      cancelAt: s.trigger.kind === 'cancel' ? s.trigger.at : null,
      guard: s.trigger.kind === 'guard' ? { at: s.trigger.at, code: s.trigger.code } : null,
      closeAt: s.trigger.kind === 'close' ? s.trigger.at : null,
      failAt: null,
    });
    if (o === undefined || !o.ok) return false;
    const want = predicted(s.trigger, outcome);
    const terminal = o.frames.filter(isTerminal)[0];
    const got =
      terminal === undefined
        ? null
        : [
            terminal.event,
            terminal.event === 'done' ? terminal.data['finish_reason'] : terminal.data['code'],
          ];
    return (
      o.ending === want.ending &&
      isDeepStrictEqual(got, want.terminal) &&
      o.cardsToSettle === o.acceptedCards &&
      o.cardsFinal === o.acceptedCards
    );
  });
  await expect(fc.assert(property, propParams())).resolves.toBeUndefined();
}, 900_000);
