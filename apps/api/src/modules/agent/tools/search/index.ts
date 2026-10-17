// B3-04b · search_products (BR-AI-08 / BR-AI-09 / BR-AI-11, with BR-AI-04 / BR-AI-05 /
// BR-AI-18 / BR-PROD-10) and the keyword fallback search of the degraded path. The pipeline is in
// pipeline.ts, the Agent card contract in card.ts, the model-facing schema in schema.ts.
import type {
  CatalogCardEntry,
  CatalogConfigReader,
  SearchCandidate,
  SearchProductsQuery,
} from '../../../catalog/index.ts';
import type { Clock } from '../../../platform/index.ts';
import { wrapUntrusted } from '../../guard/index.ts';
import type { OrchestratorTools, ToolContext, ToolOutcome } from '../../orchestrator/index.ts';
import type { PlatformSearchResult } from '../../model-gateway/degraded/index.ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import type { ToolCallContext, ToolHandler } from '../registry/index.ts';
import type { AgentProductCard } from './card.ts';
import { runSearch, enabledPlatforms, type Platform, type SearchRequest } from './pipeline.ts';
import { defaultPageSize, searchProductsDefinition, type SearchSort } from './schema.ts';

export type { AgentProductCard } from './card.ts';

/** Normalized candidates in upstream rank order; no platform wire payloads here. */
export interface AgentSearchCandidate extends SearchCandidate {
  readonly categoryId: string;
  readonly sales: number | null;
}

export interface SearchProductsDeps {
  readonly clock: Clock;
  readonly config: CatalogConfigReader;
  readonly platforms: readonly SearchProductsQuery['platform'][];
  /**
   * Retrieval seam: catalog's query and candidate types, before card/link delivery.
   * The HTTP searchProducts return type already contains registered links and cannot be
   * used as this port's result. Wiring must preserve upstream rank and defer registration.
   */
  readonly searchProducts: (
    query: SearchProductsQuery,
    ctx: ToolCallContext,
  ) => Promise<readonly AgentSearchCandidate[]>;
  readonly cardEntry: (ctx: ToolCallContext) => CatalogCardEntry;
  readonly prohibited: (appId: string, q: string) => Promise<boolean>;
  readonly categoryAllowed: (appId: string, candidate: AgentSearchCandidate) => Promise<boolean>;
  readonly newResultSetId: () => string;
  /** References supplied by the run's numbering owner, including the list container offset.
   * Never number the outgoing UnnumberedCard here. index is the delivered item index.
   */
  readonly cardReference: (ctx: ToolCallContext, index: number) => string;
  /** Dictionary text for a card's fallback_text (BR-TEXT-12); the text key when not wired. */
  readonly texts?: (appId: string, key: string) => Promise<string>;
}

function prohibitedKey(): string {
  return 'agent.refuse.prohibited';
}

function productListKey(): string {
  return 'agent.product_list';
}

async function fallbackText(deps: SearchProductsDeps, appId: string, key: string) {
  if (deps.texts === undefined) return key;
  try {
    const text = await deps.texts(appId, key);
    return text === '' ? key : text;
  } catch {
    return key;
  }
}

async function prohibitedNotice(deps: SearchProductsDeps, appId: string): Promise<UnnumberedCard> {
  const key = prohibitedKey();
  return {
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: key, actions: [] },
    fallback_text: await fallbackText(deps, appId, key),
  };
}

/** One unnumbered product_list; its items carry no card_id (RunManager numbers them). */
async function productList(
  deps: SearchProductsDeps,
  appId: string,
  cards: readonly AgentProductCard[],
): Promise<UnnumberedCard> {
  return {
    type: 'product_list',
    schema_version: 1,
    data: { result_set_id: deps.newResultSetId(), items: [...cards], layout: 'list' },
    fallback_text: await fallbackText(deps, appId, productListKey()),
  };
}

async function outcomeCards(
  deps: SearchProductsDeps,
  appId: string,
  prohibited: boolean,
  cards: readonly AgentProductCard[],
): Promise<UnnumberedCard[]> {
  if (prohibited) return [await prohibitedNotice(deps, appId)];
  return cards.length === 0 ? [] : [await productList(deps, appId, cards)];
}

function linkTrace(cards: readonly AgentProductCard[]) {
  return {
    link_registrations: cards.map((card) => ({
      link_id: card.link_id,
      product_key: card.product_key,
      ok: true,
    })),
  };
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

/** Arguments already passed the registry's schema; read defensively all the same. */
function requestFromArgs(args: Readonly<Record<string, unknown>>): SearchRequest {
  const sort = args['sort'];
  const platforms = args['platforms'];
  const limit = optionalInt(args['limit']);
  return {
    q: typeof args['q'] === 'string' ? args['q'] : '',
    ...(Array.isArray(platforms)
      ? { platforms: platforms.filter((p): p is string => typeof p === 'string') }
      : {}),
    sort:
      sort === 'rebate_desc' || sort === 'final_price_asc' || sort === 'sales_desc'
        ? (sort satisfies SearchSort)
        : 'relevance',
    ...(optionalInt(args['price_min_fen']) === undefined
      ? {}
      : { priceMinFen: optionalInt(args['price_min_fen'])! }),
    ...(optionalInt(args['price_max_fen']) === undefined
      ? {}
      : { priceMaxFen: optionalInt(args['price_max_fen'])! }),
    pageSize:
      limit !== undefined && limit >= 1 && limit <= defaultPageSize() ? limit : defaultPageSize(),
  };
}

/**
 * BR-AI-05: the model sees only the card reference, the escaped and wrapped title, the platform
 * and the server-made benefit tags; no price, rebate, link or reference.
 */
function modelItems(
  deps: SearchProductsDeps,
  cards: readonly AgentProductCard[],
  ctx: ToolCallContext,
) {
  return cards.map((card, index) => ({
    card_id: deps.cardReference(ctx, index),
    title: card.title === null ? null : wrapUntrusted(card.title),
    platform: card.platform,
    benefit_tags: [...card.benefit_tags],
  }));
}

export function createSearchProductsHandler(deps: SearchProductsDeps): ToolHandler {
  return {
    name: 'search_products',
    audience: 'all',
    definition: searchProductsDefinition(deps.platforms),
    async run(args, ctx): Promise<ToolOutcome> {
      const run = await runSearch(deps, requestFromArgs(args), ctx);
      const cards = await outcomeCards(deps, ctx.appId, run.prohibited, run.cards);
      const items = modelItems(deps, run.cards, ctx);
      return {
        kind: 'ok',
        modelView: run.prohibited ? { items, refused: 'prohibited' } : { items },
        cards,
        trace: linkTrace(run.cards),
      };
    },
  };
}

/** Server context of the degraded path, built like the registry's call context. */
function callContext(ctx: ToolContext): ToolCallContext {
  const { appId, userId, deviceId, phoneBound } = ctx.subject;
  return {
    appId,
    userId,
    deviceId,
    phoneBound,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    signal: ctx.signal,
    ...(ctx.context === undefined ? {} : { context: ctx.context }),
    placeholders: ctx.placeholders,
  };
}

/**
 * B3-05c's keyword fallback: same switches, filters and deferred registration as search_products,
 * relevance only, no price condition. Every planned platform gets one result (a platform switched
 * off since planning, unknown or failing is ok=false) for resolveDegradedOutcome.
 */
export function createKeywordSearch(
  deps: SearchProductsDeps,
): Pick<OrchestratorTools, 'enabledSearchPlatforms' | 'searchKeyword'> {
  return {
    async enabledSearchPlatforms(appId) {
      return enabledPlatforms(deps, appId);
    },

    async searchKeyword(plan, toolCtx) {
      const ctx = callContext(toolCtx);
      const run = await runSearch(
        deps,
        { q: plan.q, platforms: plan.platforms, sort: 'relevance', pageSize: defaultPageSize() },
        ctx,
      );
      const results: PlatformSearchResult[] = plan.platforms.map((platform) => {
        if (run.prohibited) return { platform, ok: true, items: [] };
        if (run.status.get(platform as Platform) !== 'ok') return { platform, ok: false };
        return { platform, ok: true, items: run.cards.filter((c) => c.platform === platform) };
      });
      return {
        results,
        cards: await outcomeCards(deps, ctx.appId, run.prohibited, run.cards),
        trace: linkTrace(run.cards),
      };
    },
  };
}
