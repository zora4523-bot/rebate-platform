import { expect, vi } from 'vitest';
import { RecordingStore, modelKey } from '../../../../packages/evals/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  buildModelRequest,
  createPortTransport,
  ModelProtocolError,
  quirksFor,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import type {
  ChatMessage,
  ModelRequestShape,
  ToolDefinition,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import { createVendorGateway } from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import { createModelRouter } from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import type {
  RouterChatInput,
  RouterContext,
} from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import type { RunBodyInput } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type { RedactedText } from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import type {
  RunContext,
  UnnumberedCard,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import type {
  AgentRunBodyDeps,
  InputProceed,
  OrchestratorTrace,
  ToolOutcome,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { createAgentRunBody } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  FakeRunClock,
  FLASH,
  PLUS,
  ManualScheduler,
  quietBreaker,
  resolved,
} from '../model-routing/kit.ts';
import { appendExpected, response } from './fixtures/recordings.ts';
import type { ReplayTurn } from './fixtures/recordings.ts';

export { toolCall, referenceView } from './fixtures/recordings.ts';
export { FLASH, PLUS, resolved } from '../model-routing/kit.ts';

export function input(): RunBodyInput {
  return {
    caller: {
      appId: 'synthetic-app',
      traceId: 'synthetic-trace',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip-key',
      userId: 'synthetic-user',
      phoneBound: true,
    },
    sessionId: 'synthetic-session',
    runId: 'synthetic-run',
    userMessageId: 'synthetic-user-message',
    assistantMessageId: 'synthetic-assistant-message',
    text: '合成保温杯',
    redactedText: '合成保温杯' as RedactedText,
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
}

export function proceed(patch: Partial<InputProceed> = {}): InputProceed {
  return {
    kind: 'proceed',
    modelText: '合成保温杯',
    placeholders: {},
    links: [],
    notices: [],
    untrustedInput: false,
    paramsRequested: false,
    ...patch,
  };
}

export function notice(text = '合成提示'): UnnumberedCard {
  return {
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: 'agent.degraded.empty', actions: [] },
    fallback_text: text,
  };
}

export function productList(count: number): UnnumberedCard {
  return {
    type: 'product_list',
    schema_version: 1,
    fallback_text: '合成商品列表',
    data: {
      result_set_id: 'synthetic-results',
      layout: count <= 3 ? 'list' : 'grid',
      items: Array.from({ length: count }, (_, i) => ({
        product_key: `tb:synthetic-${i}`,
        item_ref: 'synthetic-ref',
        platform: 'taobao',
        shop_type: null,
        title: `合成商品${i}`,
        image: 'https://example.invalid/synthetic.png',
        shop_name: '合成店铺',
        price_fen: 1000,
        coupon_fen: 0,
        final_price_fen: 1000,
        est_net_price_fen: null,
        rebate_min_fen: null,
        rebate_max_fen: null,
        rebate_basis: 'amount_unknown',
        benefit_tags: [],
        match_tag: 'matched',
        spec_text: null,
        is_presale: false,
        tlj: null,
        link_id: `synthetic-link-${i}`,
        cta: { text_key: 'product.buy' },
        quoted_at: '2026-10-15T00:00:00.000Z',
        stale: false,
        age_sec: 0,
        source: 'taobao_union',
        disclaimer_keys: ['price_basis.general'],
        ad_label: null,
        availability: 'ok',
      })),
    },
  };
}

export type Event =
  | { kind: 'text'; text: string }
  | { kind: 'card'; card: UnnumberedCard }
  | { kind: 'status'; tool: string; phase: string; display: string }
  | { kind: 'suggestions'; items: Parameters<RunContext['suggestions']>[0] };

export function context(runId = 'synthetic-run') {
  const controller = new AbortController();
  const events: Event[] = [];
  const ctx: RunContext = {
    runId,
    sessionId: 'synthetic-session',
    signal: controller.signal,
    get cardsDelivered() {
      return events.filter((e) => e.kind === 'card').length;
    },
    // Deliberately do not suppress after abort: any late write must fail the test assertions.
    text: (text) => {
      events.push({ kind: 'text', text });
    },
    card: async (card) => {
      events.push({ kind: 'card', card });
    },
    toolStatus: (tool, phase, display) => {
      events.push({ kind: 'status', tool, phase, display });
    },
    suggestions: (items) => {
      events.push({ kind: 'suggestions', items });
    },
  };
  return {
    controller,
    events,
    ctx,
    text: () => events.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join(''),
    content: () => events.filter((e) => e.kind !== 'status'),
  };
}

export interface SetupOptions {
  readonly proceed?: InputProceed;
  readonly outcomes?: readonly ToolOutcome[];
  readonly budget?: boolean;
  readonly modelMs?: number;
  readonly failAfter?: number;
  /** Synthesize primary timeout; only the backup has a successful recording. */
  readonly primaryTimeout?: boolean;
}

export function setup(turns: readonly ReplayTurn[] = [], options: SetupOptions = {}) {
  const prepared = options.proceed ?? proceed();
  const definitions: ToolDefinition[] = [
    {
      name: 'search_products',
      description: '合成搜索工具',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          platform: { type: 'string', enum: ['taobao', 'jd', 'pdd'] },
        },
        additionalProperties: false,
      },
    },
  ];
  const messages: ChatMessage[] = [{ role: 'user', content: prepared.modelText }];
  const store = new RecordingStore(
    turns.map((turn) => {
      const request = buildModelRequest(
        {
          vendor: 'qwen',
          model: options.primaryTimeout ? PLUS : FLASH,
          system: '合成系统前缀',
          tools: definitions,
          messages: structuredClone(messages),
        },
        quirksFor('qwen'),
      );
      appendExpected(messages, turn);
      return { kind: 'model', key: modelKey(request), response: response(turn) };
    }),
  );
  const requests: ModelRequestShape[] = [];
  const misses: unknown[] = [];
  const transport = createPortTransport(async (request) => {
    requests.push(request);
    if (options.primaryTimeout && request.model === FLASH)
      throw new ModelProtocolError('timeout', 'synthetic primary timeout');
    if (options.failAfter !== undefined && requests.length > options.failAfter)
      throw new ModelProtocolError('network', 'synthetic failure');
    try {
      return store.model(request);
    } catch (error) {
      misses.push(error);
      throw error;
    }
  });
  const scheduler = new ManualScheduler();
  const clock = new FixedClock('2026-10-15T00:00:00.000Z');
  const meter = { record: vi.fn() };
  const gateway = createVendorGateway({
    transport,
    clock,
    onlineMeter: meter,
    offlineMeter: meter,
    offlineBudgetApproved: [],
    rewrittenSampleGrants: [],
    ownerAggregateApprovals: [],
  });
  const route = vi.fn(() => resolved('flash', 'plus'));
  const router = createModelRouter({
    gateway,
    route,
    budgetExhausted: () => options.budget ?? false,
    config: { attemptTimeoutMs: 3000, breaker: quietBreaker() },
    scheduler,
    meter,
    clock,
  });
  const complete = vi.fn((chat: RouterChatInput, ctx: RouterContext) => router.complete(chat, ctx));
  let executionIndex = 0;
  const execute = vi.fn<AgentRunBodyDeps['tools']['execute']>(async () => {
    const outcome = options.outcomes?.[executionIndex];
    executionIndex += 1;
    return outcome ?? { kind: 'ok', modelView: {}, cards: [] };
  });
  const degraded = vi.fn<AgentRunBodyDeps['degraded']['run']>(async () => ({
    kind: 'done',
    finishReason: 'fallback',
  }));
  const traces: OrchestratorTrace[] = [];
  const review = vi.fn<AgentRunBodyDeps['review']['review']>(async () => 'pass');
  const check = vi.fn<AgentRunBodyDeps['inputCheck']['check']>(async () => prepared);
  const modelClocks: FakeRunClock[] = [];
  const deps: AgentRunBodyDeps = {
    model: { complete },
    modelClock: () => {
      const value = new FakeRunClock(options.modelMs ?? 8000);
      modelClocks.push(value);
      return value;
    },
    tools: {
      definitions: vi.fn(async () => definitions),
      execute,
      enabledSearchPlatforms: vi.fn(async () => []),
      searchKeyword: vi.fn(async () => ({ results: [], cards: [] })),
    },
    inputCheck: { check },
    degraded: { run: degraded },
    review: { review },
    texts: {
      text: vi.fn(async (_appId, key) => `固定文案:${key}`),
      toolDisplay: vi.fn(async (_appId, tool, phase) => `模板:${tool}:${phase}`),
    },
    prompt: { current: vi.fn(async () => ({ version: 'synthetic-v1', system: '合成系统前缀' })) },
    // Expected defaults are literals from 02 §9.1–9.2, never taken from the SUT.
    limits: { toolCalls: 4, modelRounds: 3, textCodePoints: 20000, cards: 12, contentFrames: 400 },
    // Synthetic non-sensitive args only; the masking wiring case injects its own result.
    traceMask: vi.fn((args) => args),
    trace: {
      record: (_runId, trace) => {
        traces.push(trace);
      },
    },
  };
  const output = context();
  return {
    ...output,
    deps,
    complete,
    execute,
    degraded,
    review,
    check,
    requests,
    traces,
    modelClocks,
    route,
    store,
    run: (patch: Partial<AgentRunBodyDeps> = {}, value = input()) =>
      createAgentRunBody({ ...deps, ...patch })(value)(output.ctx),
    replayed: () => {
      expect(misses).toEqual([]);
      expect(store.unused()).toEqual([]);
    },
  };
}
