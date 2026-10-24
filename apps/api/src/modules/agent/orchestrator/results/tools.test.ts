import { expect, it, vi } from 'vitest';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import { cardReference } from '../core/card-references.ts';
import { orchestratorLimitsDefaults } from '../core/factories.ts';
import type {
  OrchestratorToolCall,
  OrchestratorTools,
  ToolContext,
  ToolOutcome,
} from '../core/ports.ts';
import { createKeywordResults } from './keyword.ts';
import { openServerCall } from './references.ts';
import { createMemoryResultSetStore } from './store.ts';
import { createResultsTools } from './tools.ts';
import type { DeliveredProduct, ResultsDeps } from './types.ts';

// Synthetic only. B3-03r · BR-AI-05: with deferred chains a search's chain waits for its first
// written product_list; without them it is set at once (B3-05g).
const APP = 'synthetic-app';
const SESSION = 'synthetic-session';

function list(id: string): UnnumberedCard {
  return {
    type: 'product_list',
    schema_version: 1,
    data: { result_set_id: id, items: [{ product_key: 'jd:synthetic' }] },
    fallback_text: '合成商品列表',
  };
}

function item(cardId: string): DeliveredProduct {
  return {
    card_id: cardId,
    product_key: 'jd:synthetic',
    platform: 'jd',
    final_price_fen: 1000,
    card: list('unused'),
  };
}

function harness(deferred: boolean) {
  const store = createMemoryResultSetStore();
  const keyword = createKeywordResults(store);
  const receipts = keyword.receipts(() => undefined);
  const inner: OrchestratorTools = {
    definitions: async () => [],
    enabledSearchPlatforms: async () => ['jd'],
    searchKeyword: async () => ({ results: [], cards: [] }),
    execute: vi.fn(async (call: OrchestratorToolCall, ctx: ToolContext): Promise<ToolOutcome> => {
      const ref = cardReference(ctx, 0);
      return {
        kind: 'ok',
        modelView: { items: [{ card_id: ref, title: '<untrusted>合成商品</untrusted>' }] },
        cards: [list(`set-${call.id}`)],
      };
    }),
  };
  const deps: ResultsDeps = {
    store,
    texts: { text: async (_app, key) => `文案:${key}` },
    limits: orchestratorLimitsDefaults(),
    ...(deferred ? { chains: keyword } : {}),
  };
  const tools = createResultsTools(inner, deps);

  async function search(id: string, args: Readonly<Record<string, unknown>>) {
    const scope = openServerCall(id, Object.freeze({}));
    const ctx: ToolContext = {
      subject: {
        appId: APP,
        traceId: 'synthetic-trace',
        deviceId: 'synthetic-device',
        deviceHash: 'synthetic-hash',
        ipKey: 'synthetic-ip-key',
        userId: null,
        phoneBound: false,
      },
      runId: `run-${id}`,
      sessionId: SESSION,
      signal: new AbortController().signal,
      placeholders: scope.placeholders,
    };
    try {
      return await tools.execute({ id, name: 'search_products', args }, ctx);
    } finally {
      scope.refs.close();
    }
  }

  return { store, receipts, search, chain: () => store.currentChain(APP, SESSION) };
}

it('[AC-B3-03r#1] 模型搜索的结果集先保存、不切链；首张 product_list 写出回执后才切为本轮条件', async () => {
  const h = harness(true);
  const outcome = await h.search('a', { q: '合成保温杯' });
  expect(outcome.kind).toBe('ok');
  expect(await h.chain()).toBeNull();
  await h.receipts.recordDelivered('set-a', []);
  expect(await h.chain()).toBeNull();
  await h.receipts.recordDelivered('set-a', [item('c2')]);
  expect(await h.chain()).toMatchObject({
    status: 'has_products',
    conditions: { q: '合成保温杯' },
  });
});

it('[AC-B3-03r#2] 没写出的一批不改当前链；之后写出的一批确认后才切', async () => {
  const h = harness(true);
  await h.search('a', { q: '合成保温杯' });
  await h.receipts.recordDelivered('set-a', [item('c2')]);
  const seen = await h.chain();
  await h.search('b', { q: '合成水杯', page: 2 });
  expect(await h.chain()).toEqual(seen);
  await h.search('c', { q: '合成茶杯' });
  await h.receipts.recordDelivered('set-c', [item('c6')]);
  expect(await h.chain()).toMatchObject({ conditions: { q: '合成茶杯' } });
  // A batch confirmed later (its receipt came last) is the current chain from then on.
  await h.receipts.recordDelivered('set-b', [item('c8')]);
  expect(await h.chain()).toMatchObject({ conditions: { q: '合成水杯', page: 2 } });
});

it('[AC-B3-03r#5] 价格澄清仍当即记为 awaiting_price；未接延后端口时照旧当即切链', async () => {
  const h = harness(true);
  const asked = await h.search('a', { q: '合成水杯', price_max_fen: 0 });
  expect(asked.kind).toBe('ok');
  expect(await h.chain()).toMatchObject({
    status: 'awaiting_price',
    conditions: { q: '合成水杯' },
  });

  const legacy = harness(false);
  await legacy.search('a', { q: '合成保温杯' });
  expect(await legacy.chain()).toMatchObject({
    status: 'has_products',
    conditions: { q: '合成保温杯' },
  });
});
