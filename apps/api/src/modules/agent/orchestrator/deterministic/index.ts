// B3-05e: deterministic link path (BR-AI-01 A-level resolve_link; BR-AI-04; BR-AI-05).
// The core enters this path whenever input check found links, before any prompt or model read,
// so it also serves no-model routes and exhausted budgets (BR-AI-14 细则「无模型降级」first step).
// Links go one by one, in order of appearance, through the B3-04c LinkQuoteRunner (resolve_link →
// get_rebate_quote → register_links: registration only, never a conversion). Each link's failure
// is handled on its own; the rest of the material is untrusted text and has no effect here.
import type { Candidate } from '../../../parsing/index.ts';
import type { LinkQuoteOutcome, LinkQuoteRunner } from '../../tools/quote/index.ts';
import type { ToolCallContext } from '../../tools/registry/index.ts';
import type { RunBodyResult, RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import type {
  AgentRunTexts,
  DeterministicPath,
  PathInput,
  ToolTraceFragment,
} from '../core/ports.ts';

export interface DeterministicPathDeps {
  readonly quotes: LinkQuoteRunner;
  readonly texts: AgentRunTexts;
  /** Optional receiver of each successful link's trace fragment (link_registrations), handed
   * over unchanged as DegradedPathDeps.onTrace does. Best effort: it never changes the result. */
  readonly onTrace?: (fragment: ToolTraceFragment) => void;
}

type Done = Extract<RunBodyResult, { kind: 'done' }>;

function stopped(): Done {
  return { kind: 'done', finishReason: 'stop' };
}

function toolName(): 'get_rebate_quote' {
  return 'get_rebate_quote';
}

/** BR-TEXT-14 error text keys; the code alone selects the key, never the material. */
function errorKey(code: number): string {
  return `error.${code}`;
}

/** Default for a token (tpwd): the B3-04c runner handles URLs only; token quoting is a separate
 * task, so the link gets the "token not recognised" notice and the runner is not called. */
function tokenErrorCode(): 30132 {
  return 30132;
}

/** Default for price_unavailable / no_card / a thrown runner: dependency unavailable. No
 * substitute card and no filled-in number (BR-AI-04 required fields). */
function unavailableCode(): 50301 {
  return 50301;
}

/** Candidate.kind is a plain union field; narrow without copying (runner gets the same object). */
function isUrl(link: Candidate): link is Candidate & { readonly kind: 'url' } {
  return link.kind === 'url';
}

/** Identity only from the authenticated caller; never from the message text or context. */
function toolContext(request: PathInput, ctx: RunContext): ToolCallContext {
  const input = request.input;
  return {
    appId: input.caller.appId,
    userId: input.caller.userId,
    deviceId: input.caller.deviceId,
    phoneBound: input.caller.phoneBound,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    signal: ctx.signal,
    placeholders: request.proceed.placeholders,
    ...(input.context === undefined ? {} : { context: input.context }),
  };
}

function reportTrace(deps: DeterministicPathDeps, fragment: ToolTraceFragment): void {
  if (deps.onTrace === undefined) return;
  try {
    deps.onTrace(fragment);
  } catch {
    // Trace is best effort; it never changes the run's result.
  }
}

/**
 * Per link, in proceed.links order (already deduplicated and capped by the input check):
 * - url: tool.status start → runner → end + its cards, or failed + one error notice;
 * - tpwd: one error.30132 notice, runner not called, no tool.status (no tool ran).
 * parse_error uses its own error code; price_unavailable, no_card and any thrown error use 50301.
 * The thrown error's message never reaches a frame. proceed.notices are emitted by the core only
 * and never repeated here. No text.delta is written (no model, no fixed explanation text).
 * The run ends done stop whether some or all links failed; abort is checked after every await
 * and suppresses all later output.
 */
export function createDeterministicPath(deps: DeterministicPathDeps): DeterministicPath {
  async function notice(appId: string, code: number, ctx: RunContext): Promise<boolean> {
    const key = errorKey(code);
    const text = await deps.texts.text(appId, key);
    if (ctx.signal.aborted) return false;
    const card: UnnumberedCard = {
      type: 'notice',
      schema_version: 1,
      data: { level: 'warn', text_key: key, actions: [] },
      fallback_text: text,
    };
    await ctx.card(card);
    return !ctx.signal.aborted;
  }

  async function status(
    appId: string,
    phase: 'start' | 'end' | 'failed',
    ctx: RunContext,
  ): Promise<boolean> {
    const display = await deps.texts.toolDisplay(appId, toolName(), phase);
    if (ctx.signal.aborted) return false;
    ctx.toolStatus(toolName(), phase, display);
    return true;
  }

  /** Returns false once the run was aborted. */
  async function quoteLink(
    request: PathInput,
    link: Candidate & { readonly kind: 'url' },
    ctx: RunContext,
  ): Promise<boolean> {
    const appId = request.input.caller.appId;
    if (!(await status(appId, 'start', ctx))) return false;

    let outcome: LinkQuoteOutcome | null;
    try {
      outcome = await deps.quotes.run(link, toolContext(request, ctx));
    } catch {
      // Only this link fails; the error never bubbles up as a run error.
      outcome = null;
    }
    if (ctx.signal.aborted) return false;

    if (outcome === null || outcome.kind !== 'ok') {
      if (!(await status(appId, 'failed', ctx))) return false;
      const code = outcome?.kind === 'parse_error' ? outcome.error_code : unavailableCode();
      return notice(appId, code, ctx);
    }

    if (!(await status(appId, 'end', ctx))) return false;
    if (outcome.trace !== undefined) reportTrace(deps, outcome.trace);
    for (const card of outcome.cards) {
      await ctx.card(card);
      if (ctx.signal.aborted) return false;
    }
    return true;
  }

  return {
    async run(request, ctx) {
      const appId = request.input.caller.appId;
      for (const link of request.proceed.links) {
        if (ctx.signal.aborted) return stopped();
        const live = isUrl(link)
          ? await quoteLink(request, link, ctx)
          : await notice(appId, tokenErrorCode(), ctx);
        if (!live) return stopped();
      }
      return stopped();
    },
  };
}
