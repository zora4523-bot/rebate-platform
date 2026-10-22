// B3-03j: normalized synthetic DTOs and the existing non-production demo adapter only.
// Reuse B3-03f's PG/session helpers unchanged; never replace tools, intents or paths.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { vi } from 'vitest';
import { bridge } from '../../../../packages/contracts-ts/src/index.ts';
import { createContentReader } from '../../../../apps/api/src/modules/content/index.ts';
import {
  createCatalogCardEntry,
  type CardRebateQuoter,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { createLinkRegistration } from '../../../../apps/api/src/modules/linking/index.ts';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { extractCandidates } from '../../../../apps/api/src/modules/parsing/index.ts';
import { redactForModel } from '../../../../apps/api/src/modules/agent/preprocess/redact/index.ts';
import {
  createAgentStreamAssembly,
  createAgentStreamRuntime,
  type AgentStreamAssembly,
  type AgentStreamAssemblyDeps,
  type AgentStreamBusinessPorts,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type {
  InputCheckPort,
  ToolContext,
  PathInput,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type {
  RunContext,
  UnnumberedCard,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import type { AgentSearchCandidate } from '../../../../apps/api/src/modules/agent/tools/search/index.ts';
import {
  APP,
  Logs,
  ManualTime,
  loadConsentReader,
  setConfig,
  openAgent,
  consent,
  newMember,
} from '../stream-mount/kit.ts';

export const TOKEN = '￥Synthetic01￥';
export const LINK = 'https://demo.invalid/taobao/unknown-synthetic-item';

export const passInput: InputCheckPort = {
  async check(input) {
    const model = redactForModel(input.text);
    return {
      kind: 'proceed',
      modelText: model.text,
      placeholders: model.placeholders,
      links: extractCandidates(input.text),
      notices: [],
      untrustedInput: false,
      paramsRequested: false,
    };
  },
};

export async function fixture(db: Kysely<DB>, suppliedCaller?: AgentCaller) {
  const caller = suppliedCaller ?? (await newMember(db));
  await openAgent(db, caller.appId);
  await consent(db, caller);
  for (const key of [
    'search.enabled.taobao',
    'agent.tools.search_products.enabled',
    'agent.tools.get_rebate_quote.enabled',
    'agent.page_guide.enabled',
    'parse.tpwd.enabled',
  ]) {
    await setConfig(db, caller.appId, key, true);
  }
  const time = new ManualTime();
  const logs = new Logs();
  const config = createContentReader({ db, clock: time.clock });
  const row: AgentSearchCandidate = {
    item: {
      platform: 'taobao',
      item_id: 'synthetic-cup',
      title: '合成保温杯 500ml',
      price_fen: 12000n,
      coupon_fen: 2000n,
      final_price_fen: 10000n,
      commission_rate_bp: 1000n,
      quoted_at: time.clock.now().toISOString(),
    },
    ref: {
      appId: caller.appId,
      platform: 'taobao',
      productKey: 'tb:synthetic-cup',
      rawItemId: 'synthetic-cup',
      rawFetchedAt: time.clock.now().toISOString(),
      receivedAt: time.clock.now().toISOString(),
      canonicalUrl: null,
      title: '合成保温杯 500ml',
      shopId: null,
      shopType: null,
      source: 'search',
    },
    categoryId: 'synthetic-cups',
    sales: 12,
  };
  const state = { row };
  const searchProducts = vi.fn<AgentStreamBusinessPorts['search']['searchProducts']>(async () => [
    state.row,
  ]);
  const readProduct = vi.fn<AgentStreamBusinessPorts['readProduct']>(async () => state.row);
  const quote = vi.fn<CardRebateQuoter['quote']>(async (_item, _viewer, context) => ({
    rebateMinFen: 300n,
    rebateMaxFen: 300n,
    estNetPriceFen: null,
    rebateBasis: context?.rebateBasis ?? 'normal',
  }));
  const cards = vi.fn<AgentStreamBusinessPorts['cards']>((context, registration) => {
    // Real linking writer: production assembly must supply a fresh authenticated call context.
    const registrar = createLinkRegistration({
      db,
      clock: time.clock,
      config,
      callerContext: { current: async () => context },
      pids: { getActivePid: async () => null },
      context: registration,
    });
    return createCatalogCardEntry({
      clock: time.clock,
      logger: logs.logger,
      viewerContext: { current: async () => context },
      quoter: { quote },
      registrar,
      sourceLinks: registrar,
      itemRefs: { issue: () => 'synthetic-item-ref' },
    });
  });
  const demo = new DemoUnionAdapter({
    platform: 'taobao',
    seed: 'B3-03j',
    clock: time.clock,
    environment: 'test',
  });
  const resolveLink = vi.spyOn(demo, 'resolveLink');
  const convert = vi.spyOn(demo, 'convert');
  const texts = {
    text: async (_app: string, key: string) => `合成文案:${key}`,
    toolDisplay: async () => '合成工具状态',
  };
  const deps: AgentStreamAssemblyDeps = {
    db,
    clock: time.clock,
    logger: logs.logger,
    config,
    scheduler: time.scheduler,
    texts,
    routes: { configured: async () => ['Wallet'], contract: () => bridge.routes },
    ports: {
      search: {
        platforms: ['taobao'],
        searchProducts,
        prohibited: async () => false,
        categoryAllowed: async () => true,
      },
      cards,
      readProduct,
      parsing: {
        config,
        clock: time.clock,
        catalog: {
          listPlatforms: async () => [
            {
              code: 'taobao',
              key_prefix: 'tb',
              key_stability: 'unverified',
              search_support: 'full',
              convert_support: 'full',
              order_sync_support: 'full',
              stage: 'demo',
            },
          ],
          resolveProductKey: async (key) => key,
        },
        cards: {
          assemble: async () => {
            throw new Error('parse must not register cards');
          },
        },
        getGovernedAdapter: () => demo,
        linkPatterns: {
          version: 'synthetic',
          rules: [
            {
              platform: 'taobao',
              category: 'product',
              hosts: ['demo.invalid'],
              path_patterns: ['/taobao/*'],
            },
          ],
        },
      },
    },
  };
  const consentReader = await loadConsentReader();
  function build() {
    // Inside each it, never a hook: NotImplemented must fail the test body itself.
    return createAgentStreamAssembly(deps);
  }
  function mount(assembly: AgentStreamAssembly) {
    const runtime = createAgentStreamRuntime(
      { db, clock: time.clock, logger: logs.logger, consentReader, assembly: () => assembly },
      { inputCheck: passInput, schedule: time.scheduler },
    );
    return { runtime, time, logs };
  }
  function context(sessionId: string = randomUUID()): ToolContext {
    return {
      subject: caller,
      sessionId,
      runId: randomUUID(),
      placeholders: {},
      signal: new AbortController().signal,
    };
  }
  return {
    deps,
    caller,
    time,
    logs,
    config,
    state,
    searchProducts,
    readProduct,
    quote,
    cards,
    demo,
    resolveLink,
    convert,
    build,
    mount,
    context,
    consentReader,
  };
}

export function request(ctx: ToolContext, text = '钱包在哪'): PathInput {
  const redacted = redactForModel(text);
  return {
    input: {
      caller: ctx.subject,
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      userMessageId: randomUUID(),
      assistantMessageId: randomUUID(),
      text,
      redactedText: redacted.text,
      limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
    },
    proceed: {
      kind: 'proceed',
      modelText: redacted.text,
      placeholders: redacted.placeholders,
      links: extractCandidates(text),
      notices: [],
      untrustedInput: false,
      paramsRequested: false,
    },
  };
}

export function output(ctx: ToolContext) {
  const cards: UnnumberedCard[] = [];
  const texts: string[] = [];
  const run: RunContext = {
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    signal: ctx.signal,
    get cardsDelivered() {
      return cards.length;
    },
    card: async (card) => {
      cards.push(card);
    },
    text: (text) => {
      texts.push(text);
    },
    toolStatus: vi.fn(),
    suggestions: vi.fn(),
  };
  return { run, cards, texts };
}

export { APP };
