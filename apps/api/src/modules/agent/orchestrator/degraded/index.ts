// B3-05c: no-model degraded path (BR-AI-14 细则「无模型降级」; BR-AI-16 budget the same).
// Wiring only: the keyword plan, the outcome decision and finish_reason come from the B3-02d pure
// functions; limits, platforms, sort, text keys and the 50302 condition live in 08.
import { planKeywordSearch, resolveDegradedOutcome } from '../../model-gateway/degraded/index.ts';
import type { RedactedText } from '../../model-gateway/degraded/index.ts';
import type { RunBodyResult, RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import type {
  AgentRunTexts,
  DegradedPath,
  OrchestratorTools,
  PathInput,
  ToolContext,
  ToolTraceFragment,
} from '../core/ports.ts';

export interface DegradedPathDeps {
  readonly tools: Pick<OrchestratorTools, 'enabledSearchPlatforms' | 'searchKeyword'>;
  readonly texts: Pick<AgentRunTexts, 'text'>;
  readonly errorMsg: (appId: string, code: number) => Promise<string>;
  /** Optional receiver of the keyword search's trace fragment (card_sources,
   * link_registrations), handed over unchanged as the core does for ToolOutcome.trace: the
   * card_id values are the tool's own, not remapped here. Wired by the evaluation adapter
   * (EvalBindings.toolTrace) so the degraded cards keep their evidence (BR-AI-21). Production
   * trace collection for the degraded path belongs to the core (see the follow-up task); this
   * hook is best effort and never changes the run's result. */
  readonly onTrace?: (fragment: ToolTraceFragment) => void;
}

type Done = Extract<RunBodyResult, { kind: 'done' }>;

function stopped(): Done {
  return { kind: 'done', finishReason: 'stop' };
}

function toolContext(request: PathInput, ctx: RunContext): ToolContext {
  const input = request.input;
  return {
    subject: input.caller,
    ...(input.context === undefined ? {} : { context: input.context }),
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    signal: ctx.signal,
    placeholders: request.proceed.placeholders,
  };
}

function reportTrace(deps: DegradedPathDeps, fragment: ToolTraceFragment): void {
  if (deps.onTrace === undefined) return;
  try {
    deps.onTrace(fragment);
  } catch {
    // Trace is best effort; it never changes the run's result.
  }
}

/** BR-AI-14: plan from proceed.modelText, using the B3-02d planner/outcome functions.
 * Forward tool cards through ctx.card; empty outcomes emit an agent.degraded.empty notice.
 * An absent platform result throws; abort suppresses subsequent output after every await.
 * All-platform failure maps to error 50302, fallback=search_page, fallback_q=plan.q.
 * Proceed notices are emitted by the core only and never repeated here.
 * retryable=true follows contracts/error-codes.yaml: 50302 has retry_kind `later`.
 * No trace is recorded here: the keyword search is not a model-requested tool call, so it has
 * no place in OrchestratorTrace.tool_calls (traceMask'd model call args), and the run's single
 * trace (attempts, intent null, prompt version) is written by the core in its finally. The
 * search's own card_sources / link_registrations go to deps.onTrace when wired; production
 * trace is collected by the core (follow-up task).
 */
export function createDegradedPath(deps: DegradedPathDeps): DegradedPath {
  return {
    async run(request, ctx) {
      const signal = ctx.signal;
      if (signal.aborted) return stopped();
      const appId = request.input.caller.appId;

      const platforms = await deps.tools.enabledSearchPlatforms(appId);
      if (signal.aborted) return stopped();
      // Placeholder form only (plan U-3): raw values never reach the keyword search.
      const plan = planKeywordSearch(request.proceed.modelText as RedactedText, platforms);

      let results: Parameters<typeof resolveDegradedOutcome>[2] = [];
      let cards: readonly UnnumberedCard[] = [];
      if (plan !== null && plan.platforms.length > 0) {
        const searched = await deps.tools.searchKeyword(plan, toolContext(request, ctx));
        if (signal.aborted) return stopped();
        // Same point as the core's tool path: after the search returns, before any card write.
        if (searched.trace !== undefined) reportTrace(deps, searched.trace);
        results = searched.results;
        cards = searched.cards;
      }

      const outcome = resolveDegradedOutcome(request.reason, plan, results);
      if (outcome.kind === 'error') {
        const msg = await deps.errorMsg(appId, outcome.code);
        if (signal.aborted) return stopped();
        return {
          kind: 'error',
          error: {
            code: outcome.code,
            msg,
            // error-codes.yaml 50302: retry_kind later -> retryable.
            retryable: true,
            fallback: 'search_page',
            fallback_q: outcome.fallback.q,
          },
        };
      }

      if (outcome.kind === 'empty') {
        const text = await deps.texts.text(appId, outcome.noticeKey);
        if (signal.aborted) return stopped();
        await ctx.card({
          type: 'notice',
          schema_version: 1,
          data: { level: 'info', text_key: outcome.noticeKey, actions: [] },
          fallback_text: text,
        });
        if (signal.aborted) return stopped();
        return { kind: 'done', finishReason: outcome.finishReason };
      }

      for (const card of cards) {
        await ctx.card(card);
        if (signal.aborted) return stopped();
      }
      const text = await deps.texts.text(appId, outcome.textKey);
      if (signal.aborted) return stopped();
      ctx.text(text);
      return { kind: 'done', finishReason: outcome.finishReason };
    },
  };
}
