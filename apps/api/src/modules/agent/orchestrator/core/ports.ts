// B3-05b: downstream contracts (ports). The core lives in factories.ts, run.ts and output.ts.
import type { Platform } from '@couli/contracts-ts';
import type { Candidate } from '../../../parsing/index.ts';
import type { AgentCaller, RunBodyInput } from '../../http/index.ts';
import type { FilterHit, SentenceReviewPort } from '../../guard/index.ts';
import type {
  DegradeReason,
  KeywordSearchPlan,
  PlatformSearchResult,
} from '../../model-gateway/degraded/index.ts';
import type { ToolDefinition } from '../../model-gateway/openai-compat/index.ts';
import type {
  AttemptRecord,
  ModelRouter,
  ResolvedRoute,
  RunModelClock,
} from '../../model-gateway/routing/index.ts';
import type { RunBodyResult, RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import type { SuggestionsData } from '../../stream/writer/index.ts';

export interface OrchestratorLimits {
  readonly toolCalls: number;
  readonly modelRounds: number;
  readonly textCodePoints: number;
  /** Includes embedded product cards; the containing card also counts. */
  readonly cards: number;
  /** text.delta + card + suggestions; excludes tool.status and embedded cards. */
  readonly contentFrames: number;
}

export interface InputProceed {
  readonly kind: 'proceed';
  readonly modelText: string;
  /** Run-local only; never sent to the model or trace. */
  readonly placeholders: Readonly<Record<string, string>>;
  readonly links: readonly Candidate[];
  /** Core emits once, in order, before model/path output; counted against run limits,
   * but NOT as delivered model/tool content for the no-degrade rule (plan U-11).
   * Downstream paths receive these for context only and MUST NOT re-emit them. */
  readonly notices: readonly UnnumberedCard[];
  readonly untrustedInput: boolean;
  readonly paramsRequested: boolean;
}

export type InputCheckResult =
  | InputProceed
  | {
      readonly kind: 'refuse';
      readonly textKey: string;
      readonly finishReason: Extract<RunBodyResult, { kind: 'done' }>['finishReason'];
      readonly ending?: 'input_review_timeout';
    };

export interface InputCheckPort {
  check(input: RunBodyInput, signal: AbortSignal): Promise<InputCheckResult>;
}

export interface OrchestratorToolCall {
  readonly id: string;
  readonly name: string;
  /** Parsed model arguments, unchanged (including placeholders and forbidden fields). */
  readonly args: unknown;
}

export interface ToolContext {
  readonly subject: AgentCaller;
  /** Scenario entry, passed unchanged from RunBodyInput.context. */
  readonly context?: RunBodyInput['context'];
  readonly runId: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly placeholders: Readonly<Record<string, string>>;
}

export interface ToolTraceFragment {
  readonly card_sources?: readonly {
    readonly card_id: string;
    readonly fields: Readonly<Record<string, number | string | boolean | null>>;
  }[];
  readonly link_registrations?: readonly {
    readonly link_id: string;
    readonly product_key: string;
    readonly ok: boolean;
  }[];
}

export type ToolOutcome =
  | {
      readonly kind: 'ok';
      readonly modelView: unknown;
      readonly cards: readonly UnnumberedCard[];
      readonly suggestions?: SuggestionsData['items'];
      readonly trace?: ToolTraceFragment;
    }
  | { readonly kind: 'failed'; readonly modelView: unknown }
  | { readonly kind: 'rejected'; readonly modelView: { readonly error: 'invalid_args' } };

export interface KeywordSearchOutcome {
  readonly results: readonly PlatformSearchResult[];
  readonly cards: readonly UnnumberedCard[];
  readonly trace?: ToolTraceFragment;
}

export interface OrchestratorTools {
  definitions(appId: string, subject: AgentCaller): Promise<readonly ToolDefinition[]>;
  execute(call: OrchestratorToolCall, ctx: ToolContext): Promise<ToolOutcome>;
  enabledSearchPlatforms(appId: string): Promise<readonly string[]>;
  searchKeyword(plan: KeywordSearchPlan, ctx: ToolContext): Promise<KeywordSearchOutcome>;
}

export interface PathInput {
  readonly input: RunBodyInput;
  readonly proceed: InputProceed;
}

/** Receives a guarded RunContext: cancellation and all output limits still apply. */
export interface DegradedPath {
  run(
    request: PathInput & { readonly reason: DegradeReason },
    ctx: RunContext,
  ): Promise<RunBodyResult>;
}

export interface DeterministicPath {
  run(request: PathInput, ctx: RunContext): Promise<RunBodyResult>;
}

export interface IntentPort {
  /** Final-round text only. null means ordinary explanation; otherwise the port owns output. */
  handle(
    request: PathInput & { readonly text: string },
    ctx: RunContext,
  ): Promise<RunBodyResult | null>;
}

export interface AgentRunTexts {
  text(appId: string, key: string): Promise<string>;
  /** Template lookup only: registered tool + validated platform enum, never raw arguments.
   * Missing/invalid platform uses the generic template (undefined). */
  toolDisplay(
    appId: string,
    tool: string,
    phase: 'start' | 'end' | 'failed',
    platform?: Platform,
  ): Promise<string>;
}

/** Immutable prompt release for the wiring lifetime; labels and body share this source.
 * Deploy a new source with the release, not a mutable "latest" between labels and body. */
export interface PromptSource {
  current(appId: string): Promise<{ readonly version: string; readonly system: string } | null>;
}

export interface OrchestratorTrace extends ToolTraceFragment {
  readonly intent: string | null;
  /** Actual last successful ModelOutcome.model; null when no model answered. */
  readonly model: string | null;
  /** All router attempt records in round order, including failed primary attempts. */
  readonly attempts: readonly AttemptRecord[];
  /** Version of the prompt actually used, or 'none' without a model prompt. */
  readonly prompt_version: string;
  readonly tool_calls: readonly {
    readonly name: string;
    /** Exact storage-safe result from the injected traceMask port.
     * Core does not restore placeholders or implement masking rules. */
    readonly args: unknown;
    readonly status: 'ok' | 'failed' | 'rejected';
  }[];
  readonly output_filtered: boolean;
  readonly filter_hits: readonly FilterHit[];
  readonly output_truncated: boolean;
}

export interface RunTraceSink {
  record(runId: string, trace: OrchestratorTrace): void;
}

export interface AgentRunBodyDeps {
  readonly model: Pick<ModelRouter, 'complete'>;
  /** Fresh per run, shared by every complete call in that run. */
  readonly modelClock: () => RunModelClock;
  readonly tools: OrchestratorTools;
  readonly inputCheck: InputCheckPort;
  readonly degraded: DegradedPath;
  readonly deterministic?: DeterministicPath;
  readonly intents?: IntentPort;
  readonly review: SentenceReviewPort;
  readonly texts: AgentRunTexts;
  /** Same immutable source passed to createRunLabels. Read once per run, not per round. */
  readonly prompt: PromptSource;
  readonly limits: OrchestratorLimits;
  /** Given unchanged model args and this run's placeholder table, return storage-safe args.
   * The port owns masking semantics; core records its result unchanged and never records
   * the placeholder table or raw values. Must not mutate the args or table. */
  readonly traceMask: (args: unknown, placeholders: Readonly<Record<string, string>>) => unknown;
  readonly trace?: RunTraceSink;
}

export interface RunLabelsDeps {
  /** Same route provider wired to ModelRouter; label predicts the first entry only.
   * Failover's actual responding model belongs in OrchestratorTrace.model. */
  readonly route: (appId: string) => Promise<ResolvedRoute>;
  readonly prompt: PromptSource;
  readonly modelLabel: (appId: string, modelSnapshot: string | null) => Promise<string>;
  readonly aiLabel: (appId: string) => Promise<string>;
}
