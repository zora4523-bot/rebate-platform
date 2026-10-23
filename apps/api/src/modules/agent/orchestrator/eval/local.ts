// B3-05m: local evaluation wiring (BR-AI-21; BR-AI-14). The agent under test is the production
// run body, assembled by the same createAgentBodyAssembly the stream entry uses (stream/mount/
// body.ts), with the real input check (B3-05d) and redaction, the real vendor gateway and model
// router over this turn's non-billable port transport, and tools that answer from the evaluation's
// tool port. Only the input reviewer is a stand-in (default: pass). Time and ids come only from the
// injected clock and id sequence: the scheduler is derived from that clock (time never passes, so
// no timer fires), nothing reads the environment, and nothing here calls a real model or reviewer.
// Recording misses of either port escape unchanged (never a failed tool or a fallback answer).
import { createHash } from 'node:crypto';
import type { Scheduler } from '../../../platform/index.ts';
import type { AgentCaller, RunBodyInput } from '../../http/index.ts';
import type { SentenceReviewPort } from '../../guard/index.ts';
import type {
  KeywordSearchPlan,
  PlatformSearchResult,
} from '../../model-gateway/degraded/index.ts';
import type { ToolDefinition } from '../../model-gateway/openai-compat/index.ts';
import {
  createModelRouter,
  createRunModelClock,
  type ModelRouterConfig,
  type ResolvedRoute,
} from '../../model-gateway/routing/index.ts';
import { createVendorGateway, type UsageSink } from '../../model-gateway/vendors/index.ts';
import { createInputCheck } from '../../preprocess/input/index.ts';
import { createAgentRedactor } from '../../preprocess/redact/index.ts';
import { admissionDefaults } from '../../stream/admission/index.ts';
import { createAgentBodyAssembly } from '../../stream/mount/body.ts';
import { productionRunTexts } from '../../stream/mount/production.ts';
import { agentDefaultTexts } from '../../stream/mount/texts.ts';
import { runTimingsDefaults } from '../../stream/pg/index.ts';
import { numberCard } from '../../stream/run/index.ts';
import type { RunBody, UnnumberedCard } from '../../stream/run/index.ts';
import { createFrameValidator } from '../../stream/writer/index.ts';
import type {
  AgentRunTexts,
  KeywordSearchOutcome,
  OrchestratorTools,
  PromptSource,
  ToolContext,
  ToolOutcome,
  ToolTraceFragment,
} from '../core/ports.ts';
import { createEvalAgent, isRecordingMiss } from './adapter.ts';
import type { EvalBindings, EvalInput, EvalPorts, EvalRun, EvalTurnOutput } from './adapter.ts';

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

/** The app every synthetic caller belongs to. */
function evalAppId(): string {
  return 'couli';
}

/** Port name of the no-model keyword search; never a model tool, never in tool_set. */
function degradedSearchTool(): string {
  return 'degraded_keyword_search';
}

/** A scheduler on the injected clock: time only moves with that clock, so with a fixed clock
 * no deadline (input review, model attempt) ever fires; a wait ends only by its abort. */
function clockScheduler(clock: LocalEvalAgentDeps['clock']): Scheduler {
  return {
    now: () => clock.now().getTime(),
    sleep: (_ms, signal) =>
      new Promise<void>((_resolve, reject) => {
        if (signal === undefined) return;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  };
}

/** The router's per-attempt limit is the run's model budget; the breaker never opens within an
 * evaluation (one router per run, failures are evaluated, not shed). */
function evalRouterConfig(runMaxMs: number): ModelRouterConfig {
  return {
    attemptTimeoutMs: runMaxMs,
    breaker: { windowMs: 60_000, minRequests: 1_000_000, failureRatePercent: 99, openMs: 1 },
  };
}

/** Non-billable port transport: nothing is metered (BR-AI-16: evaluations are not charged). */
function silentMeter(): UsageSink {
  return { record: () => undefined };
}

function passingReview(): SentenceReviewPort {
  return { review: async () => 'pass' };
}

function noPrompt(): PromptSource {
  return { current: async () => null };
}

async function noModelRoute(): Promise<ResolvedRoute> {
  return { mode: 'no_model', attempts: [], dropped: [] };
}

function emptyCatalog(): EvalToolCatalog {
  return { definitions: async () => [], enabledSearchPlatforms: async () => [] };
}

/** The stream entry's production copy (B3-03j), tool status over the catalog's search platforms.
 * A missing status text is not logged here: the evaluation has no logger (frames carry it). */
function runTexts(catalog: EvalToolCatalog): AgentRunTexts {
  return productionRunTexts((appId) => catalog.enabledSearchPlatforms(appId), {
    warn: () => undefined,
  });
}

/** Synthetic subject: a guest, a logged-in user without phone, or a member with a bound phone.
 * Switches are not part of the run body (access is checked before a run, BR-AI-12). */
function callerOf(input: EvalInput, traceId: string): AgentCaller {
  return {
    appId: evalAppId(),
    traceId,
    deviceId: 'eval-device',
    deviceHash: 'eval-device-hash',
    ipKey: 'eval-ip',
    userId: input.subject === 'guest' ? null : 'eval-user',
    phoneBound: input.subject === 'bound_phone',
  };
}

/** Card numbers a card takes (envelope plus embedded products), as the writer numbers it. */
function cardNumbers(card: UnnumberedCard): number {
  try {
    return numberCard(card, 1).used;
  } catch {
    return 0;
  }
}

/** The body, counting the card numbers it reserves so the next turn of the case goes on. */
function countingCards(body: RunBody, onUsed: (count: number) => void): RunBody {
  return (ctx) =>
    body({
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      signal: ctx.signal,
      get cardsDelivered() {
        return ctx.cardsDelivered;
      },
      text: (delta) => ctx.text(delta),
      toolStatus: (tool, phase, display) => ctx.toolStatus(tool, phase, display),
      card: (card, delivered) => {
        onUsed(cardNumbers(card));
        return ctx.card(card, delivered);
      },
      suggestions: (items) => ctx.suggestions(items),
    });
}

interface CaseSession {
  readonly sessionId: string;
  nextCard: number;
}

export function createLocalEvalAgent(
  deps: LocalEvalAgentDeps,
): (input: EvalInput, ports: EvalPorts) => Promise<EvalTurnOutput> {
  const { clock, ids } = deps;
  const review = deps.review ?? passingReview();
  const prompt = deps.prompt ?? noPrompt();
  const route = deps.route ?? noModelRoute;
  const catalog = deps.catalog ?? emptyCatalog();
  const scheduler = clockScheduler(clock);
  const runMaxMs = runTimingsDefaults().runMaxMs;
  const texts = runTexts(catalog);
  const errors = agentDefaultTexts();
  const redactor = createAgentRedactor();
  const sessions = new Map<string, CaseSession>();

  const createRun = async (input: EvalInput, bindings: EvalBindings): Promise<EvalRun> => {
    // The case's text decides untrusted input, as in production (links, share labels; BR-AI-05).
    void input.untrusted;
    const appId = evalAppId();
    let session = sessions.get(input.case_id);
    if (session === undefined) {
      session = { sessionId: ids.next(), nextCard: 1 };
      sessions.set(input.case_id, session);
    }
    const current = session;
    // The stream entry's order: run id, user message id, assistant message id.
    const runId = ids.next();
    const userMessageId = ids.next();
    const assistantMessageId = ids.next();
    const caller = callerOf(input, runId);
    // One route per run, read by both the router and the labels.
    const resolved = structuredClone(await route(appId));
    const gateway = createVendorGateway({
      transport: bindings.transport,
      clock,
      onlineMeter: silentMeter(),
      offlineMeter: silentMeter(),
      offlineBudgetApproved: [],
      rewrittenSampleGrants: [],
      ownerAggregateApprovals: [],
    });
    const model = createModelRouter({
      gateway,
      route: () => resolved,
      budgetExhausted: () => false,
      config: evalRouterConfig(runMaxMs),
      scheduler,
      meter: silentMeter(),
      clock,
    });
    const assembly = createAgentBodyAssembly({
      model,
      modelClock: () => createRunModelClock(runMaxMs),
      tools: createPortTools(bindings.tool, catalog, input.turn),
      inputCheck: createInputCheck({ review, scheduler, texts }),
      review,
      texts,
      prompt,
      route: async () => resolved,
      errorMsg: async (_appId, code) => errors.errorMsg(code),
      trace: bindings.trace,
      ...(bindings.toolTrace === undefined ? {} : { onTrace: bindings.toolTrace }),
    });
    const labels = await assembly.labels.current(caller);
    const modelLabel = await assembly.labels.modelLabel(appId, labels.modelSnapshot);
    const aiLabel = await assembly.labels.aiLabel(appId);
    const runInput: RunBodyInput = {
      caller,
      sessionId: current.sessionId,
      runId,
      userMessageId,
      assistantMessageId,
      text: input.text,
      redactedText: await redactor.redact(appId, input.text),
      limits: admissionDefaults(),
    };
    return {
      body: countingCards(assembly.body(runInput), (count) => {
        current.nextCard += count;
      }),
      meta: {
        session_id: current.sessionId,
        run_id: runId,
        message_id: assistantMessageId,
        prompt_version: labels.promptVersion,
        model_label: modelLabel,
        ai_label: aiLabel,
      },
      quotaLeft: 0,
      firstCardNo: current.nextCard,
    };
  };

  const evaluate = createEvalAgent({ createRun });
  return async (input, ports) => {
    // Tool recording misses, kept even if a later layer turned the throw into something else.
    const misses: unknown[] = [];
    const tool: EvalPorts['tool'] = async (call) => {
      try {
        return await ports.tool(call);
      } catch (error) {
        if (isRecordingMiss(error)) misses.push(error);
        throw error;
      }
    };
    let output: EvalTurnOutput;
    try {
      output = await evaluate(input, { model: (request) => ports.model(request), tool });
    } catch (error) {
      if (isRecordingMiss(error) || misses.length === 0) throw error;
      throw misses[0];
    }
    if (misses.length > 0) throw misses[0];
    return output;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted at every level: the same definitions give the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

interface ToolConfig {
  readonly names: readonly string[];
  readonly fingerprint: string;
}

function toolConfig(definitions: readonly ToolDefinition[]): ToolConfig {
  return {
    names: definitions
      .map((definition) => definition.name)
      .filter((name) => name !== degradedSearchTool()),
    fingerprint: createHash('sha256').update(canonical(definitions)).digest('hex'),
  };
}

function failedTool(): ToolOutcome {
  return { kind: 'failed', modelView: { error: 'tool_unavailable' } };
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
  let config: ToolConfig | undefined;
  const configure = (definitions: readonly ToolDefinition[]): ToolConfig => {
    config = toolConfig(definitions);
    return config;
  };
  const request = async (
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<unknown> => {
    // The definitions this run's model saw; loaded here when the run never asked (degraded).
    const current = config ?? configure(await catalog.definitions(ctx.subject.appId, ctx.subject));
    return port({
      name,
      args,
      state: { turn, result_set_ids: [], tool_set: [...current.names] },
      config_fingerprint: current.fingerprint,
    });
  };
  return {
    async definitions(appId, subject) {
      const definitions = await catalog.definitions(appId, subject);
      configure(definitions);
      return definitions;
    },
    async execute(call, ctx) {
      // Tools own schema rejection: arguments that are not an object never reach a tool.
      if (!isRecord(call.args)) return { kind: 'rejected', modelView: { error: 'invalid_args' } };
      let response: unknown;
      try {
        response = await request(call.name, structuredClone(call.args), ctx);
      } catch (error) {
        if (isRecordingMiss(error)) throw error;
        return failedTool();
      }
      return decodeToolOutcome(response) ?? failedTool();
    },
    enabledSearchPlatforms: (appId) => catalog.enabledSearchPlatforms(appId),
    async searchKeyword(plan, ctx) {
      let response: unknown;
      try {
        response = await request(
          degradedSearchTool(),
          { q: plan.q, platforms: [...plan.platforms], sort: plan.sort },
          ctx,
        );
      } catch (error) {
        if (isRecordingMiss(error)) throw error;
        return failedSearch(plan);
      }
      return decodeSearch(response, plan) ?? failedSearch(plan);
    },
  };
}

function failedSearch(plan: KeywordSearchPlan): KeywordSearchOutcome {
  return { results: plan.platforms.map((platform) => ({ platform, ok: false })), cards: [] };
}

function decodePlatformResult(value: unknown): PlatformSearchResult | null {
  if (!isRecord(value) || typeof value['platform'] !== 'string') return null;
  if (value['ok'] === false) return { platform: value['platform'], ok: false };
  const items = value['items'];
  if (value['ok'] !== true || !Array.isArray(items)) return null;
  return { platform: value['platform'], ok: true, items: structuredClone(items) };
}

/** The search outcome of a recorded ok ToolOutcome; a platform the recording does not answer
 * counts as failed on that platform. */
function decodeSearch(response: unknown, plan: KeywordSearchPlan): KeywordSearchOutcome | null {
  const outcome = decodeToolOutcome(response);
  if (outcome?.kind !== 'ok' || !isRecord(outcome.modelView)) return null;
  const listed = outcome.modelView['results'];
  if (!Array.isArray(listed)) return null;
  const results: PlatformSearchResult[] = [];
  for (const item of listed) {
    const result = decodePlatformResult(item);
    if (result === null) return null;
    results.push(result);
  }
  return {
    results: plan.platforms.map(
      (platform) =>
        results.find((result) => result.platform === platform) ?? { platform, ok: false },
    ),
    cards: outcome.cards,
    ...(outcome.trace === undefined ? {} : { trace: outcome.trace }),
  };
}

function cloneJson(value: unknown): { value: unknown } | null {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

function decodeCards(value: unknown): UnnumberedCard[] | null {
  if (!Array.isArray(value)) return null;
  const validate = createFrameValidator();
  const cards: UnnumberedCard[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const copy = cloneJson(item);
    if (copy === null) return null;
    const card = copy.value as UnnumberedCard;
    let data: Record<string, unknown>;
    try {
      data = { ...numberCard(card, 1).card, seq: 2 };
    } catch {
      return null;
    }
    if (!validate({ event: 'card', id: 2, data }).ok) return null;
    cards.push(card);
  }
  return cards;
}

/** Suggestions as the suggestions frame contract takes them (nonempty texts, at most three):
 * a recording the writer would refuse is a failed tool, never an interrupted run. */
function decodeSuggestions(value: unknown): { text: string; send_text: string }[] | null {
  if (!Array.isArray(value)) return null;
  const items: { text: string; send_text: string }[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { text, send_text: sendText } = item;
    if (typeof text !== 'string' || typeof sendText !== 'string') return null;
    items.push({ text, send_text: sendText });
  }
  if (
    items.length > 0 &&
    !createFrameValidator()({ event: 'suggestions', id: 2, data: { items } }).ok
  ) {
    return null;
  }
  return items;
}

function isFieldValue(value: unknown): value is number | string | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function decodeTrace(value: unknown): ToolTraceFragment | null {
  if (!isRecord(value)) return null;
  const { card_sources: sources, link_registrations: links } = value;
  let cardSources: NonNullable<ToolTraceFragment['card_sources']> | undefined;
  if (sources !== undefined) {
    if (!Array.isArray(sources)) return null;
    const decoded: { card_id: string; fields: Record<string, number | string | boolean | null> }[] =
      [];
    for (const source of sources) {
      if (!isRecord(source) || typeof source['card_id'] !== 'string') return null;
      const fields = source['fields'];
      if (!isRecord(fields)) return null;
      const copy: Record<string, number | string | boolean | null> = {};
      for (const [key, field] of Object.entries(fields)) {
        if (!isFieldValue(field)) return null;
        copy[key] = field;
      }
      decoded.push({ card_id: source['card_id'], fields: copy });
    }
    cardSources = decoded;
  }
  let registrations: NonNullable<ToolTraceFragment['link_registrations']> | undefined;
  if (links !== undefined) {
    if (!Array.isArray(links)) return null;
    const decoded: { link_id: string; product_key: string; ok: boolean }[] = [];
    for (const link of links) {
      if (
        !isRecord(link) ||
        typeof link['link_id'] !== 'string' ||
        typeof link['product_key'] !== 'string' ||
        typeof link['ok'] !== 'boolean'
      ) {
        return null;
      }
      decoded.push({ link_id: link['link_id'], product_key: link['product_key'], ok: link['ok'] });
    }
    registrations = decoded;
  }
  return {
    ...(cardSources === undefined ? {} : { card_sources: cardSources }),
    ...(registrations === undefined ? {} : { link_registrations: registrations }),
  };
}

/** Validate the serializable ToolOutcome, including cards/trace; absent ok.cards means [].
 * Invalid recordings return null and become failed tools, never an interrupted run.
 */
export function decodeToolOutcome(response: unknown): ToolOutcome | null {
  if (!isRecord(response) || !('modelView' in response)) return null;
  const view = cloneJson(response['modelView']);
  if (view === null) return null;
  const kind = response['kind'];
  if (kind === 'failed') return { kind, modelView: view.value };
  if (kind === 'rejected') {
    const modelView = view.value;
    return isRecord(modelView) &&
      Object.keys(modelView).length === 1 &&
      modelView['error'] === 'invalid_args'
      ? { kind, modelView: { error: 'invalid_args' } }
      : null;
  }
  if (kind !== 'ok') return null;
  const cards = response['cards'] === undefined ? [] : decodeCards(response['cards']);
  if (cards === null) return null;
  const rawSuggestions = response['suggestions'];
  const suggestions = rawSuggestions === undefined ? undefined : decodeSuggestions(rawSuggestions);
  if (suggestions === null) return null;
  const rawTrace = response['trace'];
  const trace = rawTrace === undefined ? undefined : decodeTrace(rawTrace);
  if (trace === null) return null;
  return {
    kind,
    modelView: view.value,
    cards,
    ...(suggestions === undefined ? {} : { suggestions }),
    ...(trace === undefined ? {} : { trace }),
  };
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
 * Paths come only from argv (runCli answers usage 2 for a missing one); output is runCli's:
 * counts and problem codes only.
 * TODO(规划/11 §4): 本机命令 — blocked on paths
 */
export function runLocalEval(argv: string[], deps: RunLocalEvalDeps): Promise<number> {
  const options = deps.agent ?? {};
  const cli: LocalEvalCliDeps = {
    agent: (env) => createLocalEvalAgent({ ...options, clock: env.clock, ids: env.ids }),
    ...(deps.livePorts === undefined ? {} : { livePorts: deps.livePorts }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    ...(deps.meta === undefined ? {} : { meta: deps.meta }),
  };
  return deps.runCli([...argv], cli, deps.io);
}
