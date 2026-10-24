// B3-03q §9 item 4 / §10 S2 · BR-AI-05 / BR-AI-04 on the stream mount: a rebate_quote card the
// deterministic link path numbered and handed over without a write receipt (the sink write failed:
// no `delivered`) counts as not written, so the product inside it is not recorded — its card_id
// finds nothing and a later get_rebate_quote by it is invalid_args — while a quote card written
// with its receipt in a later round of the same session is recorded and resolves. Production
// business factory (createProductionStreamAssembly, PG result store) through the shared kits; the
// demo union adapter and synthetic DTOs only.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { createReferenceResolver } from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import { createPgResultSetStore } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import {
  createAgentStreamRuntime,
  createProductionStreamAssembly,
  type AgentStreamProvidedPorts,
} from '../../../../apps/api/src/modules/agent/stream/mount/index.ts';
import {
  framesOf,
  message,
  openSession,
  send,
  setConfig,
  usePgEach,
  type Row,
} from '../stream-mount/kit.ts';
import { APP, TOKEN, fixture, passInput, request } from '../stream-assembly/kit.ts';
import { callTool } from '../stream-assembly/regression-kit.ts';
import { receiptContext } from '../stream-model-prereq/kit.ts';
import { lookupOf, quotedPort, unconfirmedContext } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The stream runtime over the production business factory with the fixture's demo ports. */
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

async function runIds(sessionId: string): Promise<string[]> {
  const rows = await pg.db
    .selectFrom('agent_runs')
    .select('id')
    .where('session_id', '=', sessionId)
    .execute();
  return rows.map((row) => row.id);
}

it('[AC-B3-03q#4][BR-AI-05][BR-AI-04] 生产 stream 入口：报价卡已编号、已交出但没有写出回执（写卡失败）——卡内商品不记，按其 card_id findDelivered 为 null、报价为 invalid_args；同会话之后带回执写出的报价卡照常记下并可报价', async () => {
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

    // The quote card is numbered (c301, its product c302) and handed over; no receipt comes.
    const unseen = unconfirmedContext({ runId: runs[0]!, sessionId, firstNo: 301 });
    const ctx = { ...f.context(sessionId), runId: runs[0]! };
    await core.createAgentRunBody({ ...deps, inputCheck: passInput })(request(ctx, one!).input)(
      unseen.ctx,
    );
    expect(unseen.frames.map((frame) => [frame.type, frame.card_id])).toEqual([
      ['rebate_quote', 'c301'],
    ]);
    const handed = unseen.frames[0]!.data['product'] as Row;
    expect(handed['card_id']).toBe('c302');

    const store = createPgResultSetStore({ db: pg.db });
    for (const cardId of ['c301', 'c302']) {
      expect(await store.findDelivered(APP, sessionId, cardId), cardId).toBeNull();
    }
    const resolver = createReferenceResolver({ store });
    const lookup = lookupOf(APP, sessionId, f.caller);
    expect(await resolver.resolve({ card_id: 'c302' }, lookup)).toEqual({ kind: 'invalid_args' });
    f.readProduct.mockClear();
    const rejected = await callTool(deps.tools, f.context(sessionId), 'get_rebate_quote', {
      card_id: 'c302',
    });
    expect(rejected).toMatchObject({ kind: 'rejected', modelView: { error: 'invalid_args' } });
    expect(f.readProduct).not.toHaveBeenCalled();

    // A later quote written with its receipt (c401, its product c402) is recorded and resolves.
    quotedPort(store);
    const seen = receiptContext({ runId: runs[0]!, sessionId, firstNo: 401 });
    const result = await core.createAgentRunBody({ ...deps, inputCheck: passInput })(
      request(ctx, two!).input,
    )(seen.ctx);
    expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
    expect(seen.frames.map((frame) => [frame.type, frame.card_id])).toEqual([
      ['rebate_quote', 'c401'],
    ]);
    const written = seen.frames[0]!.data['product'] as Row;
    expect(written['card_id']).toBe('c402');
    const found = await store.findDelivered(APP, sessionId, 'c402');
    expect(found, 'the written quote is recorded').not.toBeNull();
    expect(found).toMatchObject({
      card_id: 'c402',
      product_key: written['product_key'],
      platform: 'taobao',
      final_price_fen: written['final_price_fen'],
    });
    expect(await resolver.resolve({ card_id: 'c402' }, lookup)).toEqual({
      kind: 'product',
      productKey: written['product_key'],
    });

    // The unconfirmed one stays unknown: nothing recorded it in between.
    expect(await store.findDelivered(APP, sessionId, 'c302')).toBeNull();
    expect(await resolver.resolve({ card_id: 'c302' }, lookup)).toEqual({ kind: 'invalid_args' });
    f.readProduct.mockClear();
    const again = await callTool(deps.tools, f.context(sessionId), 'get_rebate_quote', {
      card_id: 'c302',
    });
    expect(again).toMatchObject({ kind: 'rejected', modelView: { error: 'invalid_args' } });
    expect(f.readProduct).not.toHaveBeenCalled();
  } finally {
    await r.runtime.close();
  }
}, 120_000);
