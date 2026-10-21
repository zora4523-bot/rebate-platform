// B3-05g · BR-AI-05 / BR-AI-08 / BR-PRICE-15: clarification chain, refinement (再便宜点 / 换一批 /
// 换平台 / 价格) and reference resolution. Refined searches go through the decorated tools port
// (deps.tools.execute, looked up on every call) so price checks, relaxation, tagging and result-set
// saving stay in one place; the chain and the 再便宜点 mode travel as a server-only call marker.
import type { RebateQuoteDeps } from '../../tools/quote/index.ts';
import { maxSearchPage } from '../../tools/search/schema.ts';
import type { RunBodyResult, RunContext } from '../../stream/run/index.ts';
import type { PathInput, ToolContext, ToolOutcome } from '../core/ports.ts';
import type { ClarifySlot, IntentDeps, IntentOutput, IntentRequest } from '../intents/types.ts';
import {
  argsOf,
  clarifyOptions,
  currentChain,
  isRecord,
  newChainId,
  noticeCard,
  resultKeys,
  setChain,
  stateOf,
  suggestionItems,
  without,
  SERVER_CALL,
  type InternalToolCall,
  type ServerCall,
} from './shared.ts';
import type { ResultsContinuationDeps, ResultsDeps, SearchConditions } from './types.ts';

type Done = Extract<RunBodyResult, { kind: 'done' }>;
type Refine = Extract<IntentOutput, { agent_intent: 'refine' }>;

function done(): Done {
  return { kind: 'done', finishReason: 'stop' };
}

function toolContext(request: PathInput, ctx: RunContext): ToolContext {
  const input = request.input;
  return {
    subject: input.caller,
    ...(input.context === undefined ? {} : { context: input.context }),
    runId: input.runId,
    sessionId: input.sessionId,
    signal: ctx.signal,
    placeholders: request.proceed.placeholders,
  };
}

/** A server-built search_products call; the marker is a symbol, never a model argument. */
function serverCall(
  name: string,
  args: Readonly<Record<string, unknown>>,
  marker?: ServerCall,
): InternalToolCall {
  const call = { id: `server-${newChainId()}`, name, args };
  return marker === undefined ? call : { ...call, [SERVER_CALL]: marker };
}

function isClarify(outcome: ToolOutcome): boolean {
  return (
    outcome.kind === 'ok' &&
    outcome.cards.length === 0 &&
    isRecord(outcome.modelView) &&
    outcome.modelView['error'] === 'clarify'
  );
}

/** Deliver a tool outcome produced outside the model loop: cards, then suggestions. */
async function emit(ctx: RunContext, outcome: ToolOutcome): Promise<void> {
  if (outcome.kind !== 'ok') return;
  for (const card of outcome.cards) await ctx.card(card);
  if (outcome.suggestions !== undefined && outcome.suggestions.length > 0) {
    ctx.suggestions(outcome.suggestions);
  }
}

/** Run a server-built search on a chain and deliver it. */
async function runSearch(
  deps: ResultsContinuationDeps,
  request: PathInput,
  ctx: RunContext,
  args: Readonly<Record<string, unknown>>,
  marker: ServerCall,
): Promise<Done> {
  const call = serverCall('search_products', args, marker);
  await emit(ctx, await deps.tools.execute(call, toolContext(request, ctx)));
  return done();
}

export function createClarification(deps: ResultsContinuationDeps): IntentDeps['clarification'] {
  const state = stateOf(deps.tools);
  const store = deps.store;

  return {
    async scope(request) {
      const appId = request.input.caller.appId;
      const sessionId = request.input.sessionId;
      let chain = await currentChain(state, store, appId, sessionId);
      if (chain === null) {
        chain = { chainId: newChainId(), conditions: null };
        setChain(state, appId, sessionId, chain);
      }
      return { appId, sessionId, chainId: chain.chainId };
    },

    takeOnce: (scope, slot) => store.takeOnce(scope, slot),

    options: (slot, appId) => clarifyOptions(deps.texts, slot, appId),

    async latestProducts(scope) {
      const latest = await store.latestWithProducts(scope.appId, scope.sessionId);
      return latest === null ? [] : latest.delivered.map((item) => item.card);
    },

    fallbackNotice(appId, slot) {
      return noticeCard(deps.texts, appId, fallbackKey(slot));
    },

    async withoutCondition(slot, request, ctx) {
      const appId = request.input.caller.appId;
      const sessionId = request.input.sessionId;
      const chain = await currentChain(state, store, appId, sessionId);
      const latest = await store.latestWithProducts(appId, sessionId);
      const base = chain?.conditions ?? latest?.conditions ?? null;
      // Nothing was searched in this session: the port already delivered the notice.
      if (base === null) return done();
      const drop = slot === 'price' ? ['price_min_fen', 'price_max_fen'] : ['platforms'];
      return runSearch(deps, request, ctx, without(argsOf(base), ...drop), {
        kind: 'refine',
        chainId: base.chain_id,
      });
    },
  };
}

function fallbackKey(slot: ClarifySlot): string {
  switch (slot) {
    case 'reference':
      return resultKeys.ordinalDefault;
    case 'price':
      return resultKeys.priceUnrecognized;
    case 'platform':
      return resultKeys.platformUnrecognized;
  }
}

/** BR-PRICE-15: min(previous ceiling, lowest delivered final price − 1); null when < 1 fen or
 * below the kept lower bound (nothing cheaper can exist). */
function cheaperCeiling(conditions: SearchConditions, prices: readonly number[]): number | null {
  if (prices.length === 0) return null;
  const lowest = prices.reduce((a, b) => (b < a ? b : a));
  const below = lowest - 1;
  const ceiling =
    conditions.price_max_fen === undefined ? below : Math.min(conditions.price_max_fen, below);
  if (ceiling < 1) return null;
  if (conditions.price_min_fen !== undefined && ceiling < conditions.price_min_fen) return null;
  return ceiling;
}

export function createRefinement(
  deps: ResultsContinuationDeps,
): Pick<IntentDeps['continuation'], 'run'> {
  const store = deps.store;
  const clarification = createClarification(deps);

  async function notice(request: IntentRequest, ctx: RunContext, key: string, suggest: boolean) {
    const appId = request.input.caller.appId;
    await ctx.card(await noticeCard(deps.texts, appId, key));
    if (suggest) {
      const keys = [1, 2, 3].map((n) => resultKeys.noResultSuggestion(n));
      ctx.suggestions(await suggestionItems(deps.texts, appId, keys));
    }
    return done();
  }

  async function refine(intent: Refine, request: IntentRequest, ctx: RunContext): Promise<Done> {
    const latest = await store.latestWithProducts(
      request.input.caller.appId,
      request.input.sessionId,
    );
    // Nothing shown yet in this session: there is no list to refine.
    if (latest === null) return notice(request, ctx, resultKeys.noResult, true);
    const base = latest.conditions;
    const chain = { kind: 'refine' as const, chainId: base.chain_id };
    const args = argsOf(base);
    const conditions = intent.conditions;

    if ('cheaper' in conditions) {
      // Only cards actually delivered count (BR-AI-05 细则); prices never come from the model.
      const ceiling = cheaperCeiling(
        base,
        latest.delivered.map((item) => item.final_price_fen),
      );
      if (ceiling === null) return notice(request, ctx, resultKeys.noCheaper, false);
      // A new price condition and ordering restart at page 1 (编排裁定).
      const next = { ...args, price_max_fen: ceiling, sort: 'final_price_asc', page: 1 };
      return runSearch(deps, request, ctx, next, { ...chain, kind: 'cheaper' });
    }
    if ('next_batch' in conditions) {
      const page = (base.page ?? 1) + 1;
      if (page > maxSearchPage()) return notice(request, ctx, resultKeys.noResult, false);
      return runSearch(deps, request, ctx, { ...args, page }, chain);
    }
    const next: Record<string, unknown> = { ...args };
    if (conditions.platform !== undefined) next['platforms'] = [conditions.platform];
    if (conditions.price_min_fen !== undefined) next['price_min_fen'] = conditions.price_min_fen;
    if (conditions.price_max_fen !== undefined) next['price_max_fen'] = conditions.price_max_fen;
    return runSearch(deps, request, ctx, next, chain);
  }

  /** 第 N 个: a fresh quote through get_rebate_quote (the resolver maps the ordinal). An ordinal
   * beyond the list asks once per chain (BR-AI-01), then falls back to the first delivered card. */
  async function ordinal(ordinalValue: number, request: IntentRequest, ctx: RunContext) {
    const call = serverCall('get_rebate_quote', { ref_ordinal: ordinalValue });
    const outcome = await deps.tools.execute(call, toolContext(request, ctx));
    if (!isClarify(outcome)) {
      await emit(ctx, outcome);
      return done();
    }
    const appId = request.input.caller.appId;
    const scope = await clarification.scope(request);
    if (await store.takeOnce(scope, 'reference')) {
      ctx.suggestions([...(await clarifyOptions(deps.texts, 'reference', appId))]);
      return done();
    }
    const [first] = await clarification.latestProducts(scope);
    if (first === undefined) return notice(request, ctx, resultKeys.noResult, false);
    await ctx.card(first);
    await ctx.card(await clarification.fallbackNotice(appId, 'reference'));
    return done();
  }

  return {
    async run(intent, request, ctx) {
      switch (intent.agent_intent) {
        case 'refine':
          return refine(intent, request, ctx);
        case 'ref_ordinal':
          return ordinal(intent.ordinal, request, ctx);
        default:
          // Other continuations (orders, rules, earnings …) are routed elsewhere by the
          // composition root; this port produces nothing for them.
          return done();
      }
    },
  };
}

export function createReferenceResolver(
  deps: Pick<ResultsDeps, 'store'>,
): RebateQuoteDeps['references'] {
  return {
    async resolve(reference, context) {
      const { appId, sessionId } = context;
      if ('card_id' in reference) {
        if (typeof reference.card_id !== 'string') return { kind: 'invalid_args' };
        const found = await deps.store.findDelivered(appId, sessionId, reference.card_id);
        return found === null
          ? { kind: 'invalid_args' }
          : { kind: 'product', productKey: found.product_key };
      }
      const n = reference.ref_ordinal;
      if (!Number.isSafeInteger(n) || n < 1) return { kind: 'invalid_args' };
      const latest = await deps.store.latestWithProducts(appId, sessionId);
      const item = latest?.delivered[n - 1];
      return item === undefined
        ? { kind: 'clarify' }
        : { kind: 'product', productKey: item.product_key };
    },
  };
}
