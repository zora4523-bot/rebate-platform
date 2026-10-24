// B3-03q §9 item 5 · BR-AI-05 / BR-AI-14: the no-model keyword search's result set becomes the
// session's current chain only once one of its product_list cards was confirmed as written. A batch
// that never went out (cancelled, cut by the card limit, or a write without a receipt) leaves the
// current chain as it was (or still none), so 「换一批」 and 「第 N 个」 keep addressing the batch the
// user saw last; a written batch switches the chain and 「换一批」 continues from it. Real stream
// runtime + PG through the shared kits; the assembly's own tools, intent port and result store
// (PG injected, or its in-memory fallback); synthetic DTOs only.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { InputCheckPort } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  createReferenceResolver,
  type ResultSetStore,
} from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import { createPgResultSetStore } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import { createAgentStreamAssembly } from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import type { UnnumberedCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import {
  framesOf,
  message,
  openSession,
  send,
  setConfig,
  usePgEach,
  type Row,
} from '../stream-mount/kit.ts';
import { APP, TOKEN, fixture, output, passInput, request } from '../stream-assembly/kit.ts';
import { deliveredProducts, noticeCard, receiptContext } from '../stream-model-prereq/kit.ts';
import { chainOf, listItemsOf, lookupOf, rowAs, unconfirmedContext } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

/** How a degraded batch fails to go out. */
type Unseen = 'cancel' | 'limit' | 'unconfirmed';

/** The same input check with one input notice (it goes out before the degraded batch). */
const withNotice: InputCheckPort = {
  async check(value, signal) {
    const checked = await passInput.check(value, signal);
    return checked.kind === 'proceed' ? { ...checked, notices: [noticeCard()] } : checked;
  },
};

/** The stream runtime over the business assembly (PG result store, or the in-memory fallback). */
async function rig(kind: 'pg' | 'memory') {
  const f = await fixture(pg.db);
  const body = vi.spyOn(core, 'createAgentRunBody');
  const assembly = createAgentStreamAssembly(
    kind === 'pg' ? { ...f.deps, results: createPgResultSetStore({ db: pg.db }) } : f.deps,
  );
  const r = f.mount(assembly);
  expect(body).toHaveBeenCalledTimes(1);
  const deps = body.mock.calls[0]![0];
  const store: ResultSetStore = assembly.results;
  return { f, r, deps, store, base: f.state.row };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** One message on the no_model route that the user sees: one product_list, run ends fallback. */
async function seenBatch(x: Rig, sessionId: string, text: string): Promise<Row[]> {
  const frames = framesOf((await send(x.r, x.f.caller, sessionId, message(text))).chunks);
  expect(frames.at(-1)?.data['finish_reason']).toBe('fallback');
  const items = listItemsOf(frames);
  expect(items.length).toBeGreaterThan(0);
  return items;
}

/** The runs of the session so far (a receipt and a result set belong to a real run). */
async function runIds(sessionId: string): Promise<string[]> {
  const rows = await pg.db
    .selectFrom('agent_runs')
    .select('id')
    .where('session_id', '=', sessionId)
    .execute();
  return rows.map((row) => row.id);
}

/**
 * A degraded keyword search of `text` whose product_list never goes out, run by the body the
 * runtime built (its degraded path, tools and receipts): cancelled when the list is about to be
 * written, cut by the card limit after an input notice went out, or handed over without a receipt.
 */
async function unseenBatch(
  x: Rig,
  sessionId: string,
  runId: string,
  text: string,
  mode: Unseen,
): Promise<void> {
  const ctx = { ...x.f.context(sessionId), runId };
  const input = request(ctx, text).input;
  const searches = x.f.searchProducts.mock.calls.length;
  if (mode === 'unconfirmed') {
    const out = unconfirmedContext({ runId, sessionId, firstNo: 301 });
    await core.createAgentRunBody({ ...x.deps, inputCheck: passInput })(input)(out.ctx);
    expect(out.frames.map((frame) => frame.type)).toContain('product_list');
  } else {
    const out = receiptContext({
      runId,
      sessionId,
      firstNo: 301,
      ...(mode === 'cancel'
        ? { drop: (card: UnnumberedCard) => card.type === 'product_list' }
        : {}),
    });
    // 1 (input notice) + 2 (list frame and its product) > 2: the list is cut, never split.
    const patch =
      mode === 'limit'
        ? { inputCheck: withNotice, limits: { ...x.deps.limits, cards: 2 } }
        : { inputCheck: passInput };
    const result = await core.createAgentRunBody({ ...x.deps, ...patch })(input)(out.ctx);
    expect(result).toEqual({ kind: 'done', finishReason: mode === 'limit' ? 'limit' : 'stop' });
    expect(deliveredProducts(out.frames)).toEqual([]);
    if (mode === 'limit') expect(out.frames.map((frame) => frame.type)).toEqual(['notice']);
  }
  // The batch was searched (the keyword search ran), it just never reached the user.
  expect(x.f.searchProducts.mock.calls.length).toBeGreaterThan(searches);
}

/** 「换一批」 through the assembly's intent port: the upstream queries it made (q, page). */
async function nextBatch(x: Rig, sessionId: string, runId: string) {
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
  return {
    searched: x.f.searchProducts.mock.calls
      .slice(before)
      .map(([query, , page]) => ({ q: query.q, page })),
    cards: out.cards,
  };
}

async function ordinal(x: Rig, sessionId: string, n: number) {
  const resolver = createReferenceResolver({ store: x.store });
  return resolver.resolve({ ref_ordinal: n }, lookupOf(APP, sessionId, x.f.caller));
}

it.each([
  ['cancel', 'pg'],
  ['limit', 'pg'],
  ['unconfirmed', 'pg'],
  ['cancel', 'memory'],
] as const)(
  '[AC-B3-03q#5][BR-AI-05][BR-AI-14] 降级搜索这批卡没写出（%s，结果库 %s）：currentChain 保持用户上一批的链，「换一批」与「第 N 个」仍指向上一批；之后写出的一批才切为当前链，「换一批」从它续翻',
  async (mode, kind) => {
    const x = await rig(kind);
    try {
      const sessionId = await openSession(x.r, x.f.caller);
      // Batch 1, seen by the user.
      const seen = await seenBatch(x, sessionId, '合成保温杯');
      const before = await chainOf(x.store, APP, sessionId);
      expect(before).toMatchObject({ status: 'has_products', conditions: { q: '合成保温杯' } });
      const runs = await runIds(sessionId);
      expect(runs).toHaveLength(1);

      // Batch 2 (another product), searched but never written.
      x.f.state.row = rowAs(x.base, 'synthetic-mug', '合成水杯 400ml');
      await unseenBatch(x, sessionId, runs[0]!, '合成水杯', mode);
      expect(await chainOf(x.store, APP, sessionId), 'current chain unchanged').toEqual(before);
      expect(await ordinal(x, sessionId, 1)).toEqual({
        kind: 'product',
        productKey: seen[0]!['product_key'],
      });
      expect(await ordinal(x, sessionId, seen.length + 1)).toEqual({ kind: 'clarify' });
      const again = await nextBatch(x, sessionId, runs[0]!);
      expect(again.searched).toEqual([{ q: '合成保温杯', page: 2 }]);

      // Batch 3, written: now it is the current chain and 「换一批」 continues from it.
      x.f.state.row = rowAs(x.base, 'synthetic-tea', '合成茶杯');
      const shown = await seenBatch(x, sessionId, '合成茶杯');
      const after = await chainOf(x.store, APP, sessionId);
      expect(after).toMatchObject({ status: 'has_products', conditions: { q: '合成茶杯' } });
      expect(after?.chainId).not.toBe(before?.chainId);
      expect(await ordinal(x, sessionId, 1)).toEqual({
        kind: 'product',
        productKey: shown[0]!['product_key'],
      });
      const next = await nextBatch(x, sessionId, runs[0]!);
      expect(next.searched).toEqual([{ q: '合成茶杯', page: 2 }]);
    } finally {
      await x.r.runtime.close();
    }
  },
  180_000,
);

it.each(['cancel', 'limit', 'unconfirmed'] as const)(
  '[AC-B3-03q#5][BR-AI-05][BR-AI-14] 会话原来没有当前链、降级搜索这批卡没写出（%s）：currentChain 仍为空，「换一批」不检索，「第 N 个」无可指；写出一批后才有当前链',
  async (mode) => {
    const x = await rig('pg');
    try {
      const sessionId = await openSession(x.r, x.f.caller);
      // A real run of the session that searches nothing (token path, parsing off).
      await setConfig(pg.db, APP, 'parse.tpwd.enabled', false);
      const first = framesOf((await send(x.r, x.f.caller, sessionId, message(TOKEN))).chunks);
      expect(first.at(-1)?.data['finish_reason']).toBe('stop');
      const runs = await runIds(sessionId);
      expect(runs).toHaveLength(1);
      expect(await chainOf(x.store, APP, sessionId)).toBeNull();

      await unseenBatch(x, sessionId, runs[0]!, '合成水杯', mode);
      expect(await chainOf(x.store, APP, sessionId), 'still no current chain').toBeNull();
      expect(await x.store.latestWithProducts(APP, sessionId)).toBeNull();
      expect(await ordinal(x, sessionId, 1)).toEqual({ kind: 'clarify' });
      const again = await nextBatch(x, sessionId, runs[0]!);
      expect(again.searched, '换一批 has nothing to continue').toEqual([]);
      expect(again.cards.map((card) => card.type)).toEqual(['notice']);

      const shown = await seenBatch(x, sessionId, '合成保温杯');
      expect(await chainOf(x.store, APP, sessionId)).toMatchObject({
        status: 'has_products',
        conditions: { q: '合成保温杯' },
      });
      expect(await ordinal(x, sessionId, 1)).toEqual({
        kind: 'product',
        productKey: shown[0]!['product_key'],
      });
      const next = await nextBatch(x, sessionId, runs[0]!);
      expect(next.searched).toEqual([{ q: '合成保温杯', page: 2 }]);
    } finally {
      await x.r.runtime.close();
    }
  },
  180_000,
);
