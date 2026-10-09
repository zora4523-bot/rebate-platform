// Public PG run port types; kept separate to avoid dependency cycles.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../../platform/index.ts';
import type { Admission } from '../admission/index.ts';
import type {
  RecoverableRunRegistry,
  RunFacts,
  RunRegistry,
  RunTexts,
  TerminalDraft,
  TerminalFrame,
} from '../run/types.ts';
import type { QuotaLimitsSource } from './limits.ts';

export type FinalizeHold = 'stored_frame_invalid' | 'facts_inconsistent';

export type FinalizeOutcome =
  | {
      readonly kind: 'final';
      readonly frame: TerminalFrame;
      readonly refunded: boolean;
      /** quota_left inside the stored done frame; null for an error frame. */
      readonly snapshotQuotaLeft: number | null;
      /** The remaining quota now (F4 formula, this run already counted or refunded). */
      readonly quotaLeft: number;
      /** Whether this call wrote the terminal (false: it was already there). */
      readonly wrote: boolean;
    }
  | { readonly kind: 'running' }
  | { readonly kind: 'held'; readonly reason: FinalizeHold };

export interface Finalizer {
  /** Recovery finalization in its own transaction; retryable errors → AdmissionUnavailableError. */
  finalize(runId: string): Promise<FinalizeOutcome>;
}

export interface RunTimings {
  readonly runMaxMs: number;
  readonly lockGraceMs: number;
  readonly cancelPgPollMs: number;
}

export type TxStep =
  | 'admit'
  | 'lookup'
  | 'hold'
  | 'facts'
  | 'ending'
  | 'settle'
  | 'finish'
  | 'finalize'
  | 'cancel'
  | 'cancel_poll';

export type CrashPoint = 'admit' | 'facts' | 'ending' | 'settle' | 'finish' | 'finalize' | 'cancel';

export interface TxHooks {
  beforeSql?(step: TxStep, pid: number): Promise<void>;
  beforeCommit?(step: TxStep, pid: number): Promise<void>;
  afterCommit?(step: TxStep): Promise<void>;
  crash?(point: CrashPoint, phase: 'before' | 'after'): void;
}

export interface PgRunDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly timings: RunTimings;
  /** The same instance B3-03d uses for the limits it passes to admit. */
  readonly limits: QuotaLimitsSource;
  readonly texts: Pick<RunTexts, 'errorMsg'>;
  /** Redis fast path for cancel signals; may be absent or failing. */
  readonly signals?: Pick<RunRegistry, 'requestCancel' | 'cancelRequested'>;
  readonly logger?: Pick<RootLogger, 'error' | 'warn'>;
  readonly hooks?: TxHooks;
}

export interface PgRunRegistry extends RecoverableRunRegistry {
  recordEnding(runId: string, facts: RunFacts, draft: TerminalDraft): Promise<void>;
  finish(runId: string, terminal: TerminalFrame): Promise<TerminalFrame>;
}

export interface CancelQuery {
  readonly appId: string;
  readonly runId: string;
}

export interface PgRunPorts {
  readonly admission: Admission;
  readonly registry: PgRunRegistry;
  readonly finalizer: Finalizer;
  cancel(query: CancelQuery): Promise<'accepted' | 'not_running'>;
}
