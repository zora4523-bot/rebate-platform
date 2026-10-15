import type { AgentRunLabels, RunBodyInput } from '../../http/index.ts';
import type { RunBody } from '../../stream/run/index.ts';
import type {
  AgentRunBodyDeps,
  InputCheckPort,
  OrchestratorLimits,
  OrchestratorTools,
  RunLabelsDeps,
} from './ports.ts';
import { runAgent } from './run.ts';

/**
 * B3-05b / 02 §9.1–9.2. ChatInput is prompt.system + awaited
 * definitions(input.caller.appId, input.caller), unchanged,
 * with messages initially [{role:'user', content: proceed.modelText}]. A tool round appends
 * {role:'assistant', content: roundText || null, tool_calls}, then, in call order,
 * {role:'tool', tool_call_id, content: JSON.stringify(outcome.modelView)}.
 * Only modelView goes back to the model, never cards/trace/placeholders/raw input.
 * Tools own schema/identity rejection and untrusted-title delimiting in modelView.
 * Unknown names are rejected by core WITHOUT execute/toolDisplay/tool.status; append
 * {error:'invalid_args'} as the tool message, count the call, and continue the loop.
 * Known tools receive the original args, placeholders and input.context unchanged.
 * Known failed/rejected calls emit failed after start; successful calls emit end.
 * toolDisplay gets appId, registered name, phase and validated args.platform (or undefined).
 * One modelClock, OutputGuard and set of counters per run, never shared by factory users.
 * One ctx.text per GuardEmit (including the final end flush), preserving guard order.
 * Fixed keys use awaited texts.text(appId, key), including guard replacement keys.
 * Core alone emits proceed.notices once before model/path output, through the same caps.
 * Those notices do NOT count as delivered content for the no-degrade rule (plan U-11):
 * notices alone still allow budget/models_failed degradation; paths must not re-emit them.
 * A blocked output stops tools/cards not yet emitted; timeout replacement keeps cards.
 * Output limits guard all paths. tool.status is not a content frame. Embedded cards count
 * toward cards but not frames; never emit a partial structured card to fit the limit.
 * Tool/round exhaustion returns done limit; output caps stop at the boundary, without any
 * later content. Degraded results are returned unchanged only before model/tool text/card delivery;
 * after delivery a router degradation ends done stop (plan U-11), without duplicate fallback.
 * A pre-aborted signal or an abort during any await suppresses all later output; late results
 * are discarded. RunManager owns the actual cancellation terminal; the body returns done stop.
 * No IntentPort + final JSON object with agent_intent => out_of_scope fixed text, done stop.
 * Other structured round text (card JSON, arrays; fenced or unparseable) is never delivered:
 * degrade models_failed before delivery, else flush and done stop (ports.ts header).
 * No DeterministicPath + links => agent.degraded.empty notice, done fallback, no model call.
 * Router refused => agent.refuse.unsafe, done safety. No prompt => degraded route_no_model,
 * without complete() or tool execution. Read the shared immutable PromptSource once per run;
 * trace records that version, the actual last responding model and all attempts in order.
 * For each traced tool call, pass unchanged args and this run's placeholders to traceMask
 * and record its return value unchanged. Core owns neither restoration nor masking semantics;
 * execute and model messages retain their model-form placeholders unchanged.
 */
export function createAgentRunBody(deps: AgentRunBodyDeps): (input: RunBodyInput) => RunBody {
  for (const [name, value] of Object.entries(deps.limits)) {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new RangeError(`Invalid orchestrator limit: ${name}`);
    }
  }
  // Only immutable deps are captured here; every run builds its own state in runAgent.
  return (input) => (ctx) => runAgent(deps, input, ctx);
}

/** No route => none/null. Missing prompt => none, retaining the first resolved model if any. */
export function createRunLabels(deps: RunLabelsDeps): AgentRunLabels {
  return {
    async current(caller) {
      const route = await deps.route(caller.appId);
      const modelSnapshot = route.mode === 'models' ? (route.attempts[0]?.model ?? null) : null;
      if (modelSnapshot === null) return { promptVersion: 'none', modelSnapshot };
      const prompt = await deps.prompt.current(caller.appId);
      return { promptVersion: prompt === null ? 'none' : prompt.version, modelSnapshot };
    },
    modelLabel: (appId, modelSnapshot) => deps.modelLabel(appId, modelSnapshot),
    aiLabel: (appId) => deps.aiLabel(appId),
  };
}

/** Defaults from SPEC_REF 02 §9.1–9.2: 4 tools, 3 rounds, 20000 code points, 12 cards, 400 frames. */
export function orchestratorLimitsDefaults(): OrchestratorLimits {
  return { toolCalls: 4, modelRounds: 3, textCodePoints: 20_000, cards: 12, contentFrames: 400 };
}

/** No definitions/platforms/results/cards; every execute is rejected invalid_args. */
export function emptyOrchestratorTools(): OrchestratorTools {
  return {
    definitions: async () => [],
    execute: async () => ({ kind: 'rejected', modelView: { error: 'invalid_args' } }),
    enabledSearchPlatforms: async () => [],
    searchKeyword: async () => ({ results: [], cards: [] }),
  };
}

/** Always refuse safety_unavailable, finishReason safety, ending input_review_timeout. */
export function failClosedInputCheck(): InputCheckPort {
  return {
    check: async () => ({
      kind: 'refuse',
      textKey: 'agent.refuse.safety_unavailable',
      finishReason: 'safety',
      ending: 'input_review_timeout',
    }),
  };
}
