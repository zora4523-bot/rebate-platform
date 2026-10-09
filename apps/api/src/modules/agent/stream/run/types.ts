import type { Clock, RedisNamespace, RootLogger, Scheduler } from '../../../platform/index.ts';
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

/** Saved before settlement; quota_left is supplied only by the admission gate afterward. */
export type TerminalDraft =
  | { readonly event: 'done'; readonly data: Omit<DoneData, 'quota_left'> }
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
  /** Saves the draft together with ending facts before resolving; live saves omit it. */
  recordFacts(runId: string, facts: RunFacts, draft?: TerminalDraft): Promise<void>;
  facts(runId: string): Promise<RunFacts | null>;
  requestCancel(runId: string, ownerKey: string): Promise<'ok' | 'not_found'>;
  cancelRequested(runId: string): Promise<boolean>;
  /**
   * Saves the terminal after settlement. B3-03g: a registry that persists the terminal returns the
   * frame actually stored (agent_runs.final_event), and the manager sends that one instead of its
   * own; returning nothing (B3-03b fakes, the Redis registry) keeps sending `terminal`.
   */
  finish(runId: string, terminal: TerminalFrame): Promise<TerminalFrame | void>;
  /**
   * B3-03g S4 (design §3.1): called by the manager inside choose(), when the ending is chosen and
   * before anything is awaited (no wait for pending card facts); the PG registry writes the ending
   * with the decision UPDATE at once. Optional: registries without it are skipped.
   */
  recordEnding?(runId: string, facts: RunFacts, draft: TerminalDraft): Promise<void>;
  final(runId: string): Promise<TerminalFrame | null>;
}

/** Recovery reads the draft separately so RunFacts retains its existing public shape. */
export interface RecoverableRunRegistry extends RunRegistry {
  draft(runId: string): Promise<TerminalDraft | null>;
}

export interface RedisRunRegistryDeps {
  /** Wiring must provide an app_id-scoped namespace; run ids alone do not isolate brands. */
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
  /** Inject ROOT_LOGGER (or a child) when wiring the stream entry. */
  readonly logger?: Pick<RootLogger, 'error'>;
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
