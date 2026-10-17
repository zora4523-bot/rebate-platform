import { expect, vi } from 'vitest';
import { bridge } from '../../../../packages/contracts-ts/src/index.ts';
import { createIntentPort } from '../../../../apps/api/src/modules/agent/orchestrator/intents/index.ts';
import type {
  ClarifySlot,
  IntentDeps,
  IntentRequest,
  IntentTrace,
  TemplateCall,
} from '../../../../apps/api/src/modules/agent/orchestrator/intents/index.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type { RedactedText } from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import type { InputProceed } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type {
  RunContext,
  UnnumberedCard,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { numberCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { frameIsValid } from '../stream-writer/kit.ts';

// BR-AI-01 页面引导: independent expected MVP list; production must read the injected sources.
export const ROUTES = [
  'Wallet',
  'WithdrawRecords',
  'AuthManage',
  'OrderList',
  'InviteShare',
  'Messages',
];
export const MEMBER = { userId: 'synthetic-user', phoneBound: true };
export const GUEST = { userId: null, phoneBound: false };
export const UNBOUND = { userId: 'synthetic-user', phoneBound: false };
export const OPTIONS = [
  { text: '合成选项甲', send_text: '合成选择甲' },
  { text: '合成选项乙', send_text: '合成选择乙' },
  { text: '合成选项丙', send_text: '合成选择丙' },
] as const;

export function copy(key: string): string {
  return `合成固定文案:${key}`;
}

export function request(
  output: unknown,
  userText = '合成请求',
  caller: Partial<AgentCaller> = MEMBER,
  flags: Partial<InputProceed> = {},
): IntentRequest {
  return {
    text: typeof output === 'string' ? output : JSON.stringify(output),
    input: {
      caller: {
        appId: 'synthetic-app',
        traceId: 'synthetic-trace',
        deviceId: 'synthetic-device',
        deviceHash: 'synthetic-hash',
        ipKey: 'synthetic-ip',
        ...MEMBER,
        ...caller,
      },
      sessionId: 'synthetic-session',
      runId: 'synthetic-run',
      userMessageId: 'synthetic-user-message',
      assistantMessageId: 'synthetic-assistant-message',
      text: userText,
      redactedText: userText as RedactedText,
      limits: { memberDaily: 30, guestDaily: 5, guestIpDaily: 20, perMinute: 6, maxRounds: 20 },
    },
    proceed: {
      kind: 'proceed',
      modelText: userText,
      placeholders: {},
      links: [],
      notices: [],
      untrustedInput: false,
      paramsRequested: false,
      ...flags,
    },
  };
}

export function outputContext(runId = 'synthetic-run', sessionId = 'synthetic-session') {
  const cards: UnnumberedCard[] = [];
  const texts: string[] = [];
  const suggestions: Parameters<RunContext['suggestions']>[0][] = [];
  const ctx: RunContext = {
    runId,
    sessionId,
    signal: new AbortController().signal,
    get cardsDelivered() {
      return cards.length;
    },
    text: (text) => {
      texts.push(text);
    },
    card: async (card) => {
      cards.push(card);
    },
    suggestions: (items) => {
      suggestions.push(items);
    },
    toolStatus: vi.fn(),
  };
  return { ctx, cards, texts, suggestions };
}

export function fallbackNotice(slot: ClarifySlot): UnnumberedCard {
  // Synthetic copy supplied by the text/card port; B3-13 owns actual dictionary wording/keys.
  return {
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: `synthetic.clarify.${slot}`, actions: [] },
    fallback_text:
      slot === 'reference' ? '合成提示：已按第一个商品处理' : '合成提示：未识别条件，已移除',
  };
}

export function kit() {
  const configured = [...ROUTES];
  const disabled = new Set<string>();
  const registered = new Set(['list_my_orders', 'explain_order', 'get_my_earnings']);
  const calls: TemplateCall[] = [];
  const traces: { appId: string; runId: string; value: IntentTrace }[] = [];
  const asked = new Set<string>();
  const state = { chainId: 'synthetic-chain', products: [] as UnnumberedCard[] };
  let port: ReturnType<typeof createIntentPort> | undefined;
  const deps: IntentDeps = {
    routes: {
      configured: vi.fn(async () => [...configured]),
      contract: vi.fn(() => bridge.routes),
    },
    flags: { enabled: vi.fn(async (_app, key) => !disabled.has(key)) },
    tools: { registered: vi.fn((name) => registered.has(name)) },
    texts: { text: vi.fn(async (_app, key) => copy(key)) },
    trace: {
      calls: vi.fn(async () => [...calls]),
      record: (appId, runId, value) => {
        traces.push({ appId, runId, value });
      },
    },
    clarification: {
      scope: vi.fn(async (req) => ({
        appId: req.input.caller.appId,
        sessionId: req.input.sessionId,
        chainId: state.chainId,
      })),
      takeOnce: vi.fn(async (scope, slot) => {
        const key = JSON.stringify([scope.appId, scope.sessionId, scope.chainId, slot]);
        if (asked.has(key)) return false;
        asked.add(key);
        return true;
      }),
      options: vi.fn(async () => OPTIONS),
      latestProducts: vi.fn(async () => [...state.products]),
      fallbackNotice: vi.fn(async (_app, slot) => fallbackNotice(slot)),
      withoutCondition: vi.fn<IntentDeps['clarification']['withoutCondition']>(async () => ({
        kind: 'done',
        finishReason: 'stop',
      })),
    },
    continuation: {
      previousIntent: vi.fn(async () => null),
      run: vi.fn<IntentDeps['continuation']['run']>(async () => ({
        kind: 'done',
        finishReason: 'stop',
      })),
    },
  };
  return {
    deps,
    configured,
    disabled,
    registered,
    calls,
    traces,
    state,
    async run(req: IntentRequest) {
      const output = outputContext(req.input.runId, req.input.sessionId);
      port ??= createIntentPort(deps);
      const result = await port.handle(req, output.ctx);
      for (const [index, card] of output.cards.entries()) {
        expect(
          frameIsValid({
            event: 'card',
            id: index + 1,
            data: { ...numberCard(card, index + 1).card, seq: index + 1 },
          }),
        ).toBe(true);
      }
      return { ...output, result };
    },
  };
}

export function expectGuide(
  output: Awaited<ReturnType<ReturnType<typeof kit>['run']>>,
  route: string,
) {
  expect(output.result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(output.cards).toEqual([
    {
      type: 'page_guide',
      schema_version: 1,
      data: { route, text_key: `agent.guide.${route}` },
      fallback_text: copy(`agent.guide.${route}`),
    },
  ]);
  expect(output.texts).toEqual([]);
  expect(output.suggestions).toEqual([]);
}
