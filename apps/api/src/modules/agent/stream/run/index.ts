// RunManager: the life cycle of one Agent run (B3-03b; 规划/02 §9.1–9.2 「取消与断线」, 04 §8.1–8.2,
// BR-AI-23 细则「受理记录与收尾」, BR-AI-13 撤回同意, BR-AI-12 agent.enabled 关闭, BR-AI-14 细则
// 「单轮时限」). Frames are written only through StreamWriter (../writer, B3-03a); the quota is settled
// only through Admission.settle (../admission, B3-03c; refunds are decided there). The rule tests in
// test/spec/agent/stream-run/** import this file by path: names, signatures and the semantics
// written here are the contract. Out of scope: HTTP wiring and steps ①–⑥ (B3-03d), the Orchestrator
// (B3-05), OutputGuard (B3-06), trace (B3-09).
//
// runConfigDefaults(): heartbeatMs 15 000 (04 §8.1), maxRunMs 20 000 (BR-AI-14 细则「单轮时限」),
// disconnectGraceMs 60 000 (02 §9.2), guardPollMs ≤ 10 000 (BR-AI-12, BR-AI-13 「10 秒内」),
// signalPollMs (cross-instance cancel poll; agent default, positive). Every value is configurable.
//
// numberCard(card, firstNo): pure. The frame takes c<firstNo>; then, in order, each
// product_list data.items[i] or the rebate_quote data.product takes the next number (04 §8.2
// 「card」: frame first, then embedded items). No other type (unknown types included) has embedded
// ids. used = how many numbers were taken. The input is not modified.
//
// createRunManager(deps).start(start, body):
//   1. registry.register({runId, sessionId, ownerKey}) and the meta frame first (session_id and
//      run_id from the ticket, the rest from start.meta; duplicate false or absent); body is called
//      only after meta was written. When the meta write fails (sink throws or is closed), the body
//      is not called and the run ends at once as disconnected; the tail (step 4) still runs.
//   2. While the run is live: pings (`: ping`, no seq) so that no gap between two writes (frame or
//      ping) exceeds heartbeatMs; when idle, the ping comes exactly heartbeatMs after the last write
//      (a fixed 15-second period also satisfies this); registry.cancelRequested polled every signalPollMs; guard.check() polled at
//      least every guardPollMs (a throwing check is ignored and checked again next round); the time
//      limit at ticket.acceptedAtMs + maxRunMs (epoch ms of the Clock: counted from acceptance, not
//      from start); after the sink closes, an abort at close + disconnectGraceMs.
//      All waiting goes through deps.scheduler (monotonic) and the current instant through
//      deps.clock; no bare timers.
//   3. Endings (the first one wins; the signal aborts once with the AbortReason as reason):
//      cancel → done cancelled; time limit → text.delta texts.text('agent.timeout'), done timeout;
//      guard 30501 → error{30501, texts.errorMsg(30501), retryable false, fallback null}, ending
//      disabled; guard 10004 → the same with 10004, ending consent_withdrawn; disconnect → nothing
//      more is written to the sink, ending disconnected, and the terminal that is saved (not sent)
//      is done{finish_reason 'cancelled', quota_left} (agent default: no rule names a disconnect
//      frame; 04 §3.2 final_event is set for every ended run, for the 04 §8.1 duplicate replay); body done → done with its finish_reason
//      (ending = the same name, or `ending` when given; finish_reason 'error' → server_error);
//      body error → that error frame as given, ending server_error for 5xxxx (client_error
//      otherwise); body throws → error{50001, texts.errorMsg(50001), retryable true, fallback null},
//      ending server_error. A body result arriving after another ending is ignored; ctx calls after
//      the abort write nothing.
//   4. Tail (BR-AI-23 细则「受理记录与收尾」), each step awaited before the next starts:
//      registry.recordFacts(runId, {ending, cardsDelivered}) (the run facts other instances read
//      when they complete a crashed run's tail), then admission.settle(ticket, {ending,
//      cardsDelivered}, start.limits) exactly once, then registry.finish(runId, terminal) (every
//      ending has a terminal), then the terminal frame when the sink is open (done.quota_left =
//      settle's quotaLeft), then start() resolves with that terminal in RunFinal. A step starts
//      only after the previous one's promise resolved (saved, not just called). Write failures (closed or failing sink) are silent and never skip the
//      settle. cardsDelivered counts card frames whose write succeeded; after each such card,
//      before ctx.card resolves, recordFacts(runId, {ending: null, cardsDelivered}) is saved too.
//   ctx.card reserves numbers with cards.reserve(sessionId, used) and writes the numbered card; an
//   invalid card rejects with StreamProtocolError('invalid_frame') and the run goes on.
// cancel(runId, ownerKey) → registry.requestCancel (not owner, unknown or finished: 'not_found').
//
// createRedisRunRegistry: uses only RedisNamespace.get and set (no eval), every set with
// deps.ttlSeconds; instances sharing one namespace see each other's runs, cancel requests, run facts
// and final frames (cross-instance cancel; a new instance reads what an old one saved). Two
// instances interleaving their get/set never lose each other's writes: a cancel request, the saved
// card count (only grows, 04 §3.2 card_delivered) and the final frame survive a concurrent write
// from an instance holding an older read (e.g. one key per fact instead of one JSON). The
// database columns behind the facts and the recovery wiring belong to B3-03d / 12 X-10.
//
// Rules for the implementation: also compiled by the `test` project: erasable syntax only,
// `import type` for type-only imports, relative imports with `.ts`, no NestJS, no process.env,
// time only from the injected Clock and Scheduler.
import type { Clock, RedisNamespace, Scheduler } from '../../../platform/index.ts';
import type {
  CardInput,
  DoneData,
  ErrorData,
  FinishReason,
  FrameValidator,
  MetaData,
  StreamSink,
  SuggestionsData,
} from '../writer/index.ts';
import type { Admission, AdmissionLimits, AdmissionTicket, RunEnding } from '../admission/index.ts';

export interface RunConfig {
  readonly maxRunMs: number;
  readonly heartbeatMs: number;
  readonly disconnectGraceMs: number;
  readonly guardPollMs: number;
  readonly signalPollMs: number;
}

export type AbortReason =
  'cancelled' | 'timeout' | 'disconnected' | 'disabled' | 'consent_withdrawn';

/** A card without card_id; embedded product cards carry no card_id either. */
export type UnnumberedCard = Omit<CardInput, 'card_id'>;

export interface NumberedCard {
  readonly card: CardInput;
  readonly used: number;
}

export interface RunContext {
  readonly runId: string;
  readonly sessionId: string;
  /** Aborted once; reason is an AbortReason. */
  readonly signal: AbortSignal;
  readonly cardsDelivered: number;
  text(delta: string): void;
  toolStatus(tool: string, phase: 'start' | 'end' | 'failed', displayText: string): void;
  card(card: UnnumberedCard): Promise<void>;
  suggestions(items: SuggestionsData['items']): void;
}

export type RunBodyResult =
  | {
      readonly kind: 'done';
      readonly finishReason: Exclude<FinishReason, 'cancelled' | 'timeout'>;
      readonly ending?: 'input_review_timeout';
    }
  | { readonly kind: 'error'; readonly error: ErrorData };

export type RunBody = (ctx: RunContext) => Promise<RunBodyResult>;

export interface RunGuard {
  check(): Promise<null | { readonly code: 30501 | 10004 }>;
}

export interface RunTexts {
  text(key: 'agent.timeout'): string;
  errorMsg(code: number): string;
}

export interface CardSequence {
  /** Returns the first of `count` numbers reserved for the session; never reused. */
  reserve(sessionId: string, count: number): Promise<number>;
}

export type TerminalFrame =
  | { readonly event: 'done'; readonly data: DoneData }
  | { readonly event: 'error'; readonly data: ErrorData };

export interface RunRegistration {
  readonly runId: string;
  readonly sessionId: string;
  /** u:<user_id> | d:<device_id> (BR-AI-20). */
  readonly ownerKey: string;
}

/** Facts saved while the run goes (BR-AI-23 细则): ending null until the run has one. */
export interface RunFacts {
  readonly ending: RunEnding | null;
  readonly cardsDelivered: number;
}

export interface RunRegistry {
  register(run: RunRegistration): Promise<void>;
  recordFacts(runId: string, facts: RunFacts): Promise<void>;
  facts(runId: string): Promise<RunFacts | null>;
  requestCancel(runId: string, ownerKey: string): Promise<'ok' | 'not_found'>;
  cancelRequested(runId: string): Promise<boolean>;
  finish(runId: string, terminal: TerminalFrame): Promise<void>;
  final(runId: string): Promise<TerminalFrame | null>;
}

export interface RedisRunRegistryDeps {
  readonly redis: RedisNamespace;
  readonly clock: Clock;
  readonly ttlSeconds: number;
}

export interface RunSink extends StreamSink {
  onClose(listener: () => void): void;
}

export interface RunStart {
  readonly ticket: AdmissionTicket;
  readonly ownerKey: string;
  readonly limits: AdmissionLimits;
  readonly meta: Omit<MetaData, 'session_id' | 'run_id' | 'duplicate'>;
  readonly sink: RunSink;
}

export interface RunFinal {
  readonly terminal: TerminalFrame | null;
  readonly ending: RunEnding;
  readonly cardsDelivered: number;
}

export interface RunManager {
  start(start: RunStart, body: RunBody): Promise<RunFinal>;
  cancel(runId: string, ownerKey: string): Promise<'ok' | 'not_found'>;
}

export interface RunManagerDeps {
  readonly admission: Admission;
  readonly registry: RunRegistry;
  readonly cards: CardSequence;
  readonly texts: RunTexts;
  readonly guard: RunGuard;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly config: RunConfig;
  readonly validator?: FrameValidator;
}

export function runConfigDefaults(): RunConfig {
  return {
    maxRunMs: 20_000,
    heartbeatMs: 15_000,
    disconnectGraceMs: 60_000,
    guardPollMs: 5_000,
    signalPollMs: 500,
  };
}

export { numberCard } from './cards.ts';
export { createRedisRunRegistry } from './registry.ts';
export { createRunManager } from './manager.ts';
