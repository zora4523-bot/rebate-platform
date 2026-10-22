// B3-03j: the stream entry's production business assembly. app.module passes
// createProductionStreamAssembly as AgentStreamModuleOptions.assembly and provides
// agentStreamPortsToken() (union / catalog / linking / parsing, assembled there: agent imports
// none of their providers and never identity). This file adds agent's own parts: the content
// configuration reader, the prohibited query words, the page_guide route whitelist and the copy.
// Input check, sentence review (B3-03m) and model routing (B3-03k) are not part of it.
import { bridge } from '@couli/contracts-ts';
import { createContentReader } from '../../../content/index.ts';
import { systemScheduler } from '../../../platform/index.ts';
import type { AgentRunTexts } from '../../orchestrator/index.ts';
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
import { agentDefaultTexts, agentText } from './texts.ts';

const PORTS = Symbol('AGENT_STREAM_PORTS');

/** DI token of AgentStreamProvidedPorts; provided by app.module on the stream entry only. */
export function agentStreamPortsToken(): symbol {
  return PORTS;
}

const PAGE_GUIDE_ROUTES = 'agent.page_guide.routes';

/**
 * Copy from contracts/texts.default.json. An error key without its own text takes the error
 * message (errorMsg); any other missing key shows the key itself, as the search card's
 * fallback_text does.
 * TODO(规划/11 §2.3): Agent 草稿键与工具状态文案（agent.suggest.clarify.*、agent.notice.platform_unrecognized、agent.guest_login_to_view.*、agent.tool.<工具>.<阶段>）进字典 — blocked on content 文案线 B3-13（D10-135）
 */
function productionTexts(): AgentRunTexts {
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
    toolDisplay: async (_appId, tool, phase) => lookup(`agent.tool.${tool}.${phase}`),
  };
}

export function createProductionStreamAssembly(
  context: AgentStreamAssemblyContext,
): AgentStreamAssembly {
  const ports = context.ports;
  if (ports === undefined) throw new Error('Agent stream business ports are not provided');
  const config = createContentReader({ db: context.db.withSchema('app'), clock: context.clock });
  const keywords = createKeywordMatcher(inputKeywordLists());
  return createAgentStreamAssembly({
    db: context.db,
    clock: context.clock,
    logger: context.logger,
    config,
    scheduler: context.scheduler ?? systemScheduler(),
    texts: productionTexts(),
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
}
