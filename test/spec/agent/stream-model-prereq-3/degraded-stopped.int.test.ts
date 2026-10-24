// B3-03q §9 item 5 / §10 S1 · BR-AI-05 / BR-AI-14: a degraded keyword search whose product_list was
// written and confirmed (the user saw it) and whose run the user then stopped before the closing
// text (the degraded path returns stopped) still switches the session's current chain to this
// batch: 「换一批」 continues from it and 「第 N 个」 addresses it. A later batch that never went out
// does not displace it. Kills "switch only when the run ends normally / all cards went out". Real
// stream runtime + PG through the shared kits; the assembly's own tools, intent port and result
// store (PG injected, or its in-memory fallback); synthetic DTOs only.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  createReferenceResolver,
  type ResultSetStore,
} from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import { createPgResultSetStore } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import { createAgentStreamAssembly } from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import type {
  RunContext,
  UnnumberedCard,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { framesOf, message, openSession, send, usePgEach, type Row } from '../stream-mount/kit.ts';
import { APP, fixture, output, passInput, request } from '../stream-assembly/kit.ts';
import { deliveredProducts, receiptContext } from '../stream-model-prereq/kit.ts';
import { chainOf, listItemsOf, lookupOf, rowAs } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

/** The run the next text fetch stops (armed once a product_list frame was written). */
interface StopGate {
  armed: AbortController | null;
}

/**
 * The stream runtime over the business assembly (PG result store, or the in-memory fallback). Its
 * texts stop the armed run at the next text fetch: on the degraded path that is the closing text,
 * fetched after every card went out and before it is written.
 */
async function rig(kind: 'pg' | 'memory') {
  const f = await fixture(pg.db);
  const gate: StopGate = { armed: null };
  const texts = {
    ...f.deps.texts,
    text: async (appId: string, key: string) => {
      const armed = gate.armed;
      gate.armed = null;
      armed?.abort('cancelled');
      return f.deps.texts.text(appId, key);
    },
  };
  const body = vi.spyOn(core, 'createAgentRunBody');
  const assembly = createAgentStreamAssembly({
    ...f.deps,
    texts,
    ...(kind === 'pg' ? { results: createPgResultSetStore({ db: pg.db }) } : {}),
  });
  const r = f.mount(assembly);
  expect(body).toHaveBeenCalledTimes(1);
  const deps = body.mock.calls[0]![0];
  const store: ResultSetStore = assembly.results;
  return { f, r, deps, store, gate, base: f.state.row };
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

async function runIds(sessionId: string): Promise<string[]> {
  const rows = await pg.db
    .selectFrom('agent_runs')
    .select('id')
    .where('session_id', '=', sessionId)
    .execute();
  return rows.map((row) => row.id);
}

/**
 * A degraded keyword search of `text` run by the body the runtime built: its product_list is
 * written and confirmed, then the user stops the run before the closing text goes out (the
 * degraded path itself returns stopped). Returns the products the user saw.
 */
async function stoppedAfterList(x: Rig, sessionId: string, runId: string, text: string) {
  const ctx = { ...x.f.context(sessionId), runId };
  const input = request(ctx, text).input;
  const out = receiptContext({ runId, sessionId, firstNo: 301 });
  const run: RunContext = {
    runId,
    sessionId,
    signal: out.ctx.signal,
    get cardsDelivered() {
      return out.ctx.cardsDelivered;
    },
    text: (delta) => out.ctx.text(delta),
    toolStatus: (tool, phase, display) => out.ctx.toolStatus(tool, phase, display),
    suggestions: (items) => out.ctx.suggestions(items),
    card: async (card, delivered) => {
      await out.ctx.card(card, delivered);
      const written = out.frames.some((frame) => frame.type === 'product_list');
      if (card.type === 'product_list' && written && !out.controller.signal.aborted) {
        x.gate.armed = out.controller;
      }
    },
  };
  const searches = x.f.searchProducts.mock.calls.length;
  const degraded = vi.spyOn(x.deps.degraded, 'run');
  const result = await core.createAgentRunBody({ ...x.deps, inputCheck: passInput })(input)(run);
  expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(degraded).toHaveBeenCalledTimes(1);
  await expect(degraded.mock.results[0]!.value).resolves.toEqual({
    kind: 'done',
    finishReason: 'stop',
  });
  degraded.mockRestore();
  expect(out.controller.signal.aborted, 'the user stopped the run').toBe(true);
  expect(x.f.searchProducts.mock.calls.length).toBeGreaterThan(searches);
  // The list went out with its receipt; the closing text never did.
  expect(out.frames.map((frame) => frame.type)).toEqual(['product_list']);
  expect(out.texts).toEqual([]);
  const shown = deliveredProducts(out.frames);
  expect(shown.length).toBeGreaterThan(0);
  return shown;
}

/** A degraded keyword search of `text` whose product_list is cancelled before it is written. */
async function cancelledBatch(x: Rig, sessionId: string, runId: string, text: string) {
  const ctx = { ...x.f.context(sessionId), runId };
  const out = receiptContext({
    runId,
    sessionId,
    firstNo: 401,
    drop: (card: UnnumberedCard) => card.type === 'product_list',
  });
  const searches = x.f.searchProducts.mock.calls.length;
  const result = await core.createAgentRunBody({ ...x.deps, inputCheck: passInput })(
    request(ctx, text).input,
  )(out.ctx);
  expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
  expect(deliveredProducts(out.frames)).toEqual([]);
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
  return x.f.searchProducts.mock.calls.slice(before).map(([query, , page]) => ({
    q: query.q,
    page,
  }));
}

async function ordinal(x: Rig, sessionId: string, n: number) {
  const resolver = createReferenceResolver({ store: x.store });
  return resolver.resolve({ ref_ordinal: n }, lookupOf(APP, sessionId, x.f.caller));
}

it.each(['pg', 'memory'] as const)(
  '[AC-B3-03q#5][BR-AI-05][BR-AI-14] 降级搜索这批 product_list 已写出并确认、随后用户在收尾文字前停止本轮（结果库 %s）：currentChain 切到这批的新链，「换一批」按这批词翻第 2 页，「第 1 个」解析到这批第一件；之后没写出的一批不顶替它',
  async (kind) => {
    const x = await rig(kind);
    try {
      const sessionId = await openSession(x.r, x.f.caller);
      // Batch 1, seen by the user (run ends normally).
      const seen = await seenBatch(x, sessionId, '合成保温杯');
      const before = await chainOf(x.store, APP, sessionId);
      expect(before).toMatchObject({ status: 'has_products', conditions: { q: '合成保温杯' } });
      const runs = await runIds(sessionId);
      expect(runs).toHaveLength(1);

      // Batch 2 (another product): written and seen, then the user stops the run.
      x.f.state.row = rowAs(x.base, 'synthetic-mug', '合成水杯 400ml');
      const shown = await stoppedAfterList(x, sessionId, runs[0]!, '合成水杯');
      expect(shown[0]!.product_key).toBe('tb:synthetic-mug');
      expect(shown[0]!.product_key).not.toBe(seen[0]!['product_key']);
      const stopped = await chainOf(x.store, APP, sessionId);
      expect(stopped, 'the seen batch is the current chain').toMatchObject({
        status: 'has_products',
        conditions: { q: '合成水杯' },
      });
      expect(stopped?.chainId).not.toBe(before?.chainId);
      expect(await ordinal(x, sessionId, 1)).toEqual({
        kind: 'product',
        productKey: 'tb:synthetic-mug',
      });
      expect(await ordinal(x, sessionId, shown.length + 1)).toEqual({ kind: 'clarify' });

      // Batch 3, searched but cancelled before its list was written: batch 2 stays current.
      x.f.state.row = rowAs(x.base, 'synthetic-tea', '合成茶杯');
      await cancelledBatch(x, sessionId, runs[0]!, '合成茶杯');
      expect(await chainOf(x.store, APP, sessionId), 'current chain unchanged').toEqual(stopped);
      expect(await ordinal(x, sessionId, 1)).toEqual({
        kind: 'product',
        productKey: 'tb:synthetic-mug',
      });

      // 「换一批」 continues from the stopped-but-seen batch: its words, page 2.
      expect(await nextBatch(x, sessionId, runs[0]!)).toEqual([{ q: '合成水杯', page: 2 }]);
    } finally {
      await x.r.runtime.close();
    }
  },
  180_000,
);
