// B3-03q §9 items 3–4 · BR-AI-05 / BR-AI-04 on the stream mount: with the production business
// factory (createProductionStreamAssembly, whose one result store is the PG one) the product inside
// a rebate_quote card written on the deterministic link path is recorded, so the next round's
// get_rebate_quote by that card_id resolves to it (a fresh quote, not invalid_args) while 「第 N 个」
// still addresses product_list result sets only. A quote cancelled before it was written is not
// recorded; a failed record is only logged. Real runtime + PG through the shared kits; the demo
// union adapter and synthetic DTOs only (stream-assembly kit, unchanged).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  createReferenceResolver,
  type QuotedReceiptStore,
  type ResultSetStore,
} from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import { createPgResultSetStore } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import {
  createAgentStreamAssembly,
  createAgentStreamRuntime,
  createProductionStreamAssembly,
  type AgentStreamProvidedPorts,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import type { UnnumberedCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import {
  contentReaderFor,
  LEVEL,
  framesOf,
  message,
  openSession,
  send,
  setConfig,
  usePgEach,
  type Frame,
  type Row,
} from '../stream-mount/kit.ts';
import { APP, TOKEN, fixture, passInput, request } from '../stream-assembly/kit.ts';
import { callTool } from '../stream-assembly/regression-kit.ts';
import { receiptContext } from '../stream-model-prereq/kit.ts';
import { lookupOf, quotedPort } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * The stream runtime over the production business factory with the fixture's demo ports (the
 * fixture's link patterns know the demo host); the body the runtime built is returned too.
 */
function productionMount(f: Fixture) {
  const ports: AgentStreamProvidedPorts = {
    platforms: f.deps.ports.search.platforms,
    searchProducts: f.deps.ports.search.searchProducts,
    readProduct: f.deps.ports.readProduct,
    parsing: f.deps.ports.parsing,
    cards: f.deps.ports.cards,
  };
  const body = vi.spyOn(core, 'createAgentRunBody');
  const runtime = createAgentStreamRuntime(
    {
      db: pg.db,
      clock: f.time.clock,
      logger: f.logs.logger,
      contentReader: contentReaderFor(pg.db, f.time.clock),
      consentReader: f.consentReader,
      assembly: (context) => createProductionStreamAssembly({ ...context, ports }),
    },
    { inputCheck: passInput, schedule: f.time.scheduler },
  );
  expect(body).toHaveBeenCalledTimes(1);
  return { r: { runtime, time: f.time, logs: f.logs }, deps: body.mock.calls[0]![0] };
}

/** Product URLs of the demo adapter's own catalog (never an invented vendor recording). */
async function demoUrls(f: Fixture, count: number): Promise<string[]> {
  const sample = await f.demo.searchItems(
    { keyword: '演示商品' },
    { appId: APP, requestId: randomUUID(), purpose: 'online' },
  );
  expect(sample.items.length).toBeGreaterThanOrEqual(count);
  return sample.items.slice(0, count).map((item) => {
    expect(item.item_id).toBeTypeOf('string');
    return `https://demo.invalid/taobao/${encodeURIComponent(item.item_id!)}`;
  });
}

/** The one rebate_quote card of a streamed reply: its frame card_id and its embedded product. */
function quoteOf(frames: readonly Frame[]) {
  const cards = frames.filter((frame) => frame.event === 'card');
  expect(cards.map((frame) => frame.data['type'])).toEqual(['rebate_quote']);
  expect(frames.at(-1)?.data['finish_reason']).toBe('stop');
  const frameCardId = cards[0]!.data['card_id'] as string;
  const product = (cards[0]!.data['data'] as Row)['product'] as Row;
  expect(product['card_id']).toBeTypeOf('string');
  expect(product['card_id']).not.toBe(frameCardId);
  return { frameCardId, product, cardId: product['card_id'] as string };
}

async function runIds(sessionId: string): Promise<string[]> {
  const rows = await pg.db
    .selectFrom('agent_runs')
    .select('id')
    .where('session_id', '=', sessionId)
    .execute();
  return rows.map((row) => row.id);
}

it('[AC-B3-03q#4][BR-AI-05][BR-AI-04] 生产 stream 入口（生产业务装配、PG 结果库）经确定性链接路径写出报价卡后，下一轮按卡内商品的 card_id 报价解析到该商品并现查，不是 invalid_args；「第 N 个」不指向它', async () => {
  const f = await fixture(pg.db);
  const { r, deps } = productionMount(f);
  try {
    const sessionId = await openSession(r, f.caller);
    const [url] = await demoUrls(f, 1);
    const quote = quoteOf(framesOf((await send(r, f.caller, sessionId, message(url!))).chunks));
    const productKey = quote.product['product_key'] as string;
    expect(productKey).toBeTypeOf('string');

    // Recorded in the shared PG store under this app and session (any instance reads it).
    const store = createPgResultSetStore({ db: pg.db });
    const found = await store.findDelivered(APP, sessionId, quote.cardId);
    expect(found, 'the quoted product is recorded').not.toBeNull();
    expect(found).toMatchObject({
      card_id: quote.cardId,
      product_key: productKey,
      platform: 'taobao',
      final_price_fen: quote.product['final_price_fen'],
    });
    expect(await store.findDelivered(APP, sessionId, quote.frameCardId)).toBeNull();
    expect(await store.findDelivered('another-app', sessionId, quote.cardId)).toBeNull();
    expect(await store.latestWithProducts(APP, sessionId)).toBeNull();

    // The next round quotes it again by its card_id: resolved, read fresh through catalog.
    f.readProduct.mockClear();
    const outcome = await callTool(deps.tools, f.context(sessionId), 'get_rebate_quote', {
      card_id: quote.cardId,
    });
    expect(outcome.kind, JSON.stringify(outcome.modelView)).toBe('ok');
    expect(f.readProduct).toHaveBeenCalledWith(productKey, expect.anything());
    if (outcome.kind === 'ok') {
      expect(outcome.cards.map((card) => card.type)).toEqual(['rebate_quote']);
    }

    // 「第 N 个」 has no product_list to address; another session does not see the quote.
    const resolver = createReferenceResolver({ store });
    expect(await resolver.resolve({ ref_ordinal: 1 }, lookupOf(APP, sessionId, f.caller))).toEqual({
      kind: 'clarify',
    });
    expect(
      await resolver.resolve({ card_id: quote.cardId }, lookupOf(APP, randomUUID(), f.caller)),
    ).toEqual({ kind: 'invalid_args' });
  } finally {
    await r.runtime.close();
  }
}, 120_000);

it('[AC-B3-03q#4][BR-AI-05] 生产 stream 入口：同一轮两条链接，第二张报价卡写出前被取消——只记已写出的那张卡内商品，被取消、未写出的不记', async () => {
  const f = await fixture(pg.db);
  const { r, deps } = productionMount(f);
  try {
    const sessionId = await openSession(r, f.caller);
    // A real run of this session (token path, parsing off) for the receipts to belong to.
    await setConfig(pg.db, APP, 'parse.tpwd.enabled', false);
    const first = framesOf((await send(r, f.caller, sessionId, message(TOKEN))).chunks);
    expect(first.at(-1)?.data['finish_reason']).toBe('stop');
    const runs = await runIds(sessionId);
    expect(runs).toHaveLength(1);

    const [one, two] = await demoUrls(f, 2);
    const ctx = { ...f.context(sessionId), runId: runs[0]! };
    // Cancelled right after the first quote was written: nothing after it goes out.
    let quoteWritten = false;
    const out = receiptContext({
      runId: ctx.runId,
      sessionId,
      firstNo: 101,
      drop: (card: UnnumberedCard) => {
        if (quoteWritten) return true;
        if (card.type === 'rebate_quote') quoteWritten = true;
        return false;
      },
    });
    const result = await core.createAgentRunBody({ ...deps, inputCheck: passInput })(
      request(ctx, `${one!} ${two!}`).input,
    )(out.ctx);
    expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(out.frames.map((frame) => [frame.type, frame.card_id])).toEqual([
      ['rebate_quote', 'c101'],
    ]);
    const product = out.frames[0]!.data['product'] as Row;
    expect(product['card_id']).toBe('c102');

    const store = createPgResultSetStore({ db: pg.db });
    const found = await store.findDelivered(APP, sessionId, 'c102');
    expect(found, 'the written quote is recorded').not.toBeNull();
    expect(found).toMatchObject({
      card_id: 'c102',
      product_key: product['product_key'],
      platform: 'taobao',
      final_price_fen: product['final_price_fen'],
    });
    // The frame itself and the ids the cancelled card would have taken: nothing.
    for (const cardId of ['c101', 'c103', 'c104']) {
      expect(await store.findDelivered(APP, sessionId, cardId), cardId).toBeNull();
    }
    const resolver = createReferenceResolver({ store });
    const lookup = lookupOf(APP, sessionId, f.caller);
    expect(await resolver.resolve({ card_id: 'c102' }, lookup)).toEqual({
      kind: 'product',
      productKey: product['product_key'],
    });
    expect(await resolver.resolve({ card_id: 'c104' }, lookup)).toEqual({ kind: 'invalid_args' });
    expect(await resolver.resolve({ ref_ordinal: 1 }, lookup)).toEqual({ kind: 'clarify' });
  } finally {
    await r.runtime.close();
  }
}, 120_000);

it('[AC-B3-03q#3][BR-AI-05] PG 结果库记报价卡商品失败只打日志：本轮报价卡照常下发、正常结束；日志只有平铺字段，不含商品与价格', async () => {
  const f = await fixture(pg.db);
  // The PG store keeps quoted products; here its record fails (store unavailable).
  const store = quotedPort(createPgResultSetStore({ db: pg.db }));
  const recordQuoted = vi.fn<QuotedReceiptStore['recordQuoted']>(async () => {
    throw new Error('synthetic quote receipt store unavailable');
  });
  const failing: ResultSetStore & QuotedReceiptStore = { ...store, recordQuoted };
  const r = f.mount(createAgentStreamAssembly({ ...f.deps, results: failing }));
  try {
    const sessionId = await openSession(r, f.caller);
    const [url] = await demoUrls(f, 1);
    const quote = quoteOf(framesOf((await send(r, f.caller, sessionId, message(url!))).chunks));
    const runs = await runIds(sessionId);
    expect(runs).toHaveLength(1);

    expect(recordQuoted).toHaveBeenCalledTimes(1);
    const [scope, items] = recordQuoted.mock.calls[0]!;
    expect(scope).toEqual({ appId: APP, sessionId, runId: runs[0] });
    expect(items.map((item) => [item.card_id, item.product_key])).toEqual([
      [quote.cardId, quote.product['product_key']],
    ]);
    const lines = f.logs.of('agent_result_receipt_failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: LEVEL.warn, run_id: runs[0] });
    for (const field of ['card', 'items', 'product', 'product_key', 'final_price_fen']) {
      expect(lines[0], field).not.toHaveProperty(field);
    }
    // Nothing was kept: the card_id resolves as unknown, as before receipts existed.
    expect(await store.findDelivered(APP, sessionId, quote.cardId)).toBeNull();
  } finally {
    await r.runtime.close();
  }
}, 120_000);
