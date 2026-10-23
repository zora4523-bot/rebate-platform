// B3-03j: the stream entry's production business assembly. app.module passes
// createProductionStreamAssembly as AgentStreamModuleOptions.assembly and provides
// agentStreamPortsToken() (union / catalog / linking / parsing, assembled there: agent imports
// none of their providers and never identity). This file adds agent's own parts: the content
// configuration reader, the prohibited query words, the page_guide route whitelist and the copy.
// B3-03m: the input check and the sentence review come from createStreamReview over
// context.safety (the composition root's review configuration); without it, or outside staging /
// prod, or without the AccessKey pair, both stay fail-closed with no network request. Model
// routing (B3-03k) is not part of it.
// B3-03n: the input review budget is agent.safety.timeout_ms of each request's app through the same
// content reader (createStreamReview's config), and the one result store is the PG version
// (agent/store/results createPgResultSetStore over context.db), shared by every runtime instance.
// B3-08g (rule tests: test/spec/agent/stream-assembly-orders/**): with the ports' orders,
// claimEntries and dailyCounter, the registry also holds handoff_to_human, prefill_claim,
// list_my_orders and explain_order (registered = specs/agent-tools.allowlist exactly; search_rules
// waits for B3-08e / B3-08i), each behind agent.tools.<name>.enabled through the same content
// reader; card_id references read agent_cards (createOrderCardRefs over context.db) and the
// by-number budget is createOrderNoQuota over ports.dailyCounter (./orders.ts).
import { bridge } from '@couli/contracts-ts';
import { createContentReader } from '../../../content/index.ts';
import { systemScheduler } from '../../../platform/index.ts';
import type { AgentRunTexts } from '../../orchestrator/index.ts';
import { createPgResultSetStore } from '../../store/results/index.ts';
import {
  createKeywordMatcher,
  inputKeywordLists,
  normalizeForKeywords,
} from '../../preprocess/input/keywords.ts';
import {
  createAgentStreamAssembly,
  type AgentStreamAssembly,
  type AgentStreamAssemblyContext,
} from './assembly.ts';
import { agentDefaultTexts, agentText, agentTextIfPresent, platformDisplayName } from './texts.ts';
import { createStreamReview } from './review.ts';
import { createToolStatusDisplay, type ToolStatusTextsDeps } from './tool-status.ts';

const PORTS = Symbol('AGENT_STREAM_PORTS');

/** DI token of AgentStreamProvidedPorts; provided by app.module on the stream entry only. */
export function agentStreamPortsToken(): symbol {
  return PORTS;
}

const PAGE_GUIDE_ROUTES = 'agent.page_guide.routes';

/**
 * Copy from contracts/texts.default.json. An error key without its own text takes the error
 * message (errorMsg); any other missing key shows the key itself, as the search card's
 * fallback_text does. Tool status texts never show a key (tool-status.ts, D10-151). The local
 * evaluation (B3-05m) uses the same copy over its tool catalog's search platforms.
 * TODO(规划/11 §2.3): Agent 草稿键与多平台工具状态文案（agent.suggest.clarify.*、agent.notice.platform_unrecognized、agent.guest_login_to_view.*、agent.tool_status.search_products.<阶段>.multi）进字典 — blocked on content 文案线 B3-13（D10-135）
 */
export function productionRunTexts(
  searchPlatforms: ToolStatusTextsDeps['searchPlatforms'],
  logger: ToolStatusTextsDeps['logger'],
): AgentRunTexts {
  const errors = agentDefaultTexts();
  const lookup = (key: string): string => {
    try {
      return agentText(key);
    } catch {
      const code = /^error\.(\d+)$/u.exec(key);
      return code === null ? key : errors.errorMsg(Number(code[1]));
    }
  };
  return {
    text: async (_appId, key) => lookup(key),
    toolDisplay: createToolStatusDisplay({
      text: agentTextIfPresent,
      searchPlatforms,
      platformName: platformDisplayName,
      logger,
    }),
  };
}

export function createProductionStreamAssembly(
  context: AgentStreamAssemblyContext,
): AgentStreamAssembly {
  const ports = context.ports;
  if (ports === undefined) throw new Error('Agent stream business ports are not provided');
  const config = createContentReader({ db: context.db.withSchema('app'), clock: context.clock });
  const keywords = createKeywordMatcher(inputKeywordLists());
  // BR-PROD-10, the same switches search_products queries with: explicit true only; missing or
  // unreadable is off.
  const searchPlatforms = async (appId: string): Promise<readonly string[]> => {
    const flags = await Promise.all(
      ports.platforms.map(async (platform) => {
        try {
          return (await config.configValue(appId, `search.enabled.${platform}`))?.value === true;
        } catch {
          return false;
        }
      }),
    );
    return ports.platforms.filter((_, index) => flags[index]);
  };
  const scheduler = context.scheduler ?? systemScheduler();
  const texts = productionRunTexts(searchPlatforms, context.logger);
  const safety = createStreamReview({
    ...(context.safety === undefined ? {} : { options: context.safety }),
    clock: context.clock,
    scheduler,
    logger: context.logger,
    texts,
    config,
  });
  const assembly = createAgentStreamAssembly({
    results: createPgResultSetStore({ db: context.db }),
    db: context.db,
    clock: context.clock,
    logger: context.logger,
    config,
    scheduler,
    texts,
    routes: {
      // BR-AI-01 页面引导: only the configured whitelist (intersected with the contract's routes by
      // the intent port); unreadable or malformed configuration is no route at all.
      async configured(appId) {
        try {
          const value = (await config.configValue(appId, PAGE_GUIDE_ROUTES))?.value;
          return Array.isArray(value)
            ? value.filter((route): route is string => typeof route === 'string')
            : [];
        } catch {
          return [];
        }
      },
      contract: () => bridge.routes,
    },
    ports: {
      search: {
        platforms: ports.platforms,
        searchProducts: ports.searchProducts,
        // BR-AI-18: the same prohibited words as the input check, on the model's keyword.
        prohibited: async (_appId, q) => keywords.hits('prohibited', normalizeForKeywords(q)),
        // TODO(规划/11 §2.3): 结果层禁售类目黑名单 — blocked on 联盟 DTO 提供类目 ID（UnionItem 目前没有类目字段）
        categoryAllowed: async () => true,
      },
      readProduct: ports.readProduct,
      parsing: ports.parsing,
      cards: ports.cards,
    },
  });
  return { ...assembly, safety };
}
