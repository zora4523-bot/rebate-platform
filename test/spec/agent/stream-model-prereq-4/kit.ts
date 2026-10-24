// B3-03r rule-test kit. The last current-chain gap before the model path is switched on (BR-AI-05):
// the results decorator of the model tool call search_products and of the server's follow-ups
// (换一批 / 再便宜点 / 换平台 / a price answer) must make a batch's chain the session's current chain
// only once one of its product_list cards was confirmed as written (the delivery receipt), as the
// degraded keyword search does since B3-03q. Everything runs through the production assembly (its
// tools, intent port and receipt store) and the core body the stream runtime built; the model is
// scripted, the union is the fixture's synthetic search port. Existing kits are imported unchanged;
// every value here is synthetic.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type {
  AgentRunBodyDeps,
  InputCheckPort,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  createReferenceResolver,
  type ResultSetStore,
  type SessionChain,
} from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import { createPgResultSetStore } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import { createAgentStreamAssembly } from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import {
  numberCard,
  type RunContext,
  type UnnumberedCard,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import type { AgentSearchCandidate } from '../../../../apps/api/src/modules/agent/tools/search/index.ts';
import { framesOf, message, openSession, send, setConfig } from '../stream-mount/kit.ts';
import { APP, TOKEN, fixture, output, passInput, request } from '../stream-assembly/kit.ts';
import {
  deliveredProducts,
  modelPath,
  noticeCard,
  type CardFrame,
  type Round,
  type Row,
} from '../stream-model-prereq/kit.ts';
import { chainOf, lookupOf, rowAs } from '../stream-model-prereq-3/kit.ts';

export { APP, chainOf, deliveredProducts, rowAs };
export type { CardFrame, Row, SessionChain };

type Complete = AgentRunBodyDeps['model']['complete'];

/** What happens to one product_list card when the run hands it to the run context. */
export type Fate =
  /** written, then confirmed (the `delivered` receipt) */
  | 'write'
  /** the run is cancelled when the list is about to be written: no frame, no receipt */
  | 'cancel'
  /** written but the sink never confirms it: no receipt (02 §9.2: counts as not written) */
  | 'unconfirmed';

/** The same input check with one input notice (it goes out before anything else). */
export const withNotice: InputCheckPort = {
  async check(value, signal) {
    const checked = await passInput.check(value, signal);
    return checked.kind === 'proceed' ? { ...checked, notices: [noticeCard()] } : checked;
  },
};

/** The stream runtime over the business assembly (PG result store, or the in-memory fallback). */
export async function rig(db: Kysely<DB>, kind: 'pg' | 'memory') {
  const f = await fixture(db);
  const body = vi.spyOn(core, 'createAgentRunBody');
  const assembly = createAgentStreamAssembly(
    kind === 'pg' ? { ...f.deps, results: createPgResultSetStore({ db }) } : f.deps,
  );
  const r = f.mount(assembly);
  expect(body).toHaveBeenCalledTimes(1);
  const deps = body.mock.calls[0]![0];
  const store: ResultSetStore = assembly.results;
  return { db, f, r, deps, store, base: f.state.row };
}

export type Rig = Awaited<ReturnType<typeof rig>>;

/** The runs of the session so far (a receipt and a result set belong to a real run). */
export async function runIds(db: Kysely<DB>, sessionId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('agent_runs')
    .select('id')
    .where('session_id', '=', sessionId)
    .execute();
  return rows.map((row) => row.id);
}

/**
 * A session with one real run that searched nothing (token path, parsing off) for the result sets
 * and receipts to belong to; it has no current chain yet.
 */
export async function opened(x: Rig): Promise<{ sessionId: string; runId: string }> {
  const sessionId = await openSession(x.r, x.f.caller);
  await setConfig(x.db, APP, 'parse.tpwd.enabled', false);
  const first = framesOf((await send(x.r, x.f.caller, sessionId, message(TOKEN))).chunks);
  expect(first.at(-1)?.data['finish_reason']).toBe('stop');
  const runs = await runIds(x.db, sessionId);
  expect(runs).toHaveLength(1);
  expect(await chainOf(x.store, APP, sessionId), 'no current chain yet').toBeNull();
  return { sessionId, runId: runs[0]! };
}

/** The fixture's search row at another final price (coupon 20 yuan, same product otherwise). */
export function pricedRow(row: AgentSearchCandidate, finalPriceFen: bigint): AgentSearchCandidate {
  return {
    ...row,
    item: {
      ...row.item,
      price_fen: finalPriceFen + 2000n,
      coupon_fen: 2000n,
      final_price_fen: finalPriceFen,
    },
  };
}

/** Model rounds: one round asking for these search_products calls, then a short final text. */
export function searchRounds(...calls: readonly Row[]): Round[] {
  return [{ calls: calls.map((args) => ({ name: 'search_products', args })) }, { text: '好的。' }];
}

/** Model rounds: the final text is a refine intent (the core hands it to the intent port). */
export function refineRounds(conditions: Row): Round[] {
  return [{ text: JSON.stringify({ agent_intent: 'refine', conditions }) }];
}

/**
 * A run context like the RunManager's: each card is numbered from `firstNo` (frame first, then
 * its embedded products) and written; `fate` decides per product_list (index among the lists the
 * run handed over) whether it is confirmed, never confirmed, or cancels the run before it is
 * written. `beforeReceipt` runs for each written product_list after its frame went out and before
 * the receipt is given back (the core records the receipt only after that).
 */
export function batchContext(options: {
  readonly runId: string;
  readonly sessionId: string;
  readonly firstNo: number;
  readonly fate?: (card: UnnumberedCard, listIndex: number) => Fate;
  readonly beforeReceipt?: (card: UnnumberedCard) => Promise<void>;
}) {
  const controller = new AbortController();
  const frames: CardFrame[] = [];
  let next = options.firstNo;
  let lists = 0;
  let confirmed = 0;
  const ctx: RunContext = {
    runId: options.runId,
    sessionId: options.sessionId,
    signal: controller.signal,
    get cardsDelivered() {
      return confirmed;
    },
    text: () => undefined,
    toolStatus: () => undefined,
    suggestions: () => undefined,
    card: async (card, delivered) => {
      if (controller.signal.aborted) return;
      const isList = card.type === 'product_list';
      const fate: Fate = isList ? (options.fate?.(card, lists) ?? 'write') : 'write';
      if (isList) lists += 1;
      if (fate === 'cancel') {
        controller.abort('cancelled');
        return;
      }
      const numbered = numberCard(card, next);
      next += numbered.used;
      frames.push(numbered.card);
      if (isList && options.beforeReceipt !== undefined) await options.beforeReceipt(card);
      if (fate === 'write') {
        if (card.type !== 'notice') confirmed += 1;
        delivered?.(numbered.card.card_id);
      }
    },
  };
  return { ctx, controller, frames };
}

/** One run of the core body the runtime built, on the model path (scripted model). */
export interface BodyRun {
  readonly sessionId: string;
  readonly runId: string;
  /** The user's message of this run. */
  readonly text: string;
  readonly rounds: readonly Round[];
  readonly firstNo: number;
  readonly fate?: (card: UnnumberedCard, listIndex: number) => Fate;
  readonly beforeReceipt?: (card: UnnumberedCard) => Promise<void>;
  /** The run's card limit (B3-05b limits.cards). */
  readonly cards?: number;
  /** One input notice goes out first. */
  readonly inputNotice?: boolean;
  /** The user stops the run when the model is asked for this round (1-based). */
  readonly stopAtRound?: number;
}

export async function runBody(x: Rig, run: BodyRun) {
  const ctx = { ...x.f.context(run.sessionId), runId: run.runId };
  const out = batchContext({
    runId: run.runId,
    sessionId: run.sessionId,
    firstNo: run.firstNo,
    ...(run.fate === undefined ? {} : { fate: run.fate }),
    ...(run.beforeReceipt === undefined ? {} : { beforeReceipt: run.beforeReceipt }),
  });
  const path = modelPath(run.rounds);
  let asked = 0;
  const complete = vi.fn<Complete>(async (...args) => {
    asked += 1;
    if (asked === run.stopAtRound) out.controller.abort('cancelled');
    return path.model.complete(...args);
  });
  const searches = x.f.searchProducts.mock.calls.length;
  const result = await core.createAgentRunBody({
    ...x.deps,
    ...path,
    model: { complete },
    inputCheck: run.inputNotice === true ? withNotice : passInput,
    ...(run.cards === undefined ? {} : { limits: { ...x.deps.limits, cards: run.cards } }),
  })(request(ctx, run.text).input)(out.ctx);
  return {
    result,
    frames: out.frames,
    /** The upstream queries of this run (q, page). */
    searched: searchedSince(x, searches),
  };
}

export const STOP = { kind: 'done', finishReason: 'stop' } as const;

/** How a batch fails to reach the user. */
export type Unseen = 'cancel' | 'limit' | 'unconfirmed';

export interface At {
  readonly sessionId: string;
  readonly runId: string;
}

/** The parts of a run that keep its product_list from the user (`mode`). */
export function unseenBy(mode: Unseen): Pick<BodyRun, 'fate' | 'inputNotice' | 'cards'> {
  // 1 (input notice) + 2 (list frame and its product) > 2: the list is cut, never split.
  if (mode === 'limit') return { inputNotice: true, cards: 2 };
  const fate: Fate = mode;
  return { fate: () => fate };
}

/** What the user got from a run whose product_list never reached them (`mode`). */
export function expectUnseen(run: Awaited<ReturnType<typeof runBody>>, mode: Unseen): void {
  if (mode === 'unconfirmed') {
    expect(run.result.kind).toBe('done');
    expect(run.frames.map((frame) => frame.type)).toContain('product_list');
    return;
  }
  expect(run.result).toEqual({ kind: 'done', finishReason: mode === 'limit' ? 'limit' : 'stop' });
  expect(listKeys(run.frames)).toEqual([]);
  if (mode === 'limit') expect(run.frames.map((frame) => frame.type)).toEqual(['notice']);
}

/** The model searches `q` and the user sees the batch (written and confirmed): its keys. */
export async function seenSearch(x: Rig, at: At, q: string, firstNo: number): Promise<string[]> {
  const shown = await runBody(x, { ...at, text: q, rounds: searchRounds({ q }), firstNo });
  expect(shown.result).toEqual(STOP);
  const keys = listKeys(shown.frames);
  expect(keys).toHaveLength(1);
  expect(keys[0]!.length).toBeGreaterThan(0);
  return keys[0]!;
}

/** The upstream queries made since `from` calls (q and page). */
export function searchedSince(x: Rig, from: number) {
  return x.f.searchProducts.mock.calls.slice(from).map(([query, , page]) => ({ q: query.q, page }));
}

/** The product keys of each written product_list frame, in frame order. */
export function listKeys(frames: readonly CardFrame[]): string[][] {
  return frames
    .filter((frame) => frame.type === 'product_list')
    .map((frame) => (frame.data['items'] as Row[]).map((item) => item['product_key'] as string));
}

/** Records the session's current chain each time a product_list is about to be confirmed. */
export function chainProbe(x: Rig, sessionId: string) {
  const seen: (SessionChain | null)[] = [];
  return {
    seen,
    beforeReceipt: async () => {
      seen.push(await chainOf(x.store, APP, sessionId));
    },
  };
}

/** 「换一批」 through the assembly's intent port: the upstream queries it made (q, page). */
export async function nextBatch(x: Rig, sessionId: string, runId: string) {
  const ctx = { ...x.f.context(sessionId), runId };
  const out = output(ctx);
  const before = x.f.searchProducts.mock.calls.length;
  const intents = x.deps.intents;
  expect(intents, 'the runtime body has the intent port').toBeDefined();
  const result = await intents!.handle(
    {
      ...request(ctx, '换一批'),
      text: JSON.stringify({ agent_intent: 'refine', conditions: { next_batch: true } }),
    },
    out.run,
  );
  expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
  return { searched: searchedSince(x, before), cards: out.cards };
}

/** 「第 N 个」 of the next round, resolved by the production reference resolver over the store. */
export async function ordinal(x: Rig, sessionId: string, n: number) {
  const resolver = createReferenceResolver({ store: x.store });
  return resolver.resolve({ ref_ordinal: n }, lookupOf(APP, sessionId, x.f.caller));
}
