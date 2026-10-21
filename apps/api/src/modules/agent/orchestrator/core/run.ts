// B3-05b: one Agent run (contract in factories.ts). Every piece of state lives in AgentRun, one
// instance per run: model clock, OutputGuard, counters, delivered flag and trace never leak
// between runs of the same factory.
import { platform as platformEnum } from '@couli/contracts-ts';
import type { Platform } from '@couli/contracts-ts';
import type { RunBodyInput } from '../../http/index.ts';
import { createOutputGuard } from '../../guard/index.ts';
import type { GuardEmit, OutputGuard } from '../../guard/index.ts';
import type { DegradeReason } from '../../model-gateway/degraded/index.ts';
import type { AssembledToolCall, ChatMessage } from '../../model-gateway/openai-compat/index.ts';
import type { AttemptRecord } from '../../model-gateway/routing/index.ts';
import type { RunBodyResult, RunContext, UnnumberedCard } from '../../stream/run/index.ts';
import { StreamProtocolError } from '../../stream/writer/index.ts';
import { openCardCall } from './card-references.ts';
import type { CardCall } from './card-references.ts';
import { RunOutput } from './output.ts';
import type { CardWrite } from './output.ts';
import type {
  AgentRunBodyDeps,
  InputProceed,
  OrchestratorTrace,
  ToolContext,
  ToolOutcome,
  ToolTraceFragment,
} from './ports.ts';

const ABORTED: unique symbol = Symbol('aborted');
type Aborted = typeof ABORTED;

type Done = Extract<RunBodyResult, { kind: 'done' }>;
const done = (finishReason: Done['finishReason']): Done => ({ kind: 'done', finishReason });

const INVALID_ARGS = { error: 'invalid_args' } as const;
/** Degrade reason for a model answer in an invalid format (see ports.ts header). */
const INVALID_FORMAT_REASON: DegradeReason = 'models_failed';
const PLATFORMS: readonly string[] = platformEnum;
/** B3-05j: intent of the link branch (deterministic path or its empty fallback). */
const LINK_INTENT = 'find_by_link';
/** B3-05j default: a degraded run without a model intent is a keyword search (BR-AI-14). */
const DEGRADED_INTENT = 'search';
/** The tool the deterministic path reports, one start → end / failed pair per url link. */
const QUOTE_TOOL = 'get_rebate_quote';

type ToolStatus = OrchestratorTrace['tool_calls'][number]['status'];
type CardSource = NonNullable<ToolTraceFragment['card_sources']>[number];
type LinkRegistration = NonNullable<ToolTraceFragment['link_registrations']>[number];

/** The platform argument as a validated enum value; anything else uses the generic template. */
function platformOf(args: unknown): Platform | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)['platform'];
  return typeof value === 'string' && PLATFORMS.includes(value) ? (value as Platform) : undefined;
}

function parseArgs(raw: string): { readonly ok: boolean; readonly args: unknown } {
  if (raw.trim() === '') return { ok: true, args: {} };
  try {
    return { ok: true, args: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, args: raw };
  }
}

/**
 * A final-round reply shaped as an intent object ({"agent_intent": …}, optionally fenced).
 * Returns the declared intent name (null when not a string), or undefined for ordinary text.
 * Unparseable text that still opens an object naming agent_intent counts as an intent: it is
 * never delivered as explanation.
 */
export function intentOf(text: string): { readonly name: string | null } | undefined {
  let body = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(body);
  if (fence !== null) body = (fence[1] ?? '').trim();
  if (!body.startsWith('{')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return body.includes('"agent_intent"') ? { name: null } : undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if (!Object.hasOwn(value, 'agent_intent')) return undefined;
  const name = (value as Record<string, unknown>)['agent_intent'];
  return { name: typeof name === 'string' ? name : null };
}

/** Whole text without surrounding white space and one ``` fence (closed or not). */
function unfenced(text: string): string {
  const body = text.trim();
  const fence = /^```[\w-]*[^\S\r\n]*\r?\n?([\s\S]*?)\s*(?:```)?$/u.exec(body);
  return fence === null ? body : (fence[1] ?? '').trim();
}

const ARRAY_LIKE = /^\[\s*(?:[{["\d\]-]|true\b|false\b|null\b)/u;
const OBJECT_MEMBER = /\{\s*"(?:[^"\\]|\\[\s\S])*"\s*:/u;

function hasStructuredStart(body: string): boolean {
  if (body.startsWith('{')) return true;
  if (!body.startsWith('[')) return false;
  try {
    JSON.parse(body);
    return true;
  } catch {
    return ARRAY_LIKE.test(body);
  }
}

/**
 * BR-AI-06: inspect the whole round before any delta is delivered, including JSON objects
 * embedded in prose or code fences. Keep rejecting malformed structured starts; ordinary
 * inline braces and bracketed tags without a JSON member remain explanation text.
 */
export function isStructuredText(text: string): boolean {
  if (OBJECT_MEMBER.test(text) || hasStructuredStart(unfenced(text))) return true;
  // Fences may follow prose and contain arrays without object members, or incomplete JSON.
  for (const fence of text.matchAll(/```[\w-]*[^\S\r\n]*\r?\n?([\s\S]*?)(?:```|$)/gu)) {
    if (hasStructuredStart((fence[1] ?? '').trim())) return true;
  }
  return false;
}

class AgentRun {
  private readonly deps: AgentRunBodyDeps;
  private readonly input: RunBodyInput;
  private readonly signal: AbortSignal;
  private readonly appId: string;
  private readonly out: RunOutput;
  private readonly abortGate: Promise<Aborted>;
  private readonly onAbort: () => void;
  /** Model or tool text / card / suggestions written (input notices excluded, plan U-11). */
  private delivered = false;
  private guard: OutputGuard | null = null;
  private placeholders: Readonly<Record<string, string>> = {};
  private intent: string | null = null;
  private formatInvalid = false;
  private model: string | null = null;
  private promptVersion = 'none';
  private readonly attempts: AttemptRecord[] = [];
  private readonly toolTrace: OrchestratorTrace['tool_calls'][number][] = [];
  private readonly cardSources: CardSource[] = [];
  private readonly linkRegistrations: LinkRegistration[] = [];
  /** Set once the trace is recorded: later path output never changes it. */
  private traced = false;

  constructor(deps: AgentRunBodyDeps, input: RunBodyInput, ctx: RunContext) {
    this.deps = deps;
    this.input = input;
    this.signal = ctx.signal;
    this.appId = input.caller.appId;
    this.out = new RunOutput(ctx, deps.limits);
    let resolveAbort: (value: Aborted) => void = () => undefined;
    this.abortGate = new Promise<Aborted>((resolve) => {
      resolveAbort = resolve;
    });
    this.onAbort = () => resolveAbort(ABORTED);
    if (this.signal.aborted) this.onAbort();
    else this.signal.addEventListener('abort', this.onAbort, { once: true });
  }

  async run(): Promise<RunBodyResult> {
    if (this.signal.aborted) {
      this.release();
      return done('stop');
    }
    try {
      return await this.main();
    } finally {
      this.release();
      this.recordTrace();
    }
  }

  private release(): void {
    this.signal.removeEventListener('abort', this.onAbort);
  }

  /** Awaits a port, giving up at once on abort; a late result or rejection is discarded. */
  private async wait<T>(pending: Promise<T>): Promise<T | Aborted> {
    let value: T | Aborted;
    try {
      value = await Promise.race([pending, this.abortGate]);
    } catch (error) {
      if (this.signal.aborted) return ABORTED;
      throw error;
    }
    return this.signal.aborted ? ABORTED : value;
  }

  /** Result of a path or of the core: cancellation, then a reached output cap, win. */
  private final(result: RunBodyResult): RunBodyResult {
    if (this.signal.aborted) return done('stop');
    if (this.out.limitHit) return done('limit');
    return result;
  }

  private async main(): Promise<RunBodyResult> {
    const checked = await this.wait(this.deps.inputCheck.check(this.input, this.signal));
    if (checked === ABORTED) return done('stop');
    if (checked.kind === 'refuse') {
      if (!(await this.fixed(checked.textKey))) return done('stop');
      return this.final({
        kind: 'done',
        finishReason: checked.finishReason,
        ...(checked.ending === undefined ? {} : { ending: checked.ending }),
      });
    }
    this.placeholders = checked.placeholders;
    // Notices: once, by the core, before any path output; never "delivered content" (U-11).
    for (const notice of checked.notices) {
      if ((await this.card(notice)) === ABORTED) return done('stop');
      if (this.out.limitHit) return done('limit');
    }
    if (checked.links.length > 0) return this.linkPath(checked);
    return this.modelPath(checked);
  }

  /** Fixed server text by key; false when cancelled. */
  private async fixed(key: string): Promise<boolean> {
    const text = await this.wait(this.deps.texts.text(this.appId, key));
    if (text === ABORTED) return false;
    return this.out.text(text);
  }

  /** Writes a core card; an invalid card is dropped and the run goes on (B3-03b). */
  private async card(card: UnnumberedCard): Promise<boolean | Aborted> {
    const written = await this.deliver(card);
    return written === ABORTED ? ABORTED : written.written;
  }

  /** card(), with the delivered frame's card_id for reference resolution (B3-05i). */
  private async deliver(card: UnnumberedCard): Promise<CardWrite | Aborted> {
    try {
      return await this.wait(this.out.deliver(card));
    } catch (error) {
      if (error instanceof StreamProtocolError && error.code === 'invalid_frame') {
        return { written: false, cardId: null };
      }
      throw error;
    }
  }

  private async linkPath(proceed: InputProceed): Promise<RunBodyResult> {
    this.intent = LINK_INTENT;
    const deterministic = this.deps.deterministic;
    if (deterministic !== undefined) {
      const result = await this.wait(
        deterministic.run({ input: this.input, proceed }, this.quoteObserver(proceed)),
      );
      return result === ABORTED ? done('stop') : this.final(result);
    }
    const key = 'agent.degraded.empty';
    const fallback = await this.wait(this.deps.texts.text(this.appId, key));
    if (fallback === ABORTED) return done('stop');
    const notice: UnnumberedCard = {
      type: 'notice',
      schema_version: 1,
      data: { level: 'info', text_key: key, actions: [] },
      fallback_text: fallback,
    };
    if ((await this.card(notice)) === ABORTED) return done('stop');
    return this.final(done('fallback'));
  }

  /**
   * B3-05j: the guarded context for the deterministic path, observing its tool.status pairs.
   * The n-th get_rebate_quote start belongs to the n-th url link (tokens run no tool); its end /
   * failed records one call with args { link_index } (1-based position in proceed.links, never
   * the raw link), masked like a model call. A start without its end (cancellation) is not
   * recorded; nothing is recorded after the trace was written. Not counted in limits.toolCalls.
   */
  private quoteObserver(proceed: InputProceed): RunContext {
    const ctx = this.out.context();
    const urlIndexes: number[] = [];
    proceed.links.forEach((link, i) => {
      if (link.kind === 'url') urlIndexes.push(i + 1);
    });
    let started = 0;
    let open: number | null = null;
    const observe = (tool: string, phase: 'start' | 'end' | 'failed'): void => {
      if (tool !== QUOTE_TOOL || this.traced || this.signal.aborted) return;
      if (phase === 'start') {
        open = urlIndexes[started] ?? null;
        started += 1;
        return;
      }
      if (open === null) return;
      const linkIndex = open;
      open = null;
      this.traceCall(QUOTE_TOOL, { link_index: linkIndex }, phase === 'end' ? 'ok' : 'failed');
    };
    return {
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
      get cardsDelivered() {
        return ctx.cardsDelivered;
      },
      text: (delta) => ctx.text(delta),
      toolStatus: (tool, phase, display) => {
        observe(tool, phase);
        ctx.toolStatus(tool, phase, display);
      },
      card: (card) => ctx.card(card),
      suggestions: (items) => ctx.suggestions(items),
    };
  }

  private async degrade(proceed: InputProceed, reason: DegradeReason): Promise<RunBodyResult> {
    // An intent the model already gave is kept; otherwise the no-model keyword search's.
    if (this.intent === null) this.intent = DEGRADED_INTENT;
    const result = await this.wait(
      this.deps.degraded.run({ reason, input: this.input, proceed }, this.out.context()),
    );
    return result === ABORTED ? done('stop') : this.final(result);
  }

  private async modelPath(proceed: InputProceed): Promise<RunBodyResult> {
    const prompt = await this.wait(this.deps.prompt.current(this.appId));
    if (prompt === ABORTED) return done('stop');
    if (prompt === null) return this.degrade(proceed, 'route_no_model');
    this.promptVersion = prompt.version;
    const tools = await this.wait(this.deps.tools.definitions(this.appId, this.input.caller));
    if (tools === ABORTED) return done('stop');
    const known = new Set(tools.map((tool) => tool.name));
    const clock = this.deps.modelClock();
    this.guard = createOutputGuard({ review: this.deps.review });
    const messages: ChatMessage[] = [{ role: 'user', content: proceed.modelText }];
    let toolCalls = 0;
    for (let round = 1; ; round += 1) {
      const outcome = await this.wait(
        this.deps.model.complete(
          { system: prompt.system, tools, messages: [...messages] },
          { clock, signal: this.signal },
        ),
      );
      if (outcome === ABORTED) return done('stop');
      this.attempts.push(...outcome.attempts);
      if (outcome.kind === 'aborted') return done('stop');
      if (outcome.kind === 'refused') {
        if (!(await this.fixed('agent.refuse.unsafe')) && this.signal.aborted) return done('stop');
        return done('safety');
      }
      if (outcome.kind === 'degraded') {
        // U-11: degrade only before any model / tool content; otherwise end with what was sent.
        if (!this.delivered) return this.degrade(proceed, outcome.reason);
        return this.finishText('stop');
      }
      this.model = outcome.model;
      const deltas: string[] = [];
      const calls: AssembledToolCall[] = [];
      for (const event of outcome.events) {
        if (event.t === 'text_delta') deltas.push(event.text);
        else if (event.t === 'tool_call') calls.push(event.call);
      }
      const roundText = deltas.join('');
      if (calls.length === 0) return this.finalRound(proceed, deltas, roundText);
      // Same format check as the final round, before any of this text reaches the guard.
      if (isStructuredText(roundText)) return this.invalidFormat(proceed);
      const pushed = await this.pushText(deltas);
      if (pushed !== null) return pushed;
      // The last allowed round still asks for tools: its calls are not run (U-10).
      if (round >= this.deps.limits.modelRounds) return this.finishText('limit');
      messages.push({ role: 'assistant', content: roundText || null, tool_calls: calls });
      for (const call of calls) {
        if (toolCalls >= this.deps.limits.toolCalls) return this.finishText('limit');
        toolCalls += 1;
        const step = await this.runTool(call, known);
        if (!('view' in step)) return step;
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(step.view) });
      }
    }
  }

  private async finalRound(
    proceed: InputProceed,
    deltas: readonly string[],
    text: string,
  ): Promise<RunBodyResult> {
    const blank = text.trim() === '';
    const intent = blank ? undefined : intentOf(text);
    if (intent !== undefined) this.intent = intent.name;
    const intents = this.deps.intents;
    if (intents !== undefined && !blank) {
      const handled = await this.wait(
        intents.handle({ text, input: this.input, proceed }, this.out.context()),
      );
      if (handled === ABORTED) return done('stop');
      if (handled !== null) return this.final(handled);
    } else if (intent !== undefined) {
      // U-7: without an IntentPort every intent output is out_of_scope; model text is dropped.
      if (!(await this.fixed('agent.refuse.out_of_scope')) && this.signal.aborted) {
        return done('stop');
      }
      return this.final(done('stop'));
    }
    if (isStructuredText(text)) return this.invalidFormat(proceed);
    const pushed = await this.pushText(deltas);
    if (pushed !== null) return pushed;
    return this.finishText('stop');
  }

  /**
   * Model text that is structured data (card JSON etc.) is dropped as an invalid answer: before
   * any model / tool content it degrades like "no usable model answer" (models_failed); after
   * delivery it flushes the guard tail and ends normally (U-11). Trace records the deviation.
   */
  private async invalidFormat(proceed: InputProceed): Promise<RunBodyResult> {
    this.formatInvalid = true;
    if (!this.delivered) return this.degrade(proceed, INVALID_FORMAT_REASON);
    return this.finishText('stop');
  }

  /** Model text through the OutputGuard; a result means the run ends here. */
  private async pushText(deltas: readonly string[]): Promise<RunBodyResult | null> {
    const guard = this.guard;
    if (guard === null) return null;
    for (const delta of deltas) {
      const emits = await this.wait(guard.push(delta));
      if (emits === ABORTED) return done('stop');
      const stop = await this.writeEmits(emits, guard);
      if (stop !== null) return stop;
    }
    return null;
  }

  /** Flushes the guard (end of run) and ends with `reason` unless the flush decides otherwise. */
  private async finishText(reason: Done['finishReason']): Promise<RunBodyResult> {
    const guard = this.guard;
    if (guard !== null && !this.out.limitHit) {
      const emits = await this.wait(guard.end());
      if (emits === ABORTED) return done('stop');
      const stop = await this.writeEmits(emits, guard);
      if (stop !== null) return stop;
    }
    return this.final(done(reason));
  }

  /** One ctx.text per GuardEmit, in guard order. */
  private async writeEmits(
    emits: readonly GuardEmit[],
    guard: OutputGuard,
  ): Promise<RunBodyResult | null> {
    for (const emit of emits) {
      let text: string;
      if (emit.kind === 'text') {
        text = emit.text;
      } else {
        const fixed = await this.wait(this.deps.texts.text(this.appId, emit.key));
        if (fixed === ABORTED) return done('stop');
        text = fixed;
      }
      if (this.out.text(text)) this.delivered = true;
      if (emit.kind === 'fixed' && emit.key === 'agent.refuse.output_blocked') {
        return done('safety');
      }
      if (this.out.limitHit) return done('limit');
    }
    if (this.signal.aborted) return done('stop');
    return guard.stopped ? done('safety') : null;
  }

  private traceCall(name: string, args: unknown, status: ToolStatus): void {
    let masked: unknown;
    try {
      masked = this.deps.traceMask(args, this.placeholders);
    } catch {
      // Never fall back to the unmasked arguments.
      masked = null;
    }
    this.toolTrace.push({ name, args: masked, status });
  }

  private async runTool(
    call: AssembledToolCall,
    known: ReadonlySet<string>,
  ): Promise<{ readonly view: unknown } | RunBodyResult> {
    const name = call.function.name;
    const parsed = parseArgs(call.function.arguments);
    if (!known.has(name)) {
      // Unregistered name: no execute, template or tool.status; the call still counts.
      this.traceCall(name, parsed.args, 'rejected');
      return { view: INVALID_ARGS };
    }
    const platform = platformOf(parsed.args);
    const texts = this.deps.texts;
    const start = await this.wait(texts.toolDisplay(this.appId, name, 'start', platform));
    if (start === ABORTED) return done('stop');
    this.out.status(name, 'start', start);
    // B3-05i: each call gets its own copy of the run's placeholders table; that object's identity
    // binds cardReference to this call (card-references.ts header). Same entries, frozen.
    const placeholders = Object.freeze({ ...this.placeholders });
    const refs = openCardCall(call.id, placeholders);
    try {
      let outcome: ToolOutcome;
      if (parsed.ok) {
        const executed = await this.wait(
          this.deps.tools.execute(
            { id: call.id, name, args: parsed.args },
            this.toolContext(placeholders),
          ),
        );
        if (executed === ABORTED) return done('stop');
        outcome = executed;
      } else {
        outcome = { kind: 'rejected', modelView: INVALID_ARGS };
      }
      // References are issued while execute runs; none can be added once the outcome is in.
      refs.close();
      const phase = outcome.kind === 'ok' ? 'end' : 'failed';
      const display = await this.wait(texts.toolDisplay(this.appId, name, phase, platform));
      if (display === ABORTED) return done('stop');
      this.out.status(name, phase, display);
      this.traceCall(name, parsed.args, outcome.kind);
      if (outcome.kind === 'ok') {
        const stop = await this.toolOutput(outcome, refs);
        if (stop !== null) return stop;
      }
      // Only this resolved copy reaches the model (unchanged when no reference was issued).
      return { view: refs.view(outcome.modelView) };
    } finally {
      refs.close();
    }
  }

  /**
   * Cards and suggestions of a successful call, in order; a result means the run ends here.
   * Each card's delivered frame card_id is recorded for this call's references (B3-05i).
   */
  private async toolOutput(
    outcome: Extract<ToolOutcome, { readonly kind: 'ok' }>,
    refs: CardCall,
  ): Promise<RunBodyResult | null> {
    try {
      for (const card of outcome.cards) {
        const written = await this.deliver(card);
        if (written === ABORTED) return done('stop');
        refs.delivered(written.cardId);
        if (written.written) this.delivered = true;
        if (this.out.limitHit) return done('limit');
      }
      const suggestions = outcome.suggestions ?? [];
      if (suggestions.length > 0) {
        if (this.out.suggestions(suggestions)) this.delivered = true;
        if (this.out.limitHit) return done('limit');
      }
      return null;
    } finally {
      // On every exit (limit, cancellation, a thrown write), after delivery: the trace gets
      // delivered card ids, and records naming an undelivered card's reference are left out.
      this.cardSources.push(...refs.records(outcome.trace?.card_sources ?? [], ['card_id']));
      this.linkRegistrations.push(
        ...refs.records(outcome.trace?.link_registrations ?? [], ['link_id', 'product_key']),
      );
    }
  }

  private toolContext(placeholders: Readonly<Record<string, string>>): ToolContext {
    const input = this.input;
    return {
      subject: input.caller,
      ...(input.context === undefined ? {} : { context: input.context }),
      runId: input.runId,
      sessionId: input.sessionId,
      signal: this.signal,
      placeholders,
    };
  }

  private recordTrace(): void {
    this.traced = true;
    const sink = this.deps.trace;
    if (sink === undefined) return;
    const summary = this.guard?.summary();
    const trace: OrchestratorTrace = {
      intent: this.intent,
      model: this.model,
      attempts: [...this.attempts],
      prompt_version: this.promptVersion,
      tool_calls: [...this.toolTrace],
      output_filtered: summary?.outputFiltered ?? false,
      filter_hits: summary?.filterHits ?? [],
      output_truncated: summary?.outputTruncated ?? false,
      model_format_invalid: this.formatInvalid,
      ...(this.cardSources.length > 0 ? { card_sources: [...this.cardSources] } : {}),
      ...(this.linkRegistrations.length > 0
        ? { link_registrations: [...this.linkRegistrations] }
        : {}),
    };
    try {
      sink.record(this.input.runId, trace);
    } catch {
      // Trace is best effort; it never changes the run's result.
    }
  }
}

export function runAgent(
  deps: AgentRunBodyDeps,
  input: RunBodyInput,
  ctx: RunContext,
): Promise<RunBodyResult> {
  return new AgentRun(deps, input, ctx).run();
}
