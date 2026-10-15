import { expect, it, vi } from 'vitest';
import type { RunBodyInput } from '../../http/index.ts';
import type { RedactedText } from '../../stream/admission/index.ts';
import type { ModelOutcome } from '../../model-gateway/routing/index.ts';
import type { RunContext } from '../../stream/run/index.ts';
import { createAgentRunBody, orchestratorLimitsDefaults } from './factories.ts';
import type { AgentRunBodyDeps, OrchestratorTrace, ToolOutcome } from './ports.ts';
import { intentOf } from './run.ts';

function input(): RunBodyInput {
  return {
    caller: {
      appId: 'synthetic-app',
      traceId: 'synthetic-trace',
      deviceId: 'synthetic-device',
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip-key',
      userId: null,
      phoneBound: false,
    },
    sessionId: 'synthetic-session',
    runId: 'synthetic-run',
    userMessageId: 'synthetic-user-message',
    assistantMessageId: 'synthetic-assistant-message',
    text: '合成订单 987654321012',
    redactedText: '合成订单 <num_1>' as RedactedText,
    limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
  };
}

function context(): { ctx: RunContext; texts: string[]; suggestions: unknown[][] } {
  const texts: string[] = [];
  const suggestions: unknown[][] = [];
  const ctx: RunContext = {
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    cardsDelivered: 0,
    text: (text) => {
      texts.push(text);
    },
    toolStatus: () => undefined,
    card: async () => undefined,
    suggestions: (items) => {
      suggestions.push([...items]);
    },
  };
  return { ctx, texts, suggestions };
}

function baseDeps(
  rounds: ModelOutcome[],
  execute: AgentRunBodyDeps['tools']['execute'],
  placeholders: Readonly<Record<string, string>> = {},
): AgentRunBodyDeps {
  return {
    model: { complete: vi.fn(async () => rounds.shift()!) },
    modelClock: () => ({ remainingMs: () => 1000, charge: () => undefined }),
    tools: {
      definitions: async () => [
        { name: 'search_products', description: 'synthetic', parameters: { type: 'object' } },
      ],
      execute,
      enabledSearchPlatforms: async () => [],
      searchKeyword: async () => ({ results: [], cards: [] }),
    },
    inputCheck: {
      check: async () => ({
        kind: 'proceed',
        modelText: '合成订单 <num_1>',
        placeholders,
        links: [],
        notices: [],
        untrustedInput: false,
        paramsRequested: false,
      }),
    },
    degraded: { run: async () => ({ kind: 'done', finishReason: 'fallback' }) },
    review: { review: async () => 'pass' },
    texts: { text: async (_app, key) => key, toolDisplay: async () => 'synthetic' },
    prompt: { current: async () => ({ version: 'synthetic-v1', system: 'synthetic' }) },
    limits: orchestratorLimitsDefaults(),
    traceMask: (args) => args,
  };
}

function call(id: string, name: string, args: string) {
  return { id, type: 'function' as const, function: { name, arguments: args } };
}

function modelRound(events: Extract<ModelOutcome, { kind: 'model' }>['events']): ModelOutcome {
  return {
    kind: 'model',
    entryId: 'flash',
    model: 'synthetic-flash',
    usage: { input_tokens: 1, output_tokens: 1 },
    attempts: [{ entryId: 'flash', result: 'ok', elapsedMs: 0 }],
    events,
  };
}

it('[B3-05b review S2] every traced tool call goes through traceMask, whatever its status', async () => {
  const args = '{"order_no":"<num_1>"}';
  const rounds = [
    modelRound([
      { t: 'tool_call', index: 0, call: call('a', 'search_products', args) },
      { t: 'tool_call', index: 1, call: call('b', 'search_products', args) },
      { t: 'tool_call', index: 2, call: call('c', 'synthetic_unknown', args) },
      { t: 'tool_call', index: 3, call: call('d', 'search_products', '{not json') },
      { t: 'done', reason: 'tool_calls' },
    ]),
    modelRound([
      { t: 'text_delta', text: '合成说明。' },
      { t: 'done', reason: 'stop' },
    ]),
  ];
  const outcomes: ToolOutcome[] = [
    { kind: 'rejected', modelView: { error: 'invalid_args' } },
    { kind: 'failed', modelView: { error: 'synthetic_failed' } },
  ];
  const execute = vi.fn(
    async (): Promise<ToolOutcome> => outcomes.shift() ?? { kind: 'ok', modelView: {}, cards: [] },
  );
  const traces: OrchestratorTrace[] = [];
  const placeholders = { '<num_1>': '987654321012' };
  const traceMask = vi.fn(() => 'masked');
  const deps: AgentRunBodyDeps = {
    ...baseDeps(rounds, execute, placeholders),
    traceMask,
    trace: { record: (_runId, trace) => traces.push(trace) },
  };
  const out = context();
  expect(await createAgentRunBody(deps)(input())(out.ctx)).toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  expect(execute).toHaveBeenCalledTimes(2);
  expect(traces[0]?.tool_calls).toEqual([
    { name: 'search_products', args: 'masked', status: 'rejected' },
    { name: 'search_products', args: 'masked', status: 'failed' },
    { name: 'synthetic_unknown', args: 'masked', status: 'rejected' },
    { name: 'search_products', args: 'masked', status: 'rejected' },
  ]);
  expect(traceMask.mock.calls).toEqual([
    [{ order_no: '<num_1>' }, placeholders],
    [{ order_no: '<num_1>' }, placeholders],
    [{ order_no: '<num_1>' }, placeholders],
    ['{not json', placeholders],
  ]);
  expect(JSON.stringify(traces)).not.toContain('<num_1>');
  expect(out.texts.join('')).toBe('合成说明。');
});

it.each(['same round', 'across rounds'] as const)(
  '[B3-05b review-codex-r1 S1][BR-AI-06] suggestions are capped at 3 per run, %s',
  async (mode) => {
    const toolA = call('a', 'search_products', '{"q":"合成甲"}');
    const toolB = call('b', 'search_products', '{"q":"合成乙"}');
    const finalRound = modelRound([
      { t: 'text_delta', text: '合成说明。' },
      { t: 'done', reason: 'stop' },
    ]);
    const rounds =
      mode === 'same round'
        ? [
            modelRound([
              { t: 'tool_call', index: 0, call: toolA },
              { t: 'tool_call', index: 1, call: toolB },
              { t: 'done', reason: 'tool_calls' },
            ]),
            finalRound,
          ]
        : [
            modelRound([
              { t: 'tool_call', index: 0, call: toolA },
              { t: 'done', reason: 'tool_calls' },
            ]),
            modelRound([
              { t: 'tool_call', index: 0, call: toolB },
              { t: 'done', reason: 'tool_calls' },
            ]),
            finalRound,
          ];
    const batch = (tag: string) =>
      [1, 2, 3].map((i) => ({ text: `合成建议${tag}${i}`, send_text: `合成后续${tag}${i}` }));
    const first = batch('甲');
    const second = batch('乙');
    const results = [first, second];
    const execute = vi.fn(async (): Promise<ToolOutcome> => ({
      kind: 'ok',
      modelView: {},
      cards: [],
      suggestions: results.shift() ?? [],
    }));
    const out = context();
    expect(await createAgentRunBody(baseDeps(rounds, execute))(input())(out.ctx)).toEqual({
      kind: 'done',
      finishReason: 'stop',
    });
    expect(execute).toHaveBeenCalledTimes(2);
    // 3 in total for the run; the second tool's suggestions find no room and are dropped.
    expect(out.suggestions).toEqual([first]);
    expect(out.suggestions.flat()).toHaveLength(3);
    expect(out.texts.join('')).toBe('合成说明。');
  },
);

it('[B3-05b review-codex-r1 S1][BR-AI-06] a partial batch only uses the room left in the run', async () => {
  const rounds = [
    modelRound([
      { t: 'tool_call', index: 0, call: call('a', 'search_products', '{}') },
      { t: 'tool_call', index: 1, call: call('b', 'search_products', '{}') },
      { t: 'done', reason: 'tool_calls' },
    ]),
    modelRound([{ t: 'done', reason: 'stop' }]),
  ];
  const results = [
    [{ text: '合成一', send_text: '合成一' }],
    [1, 2, 3].map((i) => ({ text: `合成${i}`, send_text: `合成${i}` })),
  ];
  const execute = vi.fn(async (): Promise<ToolOutcome> => ({
    kind: 'ok',
    modelView: {},
    cards: [],
    suggestions: results.shift() ?? [],
  }));
  const out = context();
  await createAgentRunBody(baseDeps(rounds, execute))(input())(out.ctx);
  expect(out.suggestions).toEqual([
    [{ text: '合成一', send_text: '合成一' }],
    [
      { text: '合成1', send_text: '合成1' },
      { text: '合成2', send_text: '合成2' },
    ],
  ]);
});

it('[B3-05b] invalid limits are rejected when the body factory is built', () => {
  const limits = { ...orchestratorLimitsDefaults(), cards: 0 };
  expect(() => createAgentRunBody({ limits } as AgentRunBodyDeps)).toThrow(RangeError);
});

it('[B3-05b] intentOf recognises intent objects only', () => {
  expect(intentOf('{"agent_intent":"page_guide","route":"wallet"}')).toEqual({
    name: 'page_guide',
  });
  expect(intentOf('```json\n{"agent_intent":"clarify"}\n```')).toEqual({ name: 'clarify' });
  expect(intentOf('{"agent_intent": 3}')).toEqual({ name: null });
  expect(intentOf('{"agent_intent":"page_gu')).toEqual({ name: null });
  expect(intentOf('{"title":"合成"}')).toBeUndefined();
  expect(intentOf('合成说明 {"agent_intent":"x"}')).toBeUndefined();
  expect(intentOf('[1,2]')).toBeUndefined();
});
