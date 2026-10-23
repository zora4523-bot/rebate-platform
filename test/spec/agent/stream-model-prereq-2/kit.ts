// B3-03p rule-test kit (no database). Receipts on the degraded / follow-up / deterministic paths
// and inside rebate_quote cards (BR-AI-05), and the per-app output review budget that shares one
// deadline with its configuration read (BR-AI-18). Only the existing kits are imported, unchanged
// (stream-model-prereq, stream-review); everything here is synthetic.
import { expect, vi } from 'vitest';
import type { RunBodyInput } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type { SentenceReviewPort } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import type {
  OrchestratorLimits,
  OrchestratorTools,
} from '../../../../apps/api/src/modules/agent/orchestrator/core/ports.ts';
import type {
  DeliveredProduct,
  ResultSetStore,
} from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import type {
  StreamReviewConfigReader,
  StreamReviewDeps,
  StreamReviewOptions,
} from '../../../../apps/api/src/modules/agent/stream/mount/review.ts';
import type { UnnumberedCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import type { ToolCallContext } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import { list, TIMEOUT_KEY, type Row } from '../stream-model-prereq/kit.ts';
import { fixture as reviewFixture, flush, type Answer } from '../stream-review/kit.ts';

export { flush };

export const APP_A = 'synthetic-app-a';
export const APP_B = 'synthetic-app-b';

/** Fixed server copy by key (the B3-05b kit's convention). */
export const TEXTS = {
  text: async (_appId: string, key: string) => `固定文案:${key}`,
};

/** The same copy with tool.status templates (deterministic path). */
export const RUN_TEXTS = {
  ...TEXTS,
  toolDisplay: async () => '合成工具状态',
};

/** B3-05b defaults (02 §9.1–9.2), as syntheticBody uses them. */
export const LIMITS: OrchestratorLimits = {
  toolCalls: 4,
  modelRounds: 3,
  textCodePoints: 20_000,
  cards: 12,
  contentFrames: 400,
};

/** A product_list under `resultSetId`: one taobao product per [product_key, final price]. */
export function pricedList(
  resultSetId: string,
  products: readonly (readonly [string, number])[],
): UnnumberedCard {
  const base = list(resultSetId, products.map(([key]) => key));
  const items = (base.data['items'] as Row[]).map((item, index) => {
    const price = products[index]?.[1] ?? 1000;
    return { ...item, price_fen: price, final_price_fen: price };
  });
  return { ...base, data: { ...base.data, items } };
}

/** A rebate_quote card whose embedded product (04 §8.3 `product`) is `productKey`. */
export function quoteCard(productKey: string, finalPriceFen: number): UnnumberedCard {
  const items = pricedList('synthetic-quote-source', [[productKey, finalPriceFen]]).data[
    'items'
  ] as Row[];
  return {
    type: 'rebate_quote',
    schema_version: 1,
    data: { product: { ...(items[0] ?? {}) }, material: null, tlj_kind: 'unknown' },
    fallback_text: '合成报价卡',
  };
}

/** A delivered product of an earlier round (seeded straight into a store). */
export function deliveredOf(
  cardId: string,
  productKey: string,
  finalPriceFen: number,
): DeliveredProduct {
  return {
    card_id: cardId,
    product_key: productKey,
    platform: 'taobao',
    final_price_fen: finalPriceFen,
    card: pricedList('synthetic-seed', [[productKey, finalPriceFen]]),
  };
}

/** An earlier round of the same session: its result set and the products it delivered. */
export async function seed(
  store: ResultSetStore,
  input: RunBodyInput,
  id: string,
  items: readonly DeliveredProduct[],
): Promise<void> {
  await store.save({
    id,
    appId: input.caller.appId,
    sessionId: input.sessionId,
    runId: 'synthetic-earlier-run',
    conditions: { q: '合成保温杯', chain_id: 'synthetic-chain' },
  });
  await store.recordDelivered(id, items);
}

/** The next round's tool context in the same app and session (reference lookups). */
export function lookupContext(input: RunBodyInput, sessionId = input.sessionId): ToolCallContext {
  return {
    appId: input.caller.appId,
    userId: input.caller.userId,
    deviceId: input.caller.deviceId,
    phoneBound: input.caller.phoneBound,
    runId: 'synthetic-next-run',
    sessionId,
    signal: new AbortController().signal,
    placeholders: {},
  };
}

/**
 * Tools whose keyword search (the no-model degraded path) answers `cards` on taobao. Like the
 * results decorator does for a search, each product_list's conditions are saved in `store` under
 * its result_set_id before the cards are handed back.
 */
export function keywordTools(
  store: Pick<ResultSetStore, 'save'>,
  cards: readonly UnnumberedCard[],
) {
  const searchKeyword = vi.fn<OrchestratorTools['searchKeyword']>(async (plan, ctx) => {
    for (const card of cards) {
      const id = card.data['result_set_id'];
      if (card.type !== 'product_list' || typeof id !== 'string') continue;
      await store.save({
        id,
        appId: ctx.subject.appId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        conditions: { q: plan.q, chain_id: 'synthetic-degraded-chain' },
      });
    }
    const items = cards.flatMap((card) =>
      card.type === 'product_list' ? (card.data['items'] as unknown[]) : [],
    );
    return { results: [{ platform: 'taobao', ok: true, items }], cards };
  });
  const tools: OrchestratorTools = {
    definitions: async () => [],
    execute: async () => ({ kind: 'rejected', modelView: { error: 'invalid_args' } }),
    enabledSearchPlatforms: async () => ['taobao'],
    searchKeyword,
  };
  return { tools, searchKeyword };
}

/** Whether a promise settled, and how; never awaited by the probes (time is manual). */
export interface Box<T> {
  done: boolean;
  value: T | undefined;
  error: unknown;
}

export function track<T>(pending: Promise<T>): Box<T> {
  const box: Box<T> = { done: false, value: undefined, error: undefined };
  void pending.then(
    (value) => {
      box.done = true;
      box.value = value;
    },
    (error: unknown) => {
      box.done = true;
      box.error = error;
    },
  );
  return box;
}

/** Bounded polling on real time (work in flight that the manual clock does not drive). */
export async function waitFor(what: string, ready: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000; i += 1) {
    if (ready()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  expect.fail(`never happened: ${what}`);
}

/** How the synthetic configuration read answers: after `n` manual ms, rejecting, or never. */
export type ReadMode = number | 'reject' | 'hang';

/**
 * The stream review's dependencies (stream-review kit: staging, synthetic credentials and
 * transport, manual time) with a content configuration reader over `values` (app → value of
 * agent.safety.timeout_ms). `mode.read` may be changed between requests.
 */
export function reviewRig(options: {
  readonly values: Readonly<Record<string, unknown>>;
  readonly read?: ReadMode;
  readonly answers?: readonly Answer[];
  readonly patch?: Partial<StreamReviewOptions>;
}) {
  const f = reviewFixture(options.answers ?? ['hang'], options.patch ?? {});
  const table = new Map<string, unknown>(Object.entries(options.values));
  const mode: { read: ReadMode } = { read: options.read ?? 0 };
  const configValue = vi.fn<StreamReviewConfigReader['configValue']>(async (appId, key) => {
    const read = mode.read;
    if (read === 'reject') throw new Error('synthetic configuration store unavailable');
    if (read === 'hang') return new Promise<never>(() => {});
    if (read > 0) await f.time.sleep(read);
    return key === TIMEOUT_KEY && table.has(appId) ? { value: table.get(appId) } : null;
  });
  const deps: StreamReviewDeps = {
    options: f.options,
    clock: f.time.clock,
    scheduler: f.time.scheduler,
    logger: f.logs.logger,
    texts: f.texts,
    config: { configValue },
  };
  return { ...f, table, mode, configValue, deps };
}

export type ReviewRig = ReturnType<typeof reviewRig>;

/**
 * BR-AI-18 output probe: a sentence review started now (the request hangs) is still running at
 * budget − 1 ms and answers 'timeout' at exactly `budgetMs` after it started (manual clock).
 */
export async function expectReviewBudget(
  port: SentenceReviewPort,
  time: ReviewRig['time'],
  budgetMs: number,
  label: string,
): Promise<void> {
  const start = time.t;
  const box = track(port.review('合成说明。'));
  await time.to(start + budgetMs - 1);
  expect(box.done, `${label}: still under review at ${String(budgetMs - 1)} ms`).toBe(false);
  await time.to(start + budgetMs);
  await flush();
  expect(box, `${label}: timeout at ${String(budgetMs)} ms`).toEqual({
    done: true,
    value: 'timeout',
    error: undefined,
  });
}
