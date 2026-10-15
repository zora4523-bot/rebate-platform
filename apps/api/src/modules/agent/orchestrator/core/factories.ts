import type { AgentRunLabels, RunBodyInput } from '../../http/index.ts';
import type { RunBody } from '../../stream/run/index.ts';
import type {
  AgentRunBodyDeps,
  InputCheckPort,
  OrchestratorLimits,
  OrchestratorTools,
  RunLabelsDeps,
} from './ports.ts';

/**
 * B3-05b / 02 §9.1–9.2. ChatInput is prompt.system + definitions(input.caller), unchanged,
 * with messages initially [{role:'user', content: proceed.modelText}]. A tool round appends
 * {role:'assistant', content: roundText || null, tool_calls}, then, in call order,
 * {role:'tool', tool_call_id, content: JSON.stringify(outcome.modelView)}.
 * Only modelView goes back to the model, never cards/trace/placeholders/raw input.
 * Tools own schema/identity rejection and untrusted-title delimiting in modelView.
 * One OutputGuard per run (including its final end flush); fixed keys use texts.text.
 * A blocked output stops tools/cards not yet emitted; timeout replacement keeps cards.
 * Output limits guard all paths. tool.status is not a content frame. Embedded cards count
 * toward cards but not frames; never emit a partial structured card to fit the limit.
 * Tool/round exhaustion returns done limit; output caps stop at the boundary, without any
 * later content. Degraded results are returned unchanged only before text/card delivery;
 * after delivery a router degradation ends done stop (plan U-11), without duplicate fallback.
 * A pre-aborted signal or an abort during any await suppresses all later output; late results
 * are discarded. RunManager owns the actual cancellation terminal; the body returns done stop.
 * No IntentPort + final JSON object with agent_intent => out_of_scope fixed text, done stop.
 * No DeterministicPath + links => agent.degraded.empty notice, done fallback, no model call.
 * Router refused => agent.refuse.unsafe, done safety. No prompt => no-model degraded path.
 */
export function createAgentRunBody(deps: AgentRunBodyDeps): (input: RunBodyInput) => RunBody {
  void deps;
  throw new Error('NotImplemented: createAgentRunBody');
}

/** No route => none/null. Missing prompt => none, retaining the first resolved model if any. */
export function createRunLabels(deps: RunLabelsDeps): AgentRunLabels {
  void deps;
  throw new Error('NotImplemented: createRunLabels');
}

/** Defaults from SPEC_REF 02 §9.1–9.2: 4 tools, 3 rounds, 20000 code points, 12 cards, 400 frames. */
export function orchestratorLimitsDefaults(): OrchestratorLimits {
  throw new Error('NotImplemented: orchestratorLimitsDefaults');
}

/** No definitions/platforms/results/cards; every execute is rejected invalid_args. */
export function emptyOrchestratorTools(): OrchestratorTools {
  throw new Error('NotImplemented: emptyOrchestratorTools');
}

/** Always refuse safety_unavailable, finishReason safety, ending input_review_timeout. */
export function failClosedInputCheck(): InputCheckPort {
  throw new Error('NotImplemented: failClosedInputCheck');
}
