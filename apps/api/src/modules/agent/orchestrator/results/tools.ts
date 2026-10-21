// B3-05g · BR-AI-08 / BR-AI-05 / BR-AI-24: the search decorator around OrchestratorTools.
// Price conditions are checked before the inner port (one clarify per chain and slot), empty
// results are relaxed within the run's tool budget (spec first, then the price ceiling), every
// product_list is tagged against the user's original conditions and its conditions are saved
// under its result_set_id. ctx is always forwarded unchanged (B3-05i binds references to it).
import type { AgentProductCard } from '../../tools/search/index.ts';
import { priceRangeInvalidView } from '../../tools/search/index.ts';
import { assignMatchTags } from '../../tools/match/index.ts';
import type { MatchConditions } from '../../tools/match/index.ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import type {
  OrchestratorToolCall,
  OrchestratorTools,
  ToolContext,
  ToolOutcome,
} from '../core/ports.ts';
import {
  clarifyOptions,
  conditionsOf,
  currentChain,
  domainKey,
  hasProducts,
  isRecord,
  listItems,
  newChainId,
  noticeCard,
  priceInvalid,
  readSearchParams,
  resultKeys,
  setChain,
  stateOf,
  suggestionItems,
  validPrice,
  withServerNotices,
  without,
  SERVER_CALL,
  type InternalToolCall,
  type ResultsState,
} from './shared.ts';
import type { ResultsDeps } from './types.ts';

type Ok = Extract<ToolOutcome, { kind: 'ok' }>;
type Args = Readonly<Record<string, unknown>>;

function failedOutcome(): ToolOutcome {
  return { kind: 'failed', modelView: { error: 'tool_failed' } };
}

function isPriceRangeInvalid(outcome: ToolOutcome): boolean {
  return (
    outcome.kind === 'ok' &&
    isRecord(outcome.modelView) &&
    outcome.modelView['error'] === priceRangeInvalidView().error
  );
}

/** BR-AI-18: a prohibited query or result set is returned exactly as the handler built it. */
function isRefused(outcome: Ok): boolean {
  return isRecord(outcome.modelView) && outcome.modelView['refused'] === 'prohibited';
}

/** The model-visible name of a notice key, e.g. agent.notice.relaxed_spec → relaxed_spec. */
function noticeName(key: string): string {
  return key.slice(key.lastIndexOf('.') + 1);
}

/** A forwarded call: the server marker never reaches the inner port. */
function forward(call: OrchestratorToolCall, args: Args, step?: string): OrchestratorToolCall {
  return { id: step === undefined ? call.id : `${call.id}:${step}`, name: call.name, args };
}

/** One per app/session/run budget shared by model calls and appended relaxation calls. */
function budget(state: ResultsState, ctx: ToolContext, limit: number): () => boolean {
  const key = domainKey(ctx.subject.appId, ctx.sessionId, ctx.runId);
  return () => {
    const used = state.calls.get(key) ?? 0;
    if (used >= limit) return false;
    state.calls.set(key, used + 1);
    return true;
  };
}

/** The user's original conditions for BR-AI-24 tagging (after an unrecognized price was
 * dropped, before relaxation). */
function matchConditions(requested: Args, relaxed: boolean): MatchConditions {
  const spec = requested['spec'];
  const min = requested['price_min_fen'];
  const max = requested['price_max_fen'];
  return {
    ...(typeof spec === 'string' ? { spec } : {}),
    ...(validPrice(min) ? { priceMinFen: min } : {}),
    ...(validPrice(max) ? { priceMaxFen: max } : {}),
    relaxed,
  };
}

function isProductCard(value: unknown): value is AgentProductCard {
  return (
    isRecord(value) &&
    (typeof value['title'] === 'string' || value['title'] === null) &&
    Number.isSafeInteger(value['final_price_fen']) &&
    typeof value['match_tag'] === 'string' &&
    Array.isArray(value['benefit_tags']) &&
    Number.isSafeInteger(value['coupon_fen']) &&
    typeof value['is_presale'] === 'boolean'
  );
}

export function createResultsTools(inner: OrchestratorTools, deps: ResultsDeps): OrchestratorTools {
  // Methods are looked up on inner at call time, never bound at creation.
  const tools: OrchestratorTools = {
    definitions: (appId, subject) => inner.definitions(appId, subject),
    enabledSearchPlatforms: (appId) => inner.enabledSearchPlatforms(appId),
    searchKeyword: (plan, ctx) => inner.searchKeyword(plan, ctx),
    execute: (call, ctx) => execute(call, ctx),
  };
  const state = stateOf(tools);

  async function execute(call: InternalToolCall, ctx: ToolContext): Promise<ToolOutcome> {
    const take = budget(state, ctx, deps.limits.toolCalls);
    if (!take()) return failedOutcome();
    const args = call.args;
    if (call.name !== 'search_products' || !isRecord(args) || typeof args['q'] !== 'string') {
      return inner.execute(call, ctx);
    }
    return search(call, args, ctx, take);
  }

  /** New searches open a chain; a call answering on the same query keeps the current one. */
  async function searchChain(appId: string, sessionId: string, q: unknown): Promise<string> {
    const current = await currentChain(state, deps.store, appId, sessionId);
    if (current !== null && (current.conditions === null || current.conditions.q === q)) {
      return current.chainId;
    }
    return newChainId();
  }

  async function search(
    call: InternalToolCall,
    args: Args,
    ctx: ToolContext,
    take: () => boolean,
  ): Promise<ToolOutcome> {
    const appId = ctx.subject.appId;
    const server = call[SERVER_CALL];
    const chainId = server?.chainId ?? (await searchChain(appId, ctx.sessionId, args['q']));
    setChain(state, appId, ctx.sessionId, { chainId, conditions: conditionsOf(args, chainId) });
    const scope = { appId, sessionId: ctx.sessionId, chainId };
    const notices: string[] = [];
    let requested: Args = args;
    let outcome: ToolOutcome;

    if (priceInvalid(args)) {
      // BR-AI-08: never search with an invalid price; ask once per chain, then drop it.
      if (await deps.store.takeOnce(scope, 'price')) return clarifyPrice(appId);
      requested = without(args, 'price_min_fen', 'price_max_fen');
      notices.push(resultKeys.priceUnrecognized);
      outcome = await inner.execute(forward(call, requested), ctx);
    } else {
      outcome = await inner.execute(forward(call, args), ctx);
      if (isPriceRangeInvalid(outcome)) {
        if (await deps.store.takeOnce(scope, 'price')) return clarifyPrice(appId);
        requested = without(args, 'price_min_fen', 'price_max_fen');
        notices.push(resultKeys.priceUnrecognized);
        if (!take()) return noResult(appId, outcome, notices);
        outcome = await inner.execute(forward(call, requested, 'without-price'), ctx);
      }
    }

    if (outcome.kind !== 'ok' || isRefused(outcome)) return outcome;
    if (hasProducts(outcome))
      return finish(ctx, chainId, outcome, requested, requested, notices, false);
    // BR-AI-08 ①: 再便宜点 never relaxes.
    if (server?.kind === 'cheaper') {
      return withNotices(appId, outcome, [...notices, resultKeys.noCheaper], false);
    }

    // BR-AI-08 relaxation: the handler's effective spec decides whether step 1 applies.
    let working: Args = requested;
    const params = readSearchParams(outcome.trace);
    const steps: { readonly applies: boolean; readonly drop: string; readonly key: string }[] = [
      {
        applies: params !== null && params.spec !== null,
        drop: 'spec',
        key: resultKeys.relaxedSpec,
      },
      {
        applies: requested['price_max_fen'] !== undefined,
        drop: 'price_max_fen',
        key: resultKeys.relaxedPrice,
      },
    ];
    for (const step of steps) {
      if (!step.applies) continue;
      if (!take()) break;
      working = without(working, step.drop);
      notices.push(step.key);
      outcome = await inner.execute(forward(call, working, `relax-${step.drop}`), ctx);
      if (outcome.kind !== 'ok' || isRefused(outcome)) return outcome;
      if (hasProducts(outcome))
        return finish(ctx, chainId, outcome, requested, working, notices, true);
    }
    return noResult(appId, outcome, notices);
  }

  async function clarifyPrice(appId: string): Promise<ToolOutcome> {
    return {
      kind: 'ok',
      modelView: withServerNotices({ items: [] }, ['clarify_price']),
      cards: [],
      suggestions: [...(await clarifyOptions(deps.texts, 'price', appId))],
    };
  }

  async function noResult(appId: string, last: ToolOutcome, notices: readonly string[]) {
    const base: Ok =
      last.kind === 'ok' ? last : { kind: 'ok', modelView: { items: [] }, cards: [] };
    return withNotices(appId, base, [...notices, resultKeys.noResult], true);
  }

  /** Server notices first, then the handler's own cards; the trailing no-result notice last. */
  async function withNotices(
    appId: string,
    outcome: Ok,
    keys: readonly string[],
    suggest: boolean,
  ): Promise<ToolOutcome> {
    const tail = keys.at(-1);
    const head = keys.slice(0, -1);
    const cards: UnnumberedCard[] = [];
    for (const key of head) cards.push(await noticeCard(deps.texts, appId, key));
    cards.push(...outcome.cards);
    if (tail !== undefined) cards.push(await noticeCard(deps.texts, appId, tail));
    const suggestions = suggest
      ? await suggestionItems(
          deps.texts,
          appId,
          [1, 2, 3].map((n) => resultKeys.noResultSuggestion(n)),
        )
      : undefined;
    const { suggestions: own, ...rest } = outcome;
    void own;
    return {
      ...rest,
      modelView: withServerNotices(outcome.modelView, keys.map(noticeName)),
      cards,
      ...(suggestions === undefined ? {} : { suggestions }),
    };
  }

  async function finish(
    ctx: ToolContext,
    chainId: string,
    outcome: Ok,
    requested: Args,
    effective: Args,
    notices: readonly string[],
    relaxed: boolean,
  ): Promise<ToolOutcome> {
    const appId = ctx.subject.appId;
    const cards: UnnumberedCard[] = [];
    for (const key of notices) cards.push(await noticeCard(deps.texts, appId, key));
    for (const card of outcome.cards) cards.push(await tagged(card, requested, relaxed, appId));
    // BR-AI-05: the result set keeps this round's conditions; prices stay with the receipts.
    const conditions = conditionsOf(effective, chainId);
    if (conditions !== null) {
      for (const card of outcome.cards) {
        const id = card.data['result_set_id'];
        if (card.type !== 'product_list' || typeof id !== 'string') continue;
        await deps.store.save({
          id,
          appId,
          sessionId: ctx.sessionId,
          runId: ctx.runId,
          conditions,
        });
      }
    }
    if (notices.length === 0 && deps.match === undefined) return outcome;
    return {
      ...outcome,
      modelView: withServerNotices(outcome.modelView, notices.map(noticeName)),
      cards,
    };
  }

  /** BR-AI-24: rewrite product_list items through assignMatchTags; count and order unchanged. */
  async function tagged(
    card: UnnumberedCard,
    requested: Args,
    relaxed: boolean,
    appId: string,
  ): Promise<UnnumberedCard> {
    const match = deps.match;
    if (match === undefined || card.type !== 'product_list') return card;
    const items = listItems(card);
    if (!items.every(isProductCard)) return card;
    const tags = await assignMatchTags(items, matchConditions(requested, relaxed), appId, match);
    return { ...card, data: { ...card.data, items: [...tags] } };
  }

  return tools;
}
