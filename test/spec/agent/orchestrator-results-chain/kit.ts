import { expect, vi } from 'vitest';
import type {
  OrchestratorTools,
  ToolContext,
  ToolOutcome,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  createClarification,
  createMemoryResultSetStore,
  createRefinement,
  createResultsTools,
  type ResultSetStore,
  type ResultsDeps,
} from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import type { IntentOutput } from '../../../../apps/api/src/modules/agent/orchestrator/intents/index.ts';
import { outputContext, request } from '../orchestrator-intents/kit.ts';
import { copy, outcome, product } from '../orchestrator-results/kit.ts';

export { cards, delivered, noticeKeys, outcome, product } from '../orchestrator-results/kit.ts';
export { request };

export const QUERY = '合成追问链牛奶';
// BR-AI-08: zero is invalid; an unanswered price slot has exactly three quick options.
export const INVALID_PRICE = { q: QUERY, price_max_fen: 0 };

/** Missing new methods must fail as assertions, not spyOn errors or TypeError in the red phase. */
export function expectChainPort(store: ResultSetStore) {
  expect(store.currentChain).toBeTypeOf('function');
  expect(store.appendChain).toBeTypeOf('function');
}

/** Keep the actual memory store, including its chain port; never use the frozen fixture(). */
export function chainKit(store: ResultSetStore = createMemoryResultSetStore()) {
  const req = request('');
  const ctx: ToolContext = {
    subject: req.input.caller,
    sessionId: req.input.sessionId,
    runId: req.input.runId,
    signal: new AbortController().signal,
    placeholders: {},
  };
  const replies: ToolOutcome[] = [];
  let sequence = 0;
  const execute = vi.fn<OrchestratorTools['execute']>(async (call) => {
    const args = call.args as Record<string, unknown>;
    sequence += 1;
    return (
      replies.shift() ??
      outcome(
        [product()],
        `synthetic-result-${sequence}`,
        typeof args['spec'] === 'string' ? args['spec'] : null,
        typeof args['page'] === 'number' ? args['page'] : 1,
      )
    );
  });
  const inner: OrchestratorTools = {
    execute,
    definitions: async () => [],
    enabledSearchPlatforms: async () => ['jd', 'taobao'],
    searchKeyword: async () => ({ cards: [], results: [] }),
  };
  const deps: ResultsDeps = {
    store,
    texts: { text: async (_app, key) => copy(key) },
    // Task §9 #5; BR-AI-08 counts appended searches in this same four-call budget.
    limits: { toolCalls: 4, modelRounds: 3, textCodePoints: 100, cards: 30, contentFrames: 30 },
  };
  const tools = createResultsTools(inner, deps);
  const refinement = createRefinement({ ...deps, tools });
  const clarification = createClarification({ ...deps, tools });
  let callSequence = 0;
  return {
    ctx,
    tools,
    execute,
    replies,
    clarification,
    call(args: unknown = { q: QUERY }, context = ctx, name = 'search_products') {
      callSequence += 1;
      return tools.execute({ id: `synthetic-call-${callSequence}`, name, args }, context);
    },
    async refine(
      conditions: Extract<IntentOutput, { agent_intent: 'refine' }>['conditions'],
      runId = 'synthetic-refinement-run',
    ) {
      const next = { ...req, input: { ...req.input, runId } };
      const output = outputContext(runId, req.input.sessionId);
      const result = await refinement.run({ agent_intent: 'refine', conditions }, next, output.ctx);
      return { ...output, result };
    },
  };
}

export function expectPriceQuestion(result: ToolOutcome) {
  expect(result).toMatchObject({
    kind: 'ok',
    cards: [],
    suggestions: [1, 2, 3].map((n) => ({
      text: copy(`agent.suggest.clarify.price.${n}`),
      send_text: copy(`agent.suggest.clarify.price.${n}`),
    })),
  });
  expect(result.kind === 'ok' ? result.suggestions : undefined).toHaveLength(3);
}

/** Old five-method adapters remain supported, with fallback keyed by this object's identity. */
export function legacyStore(memory: ResultSetStore): ResultSetStore {
  return {
    save: (value) => memory.save(value),
    recordDelivered: (id, items) => memory.recordDelivered(id, items),
    latestWithProducts: (app, session) => memory.latestWithProducts(app, session),
    findDelivered: (app, session, card) => memory.findDelivered(app, session, card),
    takeOnce: (scope, slot) => memory.takeOnce(scope, slot),
  };
}
