import { vi } from 'vitest';
import type {
  AgentPorts,
  EvalCase,
  RunMeta,
  StreamFrame,
  TurnOutput,
} from '../../../../packages/evals/src/index.ts';
import { RecordingStore, modelKey } from '../../../../packages/evals/src/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  buildModelRequest,
  createPortTransport,
  quirksFor,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import type { ChatMessage } from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';
import { createVendorGateway } from '../../../../apps/api/src/modules/agent/model-gateway/vendors/index.ts';
import { createModelRouter } from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import { createAgentRunBody } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { ToolOutcome } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type {
  EvalAgentDeps,
  EvalInput,
  EvalRun,
} from '../../../../apps/api/src/modules/agent/orchestrator/eval/index.ts';
import type { RunContext } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { numberCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { input, proceed, setup } from '../orchestrator-core/kit.ts';
import { appendExpected, response, toolCall } from '../orchestrator-core/fixtures/recordings.ts';
import type { ReplayTurn } from '../orchestrator-core/fixtures/recordings.ts';
import { FLASH, ManualScheduler, quietBreaker, resolved } from '../model-routing/kit.ts';
import { syntheticProductList } from './product-fixture.ts';

// Entirely synthetic smoke material, not the private release smoke set (BR-AI-21).
export const smokeCase: EvalCase = {
  id: 'synthetic-B3-05c-search',
  set: 'smoke',
  category: 'T2',
  split: 'holdout',
  group: 'synthetic-B3-05c',
  provenance: 'synthetic',
  subject: 'bound_phone',
  switches: { synthetic_switch: true },
  turns: [{ text: '合成保温杯', untrusted: true }],
  expect: {
    intent: 'search',
    cards: ['product_list'],
    tools: [
      { name: 'search_products', args: { q: '合成保温杯' } },
      { name: 'search_products', args: { q: '合成失败查询' } },
      { name: 'search_products', args: { q: '合成拒绝查询' } },
    ],
    forbid: ['amount_in_text', 'url_in_text', 'identity_arg'],
  },
};

export const evalInput: EvalInput = {
  case_id: smokeCase.id,
  turn: 1,
  text: '合成保温杯',
  untrusted: true,
  subject: 'bound_phone',
  switches: { synthetic_switch: true },
};

export const reportMeta: RunMeta = {
  mode: 'A',
  vendor: 'qwen',
  model_snapshot: FLASH,
  prompt_sha256: 'a'.repeat(64),
  sampling: {},
  eval_set: {
    set: 'smoke',
    version: 'synthetic-v1',
    content_sha256: 'b'.repeat(64),
    split_sha256: 'c'.repeat(64),
  },
  tool_schema_version: 'synthetic-v1',
  code_commit: 'd'.repeat(40),
  grader_version: 'synthetic-v1',
  recordings_sha256: 'e'.repeat(64),
  unused_recordings: 0,
  started_at: '2026-10-15T00:00:00.000Z',
  finished_at: '2026-10-15T00:00:00.000Z',
};

export const expectedTrace: TurnOutput['trace'] = {
  intent: 'search',
  tool_calls: [
    { name: 'search_products', args: { q: '合成保温杯' }, status: 'ok' },
    { name: 'search_products', args: { q: '合成失败查询' }, status: 'failed' },
    { name: 'search_products', args: { q: '合成拒绝查询' }, status: 'rejected' },
  ],
  card_sources: [
    {
      card_id: 'c2',
      fields: {
        price_fen: 1000,
        coupon_fen: 0,
        final_price_fen: 1000,
        rebate_min_fen: null,
        rebate_max_fen: null,
      },
    },
  ],
  link_registrations: [{ link_id: 'synthetic-link-0', product_key: 'tb:synthetic-0', ok: true }],
};

const turns: readonly ReplayTurn[] = [
  {
    calls: [
      toolCall('synthetic-ok'),
      toolCall('synthetic-failed', { q: '合成失败查询' }),
      toolCall('synthetic-rejected', { q: '合成拒绝查询' }),
    ],
    views: [
      { reference: 'synthetic-card' },
      { error: 'synthetic_unavailable' },
      { error: 'invalid_args' },
    ],
  },
  { parts: ['{"agent_intent":"search"}'] },
];

export function evalFixture() {
  const outcomes: ToolOutcome[] = [
    {
      kind: 'ok',
      modelView: { reference: 'synthetic-card' },
      cards: [syntheticProductList()],
      trace: {
        card_sources: structuredClone(expectedTrace.card_sources!),
        link_registrations: structuredClone(expectedTrace.link_registrations!),
      },
    },
    { kind: 'failed', modelView: { error: 'synthetic_unavailable' } },
    { kind: 'rejected', modelView: { error: 'invalid_args' } },
  ];
  const created: EvalRun[] = [];
  const seenInputs: EvalInput[] = [];
  const deps: EvalAgentDeps = {
    createRun(value, bindings) {
      seenInputs.push(structuredClone(value));
      const base = setup([], {
        outcomes,
        proceed: proceed({ modelText: value.text, untrustedInput: value.untrusted }),
      });
      const clock = new FixedClock('2026-10-15T00:00:00.000Z');
      const meter = { record: vi.fn() };
      const gateway = createVendorGateway({
        transport: bindings.transport,
        clock,
        onlineMeter: meter,
        offlineMeter: meter,
        offlineBudgetApproved: [],
        rewrittenSampleGrants: [],
        ownerAggregateApprovals: [],
      });
      const model = createModelRouter({
        gateway,
        route: () => resolved('flash'),
        budgetExhausted: () => false,
        config: { attemptTimeoutMs: 3000, breaker: quietBreaker() },
        scheduler: new ManualScheduler(),
        meter,
        clock,
      });
      const body = createAgentRunBody({
        ...base.deps,
        model,
        trace: bindings.trace,
        intents: {
          handle: async (_request, ctx) => {
            ctx.text('请查看合成商品卡片。');
            return { kind: 'done', finishReason: 'stop' };
          },
        },
      })(input());
      const run: EvalRun = {
        body,
        firstCardNo: 1,
        quotaLeft: 4,
        meta: {
          session_id: 'synthetic-session',
          run_id: 'synthetic-run',
          message_id: 'synthetic-assistant-message',
          prompt_version: 'synthetic-v1',
          model_label: '合成模型',
          ai_label: '合成内容标识',
        },
      };
      created.push(run);
      return run;
    },
  };
  return { deps, created, seenInputs };
}

/** Exact request-key recordings for the real core/gateway; no ordering-only fake model. */
export async function recordingStore() {
  const base = setup();
  const definitions = await base.deps.tools.definitions('synthetic-app', input().caller);
  const messages: ChatMessage[] = [{ role: 'user', content: '合成保温杯' }];
  return new RecordingStore(
    turns.map((turn) => {
      const request = buildModelRequest(
        {
          vendor: 'qwen',
          model: FLASH,
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
}

export function storePorts(store: RecordingStore): AgentPorts {
  return {
    model: vi.fn(async (request) => store.model(request)),
    tool: vi.fn(async (call) => store.tool(call)),
  };
}

/** Independent fake RunContext: explicitly maps the same body callbacks to wire shapes.
 * RunBody emits no meta/terminal itself; these are the adapter's only framing additions.
 * No meta fields are ignored in comparisons: supplied synthetic metadata is deterministic.
 */
export async function directFrames(run: EvalRun): Promise<StreamFrame[]> {
  const frames: StreamFrame[] = [{ event: 'meta', id: 1, data: { ...run.meta } }];
  let nextCard = run.firstCardNo;
  let delivered = 0;
  const emit = (event: string, data: Record<string, unknown>, withSeq = false) => {
    const id = frames.length + 1;
    frames.push({ event, id, data: withSeq ? { ...data, seq: id } : data });
  };
  const ctx: RunContext = {
    runId: run.meta.run_id,
    sessionId: run.meta.session_id,
    signal: new AbortController().signal,
    get cardsDelivered() {
      return delivered;
    },
    text: (delta) => emit('text.delta', { delta }, true),
    toolStatus: (tool, phase, displayText) =>
      emit('tool.status', { tool, phase, display_text: displayText }, true),
    card: async (value) => {
      const numbered = numberCard(value, nextCard);
      nextCard += numbered.used;
      delivered += numbered.used;
      emit('card', { ...numbered.card }, true);
    },
    suggestions: (items) => emit('suggestions', { items }),
  };
  const result = await run.body(ctx);
  if (result.kind === 'error') emit('error', { ...result.error });
  else emit('done', { finish_reason: result.finishReason, quota_left: run.quotaLeft });
  return frames;
}

export async function directRun(fixture: ReturnType<typeof evalFixture>, store: RecordingStore) {
  const traces: unknown[] = [];
  const ports = storePorts(store);
  const run = await fixture.deps.createRun(evalInput, {
    transport: createPortTransport(ports.model),
    tool: ports.tool,
    trace: {
      record: (_id, trace) => {
        traces.push(trace);
      },
    },
  });
  return { frames: await directFrames(run), traces };
}
