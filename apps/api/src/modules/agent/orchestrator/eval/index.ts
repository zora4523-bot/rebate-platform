// B3-05c: evaluation adapter (BR-AI-21). Drives the real RunBody through a collecting RunContext
// that writes every frame through the contract-validating StreamWriter, numbering cards like the
// run manager; the model is reached only through this invocation's ports.model.
import { createPortTransport } from '../../model-gateway/openai-compat/index.ts';
import type { ModelRequestShape } from '../../model-gateway/openai-compat/index.ts';
import type { VendorTransport } from '../../model-gateway/vendors/index.ts';
import { numberCard } from '../../stream/run/index.ts';
import type { RunBody, RunBodyResult, RunContext } from '../../stream/run/index.ts';
import { StreamWriter } from '../../stream/writer/index.ts';
import type { MetaData, StreamEvent, StreamEventInput } from '../../stream/writer/index.ts';
import type { OrchestratorTrace, RunTraceSink } from '../core/ports.ts';

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
 * A recording miss on this turn's model port escapes unchanged, even if the gateway/router
 * caught it: a recording gap must never become a successful fallback evaluation. Any other
 * model failure (429, network, ...) is ordinary fault handling left to the router and RunBody
 * (backup model, no-model degrade), and the collected frames and trace are returned as usual.
 * State is per invocation.
 */
export function createEvalAgent(
  deps: EvalAgentDeps,
): (input: EvalInput, ports: EvalPorts) => Promise<EvalTurnOutput> {
  return async (input, ports) => {
    // Recording misses of this turn's model port, kept even when the router turns them into a
    // degraded answer. Other port errors are not kept: they take the normal failure route.
    const misses: unknown[] = [];
    const model = async (request: ModelRequestShape): Promise<unknown> => {
      try {
        return await ports.model(request);
      } catch (error) {
        if (isRecordingMiss(error)) misses.push(error);
        throw error;
      }
    };
    const traces: OrchestratorTrace[] = [];
    const run = await deps.createRun(structuredClone(input), {
      transport: createPortTransport(model),
      trace: {
        record: (_runId, value) => {
          traces.push(value);
        },
      },
      tool: ports.tool,
    });

    let frames: EvalTurnOutput['frames'];
    try {
      frames = await collect(run);
    } catch (error) {
      if (misses.length > 0) throw misses[0];
      throw error;
    }
    if (misses.length > 0) throw misses[0];
    return { frames, trace: toEvalTrace(traces.at(-1) ?? null) };
  };
}

/** Structural check for packages/evals' RecordingMiss (apps/api does not depend on evals):
 * an Error named 'RecordingMiss' carrying its string kind and key. */
export function isRecordingMiss(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'RecordingMiss') return false;
  const fields = error as Error & { kind?: unknown; key?: unknown };
  return typeof fields.kind === 'string' && typeof fields.key === 'string';
}

function evalIntents(): readonly EvalIntent[] {
  return [
    'find_by_link',
    'search',
    'refine',
    'order_query',
    'rule_qa',
    'handoff',
    'clarify',
    'out_of_scope',
    'page_guide',
    'earnings_query',
  ];
}

function evalIntent(value: string | null): EvalIntent | null {
  return evalIntents().find((intent) => intent === value) ?? null;
}

function argsRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {};
  return structuredClone(args) as Record<string, unknown>;
}

/** The run's own trace, copied; no trace recorded means no intent and no tool calls. */
function toEvalTrace(trace: OrchestratorTrace | null): EvalTurnOutput['trace'] {
  if (trace === null) return { intent: null, tool_calls: [] };
  return {
    intent: evalIntent(trace.intent),
    tool_calls: trace.tool_calls.map((call) => ({
      name: call.name,
      args: argsRecord(call.args),
      status: call.status,
    })),
    ...(trace.card_sources === undefined
      ? {}
      : {
          card_sources: trace.card_sources.map((source) => ({
            card_id: source.card_id,
            fields: { ...source.fields },
          })),
        }),
    ...(trace.link_registrations === undefined
      ? {}
      : { link_registrations: trace.link_registrations.map((entry) => ({ ...entry })) }),
  };
}

/** Meta, the body's frames as the writer accepts them, then exactly one done/error terminal. */
async function collect(run: EvalRun): Promise<EvalTurnOutput['frames']> {
  const frames: EvalTurnOutput['frames'] = [];
  const writer = new StreamWriter({ sink: { write: () => undefined } });
  const emit = <E extends StreamEvent>(event: E, data: StreamEventInput[E]): void => {
    const frame = writer.emit(event, data);
    frames.push({ event: frame.event, id: frame.id, data: { ...frame.data } });
  };
  emit('meta', run.meta);

  let nextCard = run.firstCardNo;
  let delivered = 0;
  let cardQueue: Promise<void> = Promise.resolve();
  const controller = new AbortController();
  const ctx: RunContext = {
    runId: run.meta.run_id,
    sessionId: run.meta.session_id,
    signal: controller.signal,
    get cardsDelivered() {
      return delivered;
    },
    text: (delta) => emit('text.delta', { delta }),
    toolStatus: (tool, phase, displayText) =>
      emit('tool.status', { tool, phase, display_text: displayText }),
    card: async (value) => {
      // Detach the caller's snapshot first; numbers are reserved before the write, and cards
      // are delivered in call order, as in the run manager.
      const snapshot = numberCard(value, 1);
      const pending = cardQueue.then(() => {
        const numbered = numberCard(snapshot.card, nextCard);
        nextCard += numbered.used;
        emit('card', numbered.card);
        delivered += 1;
      });
      cardQueue = pending.catch(() => undefined);
      await pending;
    },
    suggestions: (items) => emit('suggestions', { items }),
  };

  const result: RunBodyResult = await run.body(ctx);
  await cardQueue;
  if (result.kind === 'error') emit('error', result.error);
  else emit('done', { finish_reason: result.finishReason, quota_left: run.quotaLeft });
  return frames;
}
