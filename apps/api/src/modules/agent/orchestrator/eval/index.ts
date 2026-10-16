import type { ModelRequestShape } from '../../model-gateway/openai-compat/index.ts';
import type { VendorTransport } from '../../model-gateway/vendors/index.ts';
import type { RunBody } from '../../stream/run/index.ts';
import type { MetaData } from '../../stream/writer/index.ts';
import type { RunTraceSink } from '../core/ports.ts';

// Structural equivalents of evals' public shapes; no runtime/package dependency on evals.
export interface EvalInput {
  case_id: string;
  turn: number;
  text: string;
  untrusted: boolean;
  subject: 'guest' | 'logged_in' | 'bound_phone';
  switches: Record<string, boolean>;
}

export interface EvalPorts {
  model(request: ModelRequestShape): Promise<unknown>;
  tool(call: {
    name: string;
    args: Record<string, unknown>;
    state: { turn: number; result_set_ids: string[]; tool_set: string[] };
    config_fingerprint: string;
  }): Promise<unknown>;
}

export type EvalIntent =
  | 'find_by_link'
  | 'search'
  | 'refine'
  | 'order_query'
  | 'rule_qa'
  | 'handoff'
  | 'clarify'
  | 'out_of_scope'
  | 'page_guide'
  | 'earnings_query';

export interface EvalTurnOutput {
  frames: { event: string; id: number; data: Record<string, unknown> }[];
  trace: {
    intent: EvalIntent | null;
    tool_calls: {
      name: string;
      args: Record<string, unknown>;
      status: 'ok' | 'rejected' | 'failed';
    }[];
    card_sources?: { card_id: string; fields: Record<string, number | string | boolean | null> }[];
    link_registrations?: { link_id: string; product_key: string; ok: boolean }[];
  };
}

export interface EvalBindings {
  /** Adapter creates a non-billable createPortTransport around this turn's ports.model. */
  readonly transport: VendorTransport;
  readonly trace: RunTraceSink;
  readonly tool: EvalPorts['tool'];
}

export interface EvalRun {
  readonly body: RunBody;
  readonly meta: MetaData;
  readonly quotaLeft: number;
  /** Explicit session sequence supplied by the fixture/wiring, including embedded cards. */
  readonly firstCardNo: number;
}

export interface EvalAgentDeps {
  /** Build the same RunBody as the direct run with the supplied transport and trace sink.
   * Maps synthetic subject/switches to application deps; never installs a live transport.
   */
  createRun(input: EvalInput, bindings: EvalBindings): EvalRun | Promise<EvalRun>;
}

/** BR-AI-21: collect real RunBody output via a RunContext and the SSE writer/card numbering.
 * Emit supplied meta, then body frames unchanged, then its done/error terminal. Collect the
 * run's trace without inventing intent/tools/sources/registrations (unknown intent -> null).
 * Model port rejections must escape unchanged, even if the gateway/router caught them;
 * recording gaps must never become successful fallback evaluations. State is per invocation.
 */
export function createEvalAgent(
  deps: EvalAgentDeps,
): (input: EvalInput, ports: EvalPorts) => Promise<EvalTurnOutput> {
  void deps;
  throw new Error('NotImplemented: createEvalAgent');
}
