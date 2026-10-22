import type { SentenceReviewPort } from '../../guard/index.ts';
import type { ResolvedRoute } from '../../model-gateway/routing/index.ts';
import type { OrchestratorTools, PromptSource, ToolOutcome } from '../core/ports.ts';
import type { EvalInput, EvalPorts, EvalTurnOutput } from './index.ts';

export type EvalToolCatalog = Pick<OrchestratorTools, 'definitions' | 'enabledSearchPlatforms'>;

/** Synthetic local wiring only. Defaults: passing input reviewer, null prompt, no_model route,
 * empty catalog. Uses the shared production createAgentBodyAssembly, real input preprocessing,
 * and non-billable bindings.transport. IDs and time come exclusively from these injected ports.
 * Session/card numbering persists per case. Synthetic quota_left is 0 (no admission budget).
 */
export interface LocalEvalAgentDeps {
  clock: { now(): Date };
  ids: { next(): string };
  review?: SentenceReviewPort;
  prompt?: PromptSource;
  route?: (appId: string) => Promise<ResolvedRoute>;
  catalog?: EvalToolCatalog;
}

export function createLocalEvalAgent(
  deps: LocalEvalAgentDeps,
): (input: EvalInput, ports: EvalPorts) => Promise<EvalTurnOutput> {
  void deps;
  throw new Error('NotImplemented: createLocalEvalAgent');
}

/** Exact model-form args, turn, empty result_set_ids and catalog names; stable SHA-256 of
 * definitions. Reserved degraded_keyword_search is excluded from tool_set; its ToolOutcome
 * carries platform results in modelView.results, plus the usual cards and trace. RecordingMiss must
 * escape the whole evaluation unchanged, even if the production core catches tool failures.
 */
export function createPortTools(
  port: EvalPorts['tool'],
  catalog: EvalToolCatalog,
  turn: number,
): OrchestratorTools {
  void port;
  void catalog;
  void turn;
  throw new Error('NotImplemented: createPortTools');
}

/** Validate the serializable ToolOutcome, including cards/trace; absent ok.cards means [].
 * Invalid recordings return null and become failed tools, never an interrupted run.
 */
export function decodeToolOutcome(response: unknown): ToolOutcome | null {
  void response;
  throw new Error('NotImplemented: decodeToolOutcome');
}

// Structural CliDeps only: apps/api must not import packages/evals.
export interface LocalEvalCliDeps {
  agent?: (
    env: Pick<LocalEvalAgentDeps, 'clock' | 'ids'>,
  ) => ReturnType<typeof createLocalEvalAgent>;
  livePorts?: () => EvalPorts | Promise<EvalPorts>;
  clock?: LocalEvalAgentDeps['clock'];
  meta?: {
    vendor: string;
    model_snapshot: string;
    prompt_sha256: string;
    sampling: Record<string, unknown>;
    tool_schema_version: string;
    code_commit: string;
    grader_version: string;
  };
}

export interface LocalEvalIo {
  out(text: string): void;
  err(text: string): void;
}

export interface RunLocalEvalDeps extends Omit<LocalEvalCliDeps, 'agent'> {
  runCli(argv: string[], deps: LocalEvalCliDeps, io: LocalEvalIo): Promise<number>;
  io: LocalEvalIo;
  agent?: Omit<LocalEvalAgentDeps, 'clock' | 'ids'>;
}

/** Inject the local agent into runCli; no environment access, implicit private paths or live
 * factory invocation during replay. Preserve caller meta even without a prompt/model.
 * TODO(规划/11 §4): 本机命令 — blocked on paths
 */
export function runLocalEval(argv: string[], deps: RunLocalEvalDeps): Promise<number> {
  void argv;
  void deps;
  throw new Error('NotImplemented: runLocalEval');
}
