// B3-03j: production composition contract. No model transport or review service is added here.
// The implementation composes registry + keyword search + results/match, shares one result store
// with references/clarification/refinement, and binds parsing.parseUrl AND parsing.parseToken.
// Token candidates must reach the same quote runner (the older deterministic path skips them).
// Card entry creation is per call: linking receives scene=agent and the authenticated session.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { CatalogCardEntry, CatalogConfigReader } from '../../../catalog/index.ts';
import {
  parseToken,
  parseUrl,
  type Candidate,
  type ParsingOptions,
} from '../../../parsing/index.ts';
import type { Clock, RootLogger, Scheduler } from '../../../platform/index.ts';
import {
  orchestratorLimitsDefaults,
  type AgentRunTexts,
  type DeterministicPath,
  type IntentPort,
  type OrchestratorTools,
} from '../../orchestrator/index.ts';
import { cardReference } from '../../orchestrator/core/card-references.ts';
import { createDeterministicPath } from '../../orchestrator/deterministic/index.ts';
import { createIntentPort, type IntentDeps } from '../../orchestrator/intents/index.ts';
import {
  createClarification,
  createMemoryResultSetStore,
  createReferenceResolver,
  createRefinement,
  createResultsTools,
  type ResultSetStore,
  type ResultsDeps,
} from '../../orchestrator/results/index.ts';
import type { MatchDeps } from '../../tools/match/index.ts';
import {
  createLinkQuoteRunner,
  createRebateQuoteHandler,
  type LinkQuoteRunner,
  type RebateQuoteDeps,
} from '../../tools/quote/index.ts';
import {
  createToolRegistry,
  registeredToolNames,
  type ToolCallContext,
  type ToolSwitches,
} from '../../tools/registry/index.ts';
import {
  createKeywordSearch,
  createSearchProductsHandler,
  type SearchProductsDeps,
} from '../../tools/search/index.ts';

/**
 * What the composition root (app.module, stream entry) provides from union / catalog / linking /
 * parsing; agent imports none of their providers. The prohibited-word and category filters are
 * agent's own (createProductionStreamAssembly).
 */
export interface AgentStreamProvidedPorts {
  readonly platforms: SearchProductsDeps['platforms'];
  readonly searchProducts: SearchProductsDeps['searchProducts'];
  readonly readProduct: RebateQuoteDeps['catalog']['readProduct'];
  readonly parsing: ParsingOptions;
  readonly cards: AgentStreamBusinessPorts['cards'];
}

export interface AgentStreamAssemblyContext {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** The run manager's scheduler (the system scheduler in production). */
  readonly scheduler?: Scheduler;
  /** agentStreamPortsToken()'s value on the stream entry; absent without it. */
  readonly ports?: AgentStreamProvidedPorts;
}

export interface AgentStreamBusinessPorts {
  readonly search: Pick<
    SearchProductsDeps,
    'platforms' | 'searchProducts' | 'prohibited' | 'categoryAllowed'
  >;
  readonly readProduct: RebateQuoteDeps['catalog']['readProduct'];
  readonly parsing: ParsingOptions;
  readonly cards: (
    context: ToolCallContext,
    registration: { readonly scene: 'agent'; readonly agentSessionId: string },
  ) => CatalogCardEntry;
}

export interface AgentStreamAssemblyDeps extends Omit<
  AgentStreamAssemblyContext,
  'ports' | 'scheduler'
> {
  readonly ports: AgentStreamBusinessPorts;
  readonly config: CatalogConfigReader;
  readonly scheduler: Scheduler;
  readonly texts: AgentRunTexts;
  readonly routes: IntentDeps['routes'];
}

export interface AgentStreamAssembly {
  readonly tools: OrchestratorTools;
  readonly deterministic: DeterministicPath;
  readonly intents: IntentPort;
  readonly results: ResultSetStore;
  readonly texts: AgentRunTexts;
}

/** Optional on the module/runtime: absence preserves B3-03f's minimal mount. */
export type AgentStreamAssemblyFactory = (
  context: AgentStreamAssemblyContext,
) => AgentStreamAssembly;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function switchValue(
  config: CatalogConfigReader,
  appId: string,
  key: string,
): Promise<unknown> {
  return (await config.configValue(appId, key))?.value;
}

/**
 * The model sees the same product list key for search_products as for get_rebate_quote
 * ({products: [{card_id, title, platform, benefit_tags}]}, BR-AI-05). Only the outermost port
 * renames; the results decorator and the refinement read the handler's own view.
 */
function productView(tools: OrchestratorTools): OrchestratorTools {
  return {
    definitions: (appId, subject) => tools.definitions(appId, subject),
    enabledSearchPlatforms: (appId) => tools.enabledSearchPlatforms(appId),
    searchKeyword: (plan, ctx) => tools.searchKeyword(plan, ctx),
    async execute(call, ctx) {
      const outcome = await tools.execute(call, ctx);
      if (call.name !== 'search_products' || outcome.kind !== 'ok') return outcome;
      if (!isRecord(outcome.modelView) || !Array.isArray(outcome.modelView['items'])) {
        return outcome;
      }
      const { items, ...rest } = outcome.modelView;
      return { ...outcome, modelView: { ...rest, products: items } };
    },
  };
}

/**
 * Token candidates go through the same quote runner as URLs (parsing.parseToken inside it); the
 * deterministic path itself only quotes URL candidates, so a token is handed to it as a stand-in
 * URL candidate that the runner maps back to the original before parsing.
 */
function tokenAwarePath(runner: LinkQuoteRunner, texts: AgentRunTexts): DeterministicPath {
  const originals = new WeakMap<Candidate, Candidate>();
  const path = createDeterministicPath({
    quotes: {
      run: (candidate, ctx) => runner.run(originals.get(candidate) ?? candidate, ctx),
    },
    texts,
    // TODO(规划/11 §2.3): 确定性路径的登记 trace（onTrace）进运行 trace — blocked on followups 第 31 条（生产没有 RunTraceSink）
  });
  return {
    run(request, ctx) {
      const links = request.proceed.links.map((link) => {
        if (link.kind === 'url') return link;
        const standIn: Candidate = { ...link, kind: 'url' };
        originals.set(standIn, link);
        return standIn;
      });
      return path.run({ ...request, proceed: { ...request.proceed, links } }, ctx);
    },
  };
}

export function createAgentStreamAssembly(deps: AgentStreamAssemblyDeps): AgentStreamAssembly {
  const { config, ports, texts } = deps;
  // Per call, from the server-built call context: never a value captured at build time.
  const cardsFor = (ctx: ToolCallContext): CatalogCardEntry =>
    ports.cards(ctx, { scene: 'agent', agentSessionId: ctx.sessionId });

  // TODO(规划/11 §2.3): 结果集换 PG 版（多实例共享、重启不丢） — blocked on B3-09c PG ResultSetStore；内存版只适合单实例 staging
  const store = createMemoryResultSetStore();
  const limits = orchestratorLimitsDefaults();
  const switches: ToolSwitches = {
    async get(appId, key) {
      const value = await switchValue(config, appId, key);
      return typeof value === 'boolean' ? value : undefined;
    },
  };

  const searchDeps: SearchProductsDeps = {
    clock: deps.clock,
    config,
    platforms: ports.search.platforms,
    searchProducts: ports.search.searchProducts,
    prohibited: ports.search.prohibited,
    categoryAllowed: ports.search.categoryAllowed,
    cardEntry: cardsFor,
    newResultSetId: () => randomUUID(),
    cardReference,
    texts: (appId, key) => texts.text(appId, key),
  };
  // The deterministic runner never numbers cards (no card call scope on that path): no
  // cardReference there; the model tool gets the core's.
  const runnerDeps: RebateQuoteDeps = {
    tokens: { parseToken: (raw, context) => parseToken(ports.parsing, raw, context) },
    parsing: { parseUrl: (url, context) => parseUrl(ports.parsing, url, context) },
    catalog: { readProduct: ports.readProduct, cards: cardsFor },
    references: createReferenceResolver({ store }),
  };
  const quoteDeps: RebateQuoteDeps = { ...runnerDeps, cardReference };
  const handlers = [createSearchProductsHandler(searchDeps), createRebateQuoteHandler(quoteDeps)];
  const names = registeredToolNames(handlers);
  const registry = createToolRegistry({ handlers, switches, logger: deps.logger });
  const keyword = createKeywordSearch(searchDeps);
  const inner: OrchestratorTools = {
    definitions: (appId, subject) => registry.definitions(appId, subject),
    execute: (call, ctx) => registry.execute(call, ctx),
    enabledSearchPlatforms: (appId) => keyword.enabledSearchPlatforms(appId),
    searchKeyword: (plan, ctx) => keyword.searchKeyword(plan, ctx),
  };
  // Jev result check is not wired (B3-12): the code rules decide every tag.
  const match: MatchDeps = { provider: async () => 'rules', scheduler: deps.scheduler };
  const resultsDeps: ResultsDeps = { store, texts, limits, match };
  const results = createResultsTools(inner, resultsDeps);
  const continuation = { ...resultsDeps, tools: results };

  const intents = createIntentPort({
    routes: deps.routes,
    flags: {
      async enabled(appId, key) {
        try {
          return (await switchValue(config, appId, key)) === true;
        } catch {
          return false;
        }
      },
    },
    tools: { registered: (name) => names.includes(name) },
    texts,
    trace: {
      // TODO(规划/11 §2.3): 本轮实际工具调用摘要（模板文案）与意图 trace 落库 — blocked on followups 第 31 条（生产没有 RunTraceSink）
      calls: async () => [],
      record: () => undefined,
    },
    clarification: createClarification(continuation),
    continuation: {
      // TODO(规划/11 §2.3): 上一轮意图（「那返了吗」承接订单 / 收益） — blocked on 会话意图记录（订单与收益工具未进注册表）
      previousIntent: async () => null,
      run: createRefinement(continuation).run,
    },
  });

  // TODO(规划/11 §2.3): 出卡回执写结果集（recordDelivered） — blocked on followups 第 44 条（core 投递回执接线）
  return {
    tools: productView(results),
    deterministic: tokenAwarePath(createLinkQuoteRunner(runnerDeps), texts),
    intents,
    results: store,
    texts,
  };
}
