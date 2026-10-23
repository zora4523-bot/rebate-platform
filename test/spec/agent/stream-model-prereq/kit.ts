// B3-03n rule-test kit (no database, no Nest): a run context that numbers and confirms cards the
// way the RunManager does (numberCard, then the `delivered` receipt for a written frame only), a
// scripted model for the core's model path, a core body over synthetic ports, and the input review
// budget probe of BR-AI-18. Existing kits are imported unchanged; nothing of them is replaced.
import { expect, vi } from 'vitest';
import type { RunBodyInput } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type {
  AgentRunBodyDeps,
  InputCheckPort,
  InputProceed,
  OrchestratorTools,
  ToolOutcome,
} from '../../../../apps/api/src/modules/agent/orchestrator/core/ports.ts';
import { createRunModelClock } from '../../../../apps/api/src/modules/agent/model-gateway/routing/index.ts';
import {
  numberCard,
  type RunContext,
  type UnnumberedCard,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { input, productList } from '../orchestrator-core/kit.ts';
import { until } from '../stream-recovery/kit.ts';
import { flush, type ManualTime } from '../stream-run/kit.ts';

export type Row = Record<string, unknown>;

type Complete = AgentRunBodyDeps['model']['complete'];
type ModelOk = Extract<Awaited<ReturnType<Complete>>, { kind: 'model' }>;
type ModelEvent = ModelOk['events'][number];
export type RecordDelivered = NonNullable<AgentRunBodyDeps['results']>['recordDelivered'];
export type CardFrame = ReturnType<typeof numberCard>['card'];

/** BR-AI-18 fail-close of the input review (B3-03m), as the input check returns it. */
export const UNAVAILABLE = {
  kind: 'refuse',
  textKey: 'agent.refuse.safety_unavailable',
  finishReason: 'safety',
  ending: 'input_review_timeout',
} as const;

export const TIMEOUT_KEY = 'agent.safety.timeout_ms';

/** One model round: an optional text and the tool calls it asks for. */
export interface Round {
  readonly text?: string;
  readonly calls?: readonly { readonly name: string; readonly args: unknown }[];
}

/** model.complete answering the rounds in order (an empty final text once they run out). */
export function scriptedModel(rounds: readonly Round[]) {
  let index = 0;
  return vi.fn<Complete>(async () => {
    const round = rounds[index] ?? { text: '' };
    index += 1;
    const events: ModelEvent[] = [];
    if (round.text !== undefined && round.text !== '') {
      events.push({ t: 'text_delta', text: round.text });
    }
    (round.calls ?? []).forEach((call, position) => {
      events.push({
        t: 'tool_call',
        index: position,
        call: {
          id: `synthetic-call-${String(index)}-${String(position)}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        },
      });
    });
    const outcome: ModelOk = {
      kind: 'model',
      entryId: 'synthetic-entry',
      model: 'synthetic-model',
      events,
      usage: { input_tokens: 0, output_tokens: 0 },
      attempts: [],
    };
    return outcome;
  });
}

/** The parts of a body that let the core take its model path over any tools. */
export function modelPath(rounds: readonly Round[]) {
  return {
    model: { complete: scriptedModel(rounds) },
    modelClock: () => createRunModelClock(60_000),
    prompt: { current: async () => ({ version: 'synthetic-v1', system: '合成系统前缀' }) },
    review: { review: async () => 'pass' as const },
  } satisfies Partial<AgentRunBodyDeps>;
}

export function proceedOf(text: string): InputProceed {
  return {
    kind: 'proceed',
    modelText: text,
    placeholders: {},
    links: [],
    notices: [],
    untrustedInput: false,
    paramsRequested: false,
  };
}

/** Lets the message through unchanged (no links, no notices). */
export function passCheck(): InputCheckPort {
  return { check: async (value) => proceedOf(value.text) };
}

/**
 * A run context like the RunManager's: each card is numbered from the session sequence (frame
 * first, then its embedded products), written, then confirmed through `delivered`. `drop` decides
 * a card is never written: the run is cancelled at that point (no frame, no receipt).
 */
export function receiptContext(options: {
  readonly runId: string;
  readonly sessionId: string;
  readonly firstNo?: number;
  readonly drop?: (card: UnnumberedCard) => boolean;
}) {
  const controller = new AbortController();
  const frames: CardFrame[] = [];
  const texts: string[] = [];
  let next = options.firstNo ?? 1;
  const ctx: RunContext = {
    runId: options.runId,
    sessionId: options.sessionId,
    signal: controller.signal,
    get cardsDelivered() {
      return frames.filter((frame) => frame.type !== 'notice').length;
    },
    text: (delta) => {
      if (!controller.signal.aborted) texts.push(delta);
    },
    toolStatus: () => undefined,
    suggestions: () => undefined,
    card: async (card, delivered) => {
      if (controller.signal.aborted) return;
      if (options.drop?.(card) === true) {
        controller.abort('cancelled');
        return;
      }
      const numbered = numberCard(card, next);
      next += numbered.used;
      frames.push(numbered.card);
      delivered?.(numbered.card.card_id);
    },
  };
  return { ctx, controller, frames, texts };
}

/** Product cards of the written product_list frames: result set, own card_id and the product. */
export function deliveredProducts(frames: readonly CardFrame[]) {
  const out: {
    resultSetId: string;
    card_id: string;
    product_key: string;
    platform: string;
    final_price_fen: number;
  }[] = [];
  for (const frame of frames) {
    if (frame.type !== 'product_list') continue;
    const data = frame.data as Row;
    const items = data['items'] as Row[];
    for (const item of items) {
      out.push({
        resultSetId: data['result_set_id'] as string,
        card_id: item['card_id'] as string,
        product_key: item['product_key'] as string,
        platform: item['platform'] as string,
        final_price_fen: item['final_price_fen'] as number,
      });
    }
  }
  return out;
}

/** Every recordDelivered call flattened in call order (one row per recorded product). */
export function receipts(recorded: ReturnType<typeof vi.fn<RecordDelivered>>) {
  return recorded.mock.calls.flatMap(([resultSetId, items]) =>
    items.map((item) => ({
      resultSetId,
      card_id: item.card_id,
      product_key: item.product_key,
      platform: item.platform,
      final_price_fen: item.final_price_fen,
    })),
  );
}

/** A product_list of the B3-05b kit under `resultSetId`, one product per key (taobao, 10 yuan). */
export function list(resultSetId: string, keys: readonly string[]): UnnumberedCard {
  const base = productList(keys.length);
  const items = (base.data['items'] as Row[]).map((item, index) => ({
    ...item,
    product_key: keys[index],
    link_id: `synthetic-link-${keys[index] ?? String(index)}`,
  }));
  return { ...base, data: { ...base.data, result_set_id: resultSetId, items } };
}

export function noticeCard(text = '合成提示'): UnnumberedCard {
  return {
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: 'agent.notice.relaxed_spec', actions: [] },
    fallback_text: text,
  };
}

/** One registered search_products tool answering `outcomes` in order. */
export function searchTools(
  outcomes: readonly ToolOutcome[],
  beforeAnswer?: (index: number) => Promise<void>,
) {
  let index = 0;
  const execute = vi.fn<OrchestratorTools['execute']>(async () => {
    const current = index;
    index += 1;
    await beforeAnswer?.(current);
    return outcomes[current] ?? { kind: 'ok', modelView: { items: [] }, cards: [] };
  });
  const tools: OrchestratorTools = {
    definitions: async () => [
      {
        name: 'search_products',
        description: '合成搜索工具',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string' } },
          additionalProperties: false,
        },
      },
    ],
    execute,
    enabledSearchPlatforms: async () => [],
    searchKeyword: async () => ({ results: [], cards: [] }),
  };
  return { tools, execute };
}

/** A complete synthetic body (B3-05b defaults from 02 §9.1–9.2) on the model path. */
export function syntheticBody(
  tools: OrchestratorTools,
  rounds: readonly Round[],
  patch: Partial<AgentRunBodyDeps> = {},
): AgentRunBodyDeps {
  return {
    ...modelPath(rounds),
    tools,
    inputCheck: passCheck(),
    degraded: { run: async () => ({ kind: 'done', finishReason: 'fallback' }) },
    texts: {
      text: async (_appId, key) => `固定文案:${key}`,
      toolDisplay: async () => '合成工具状态',
    },
    limits: {
      toolCalls: 4,
      modelRounds: 3,
      textCodePoints: 20_000,
      cards: 12,
      contentFrames: 400,
    },
    traceMask: (args) => args,
    ...patch,
  };
}

/** input() of the B3-05b kit for another app (everything else unchanged). */
export function inputFor(appId: string, text = '合成保温杯'): RunBodyInput {
  const base = input();
  return { ...base, caller: { ...base.caller, appId }, text };
}

/**
 * BR-AI-18 probe: the input review of `appId` (its review request hangs) must still be running
 * at budget − 1 ms and be refused as review unavailable at exactly `budgetMs` after the check
 * started (relative to the manual clock). Never awaits a check that does not settle.
 */
export async function expectInputBudget(
  check: InputCheckPort,
  wire: { readonly calls: readonly unknown[] },
  time: ManualTime,
  appId: string,
  budgetMs: number,
): Promise<void> {
  const before = wire.calls.length;
  const start = time.t;
  let result: unknown;
  void check.check(inputFor(appId), new AbortController().signal).then(
    (value) => {
      result = value;
    },
    (error: unknown) => {
      result = error;
    },
  );
  await until(`input review request of ${appId}`, () => wire.calls.length > before);
  await flush();
  await time.to(start + budgetMs - 1);
  expect(result, `${appId}: input review still running at ${String(budgetMs - 1)} ms`).toBe(
    undefined,
  );
  await time.to(start + budgetMs);
  await flush();
  expect(result, `${appId}: refused at ${String(budgetMs)} ms`).toEqual(UNAVAILABLE);
}
