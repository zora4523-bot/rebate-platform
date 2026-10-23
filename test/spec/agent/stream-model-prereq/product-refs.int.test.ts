// B3-03n §9 item 3 · BR-AI-04 / BR-AI-05: the production search writes the product reference
// (product_refs) of every product card it delivers, through catalog's registerProductRef (the
// write entry catalog / parsing use; no SQL of its own), so a later quote by the scenario entry
// context.product_key finds the stored raw identifier and reads a fresh price (no tool_failed).
// Real stream AppModule + PG; the demo union adapter's normalized DTO only (no vendor recording).
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createCatalog, type Catalog } from '../../../../apps/api/src/modules/catalog/index.ts';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import {
  framesOf,
  message,
  openSession,
  send,
  setConfig,
  usePgEach,
  type Row,
} from '../stream-mount/kit.ts';
import { APP, TOKEN, passInput, request } from '../stream-assembly/kit.ts';
import { callTool, production } from '../stream-assembly/regression-kit.ts';
import { deliveredProducts, modelPath, receiptContext } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

type Rig = Awaited<ReturnType<typeof production>>;

/** catalog's one registerProductRef, observed on the shared catalog implementation. */
function registerSpy(r: Rig) {
  const proto = Object.getPrototypeOf(
    createCatalog({ db: pg.db, clock: r.time.clock, warn: vi.fn() }),
  ) as Catalog;
  return vi.spyOn(proto, 'registerProductRef');
}

async function refOf(productKey: string) {
  return pg.db
    .selectFrom('product_refs')
    .selectAll()
    .where('app_id', '=', APP)
    .where('product_key', '=', productKey)
    .executeTakeFirst();
}

/** Delivered products have a search reference with the raw id their link was registered with. */
async function expectRefs(items: readonly Row[]) {
  for (const item of items) {
    const productKey = item['product_key'] as string;
    const ref = await refOf(productKey);
    expect(ref, `product_refs of ${productKey}`).toBeDefined();
    expect(ref).toMatchObject({
      app_id: APP,
      platform: 'taobao',
      source: 'search',
    });
    const link = await pg.db
      .selectFrom('links')
      .select('raw_item_id')
      .where('link_id', '=', item['link_id'] as string)
      .executeTakeFirstOrThrow();
    expect(ref?.raw_item_id).toBeTypeOf('string');
    expect(ref?.raw_item_id).toBe(link.raw_item_id);
  }
}

/** Each delivered product went through catalog's registerProductRef as a search reference. */
function expectRegistered(register: ReturnType<typeof registerSpy>, items: readonly Row[]) {
  for (const item of items) {
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: APP,
        platform: 'taobao',
        productKey: item['product_key'],
        source: 'search',
      }),
      expect.anything(),
    );
  }
}

/** Quotes by context.product_key twice, the demo adapter's price changing in between. */
async function expectFreshQuotes(r: Rig, sessionId: string, productKey: string) {
  const rawItemId = (await refOf(productKey))?.raw_item_id;
  const originalGetItem = DemoUnionAdapter.prototype.getItem;
  const getItem = vi.spyOn(DemoUnionAdapter.prototype, 'getItem');
  for (const amounts of [
    { price_fen: 9000n, coupon_fen: 1000n, final_price_fen: 8000n },
    { price_fen: 7000n, coupon_fen: 1000n, final_price_fen: 6000n },
  ]) {
    getItem.mockClear().mockImplementation(async function (this: DemoUnionAdapter, ref, context) {
      const item = await originalGetItem.call(this, ref, context);
      return { ...item, ...amounts, quoted_at: r.time.clock.now().toISOString() };
    });
    const ctx = { ...r.context(sessionId), context: { product_key: productKey } };
    const outcome = await callTool(r.body.tools, ctx, 'get_rebate_quote', {
      product_key: productKey,
    });
    expect(outcome.kind, `quote of ${productKey}`).toBe('ok');
    if (outcome.kind !== 'ok') return;
    const card = outcome.cards.find((entry) => entry.type === 'rebate_quote');
    expect(card?.data['product']).toMatchObject({
      product_key: productKey,
      price_fen: Number(amounts.price_fen),
      coupon_fen: Number(amounts.coupon_fen),
      final_price_fen: Number(amounts.final_price_fen),
    });
    expect(getItem).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'taobao', item_id: rawItemId }),
      expect.objectContaining({ appId: APP, purpose: 'online' }),
    );
  }
}

it('[AC-B3-03n#5][BR-AI-04][BR-AI-05] 生产搜索出卡经 catalog.registerProductRef 写 product_refs；随后以该商品的 context.product_key 报价能读到并现查新价', async () => {
  const r = await production(pg.db);
  try {
    const register = registerSpy(r);
    const sessionId = await openSession(r, r.caller);
    const frames = framesOf((await send(r, r.caller, sessionId, message('演示商品'))).chunks);
    const lists = frames.filter(
      (frame) => frame.event === 'card' && frame.data['type'] === 'product_list',
    );
    expect(lists).toHaveLength(1);
    const items = (lists[0]!.data['data'] as Row)['items'] as Row[];
    expect(items.length).toBeGreaterThan(0);

    await expectRefs(items);
    expectRegistered(register, items);
    await expectFreshQuotes(r, sessionId, items[0]!['product_key'] as string);
  } finally {
    await r.app.close();
  }
}, 120_000);

it('[AC-B3-03n#6][BR-AI-04][BR-AI-05] 生产 search_products 模型工具出卡同样经 catalog 写 product_refs；随后 context.product_key 报价不再 tool_failed', async () => {
  const r = await production(pg.db);
  try {
    const sessionId = await openSession(r, r.caller);
    // A real run that searches nothing (token path, parsing off) for the result set to belong to.
    await setConfig(pg.db, APP, 'parse.tpwd.enabled', false);
    framesOf((await send(r, r.caller, sessionId, message(TOKEN))).chunks);
    const runs = await pg.db
      .selectFrom('agent_runs')
      .select('id')
      .where('session_id', '=', sessionId)
      .execute();
    expect(runs).toHaveLength(1);
    expect(await pg.db.selectFrom('product_refs').select('product_key').execute()).toEqual([]);

    const register = registerSpy(r);
    const ctx = { ...r.context(sessionId), runId: runs[0]!.id };
    const out = receiptContext({ runId: ctx.runId, sessionId, firstNo: 101 });
    const result = await core.createAgentRunBody({
      ...r.body,
      ...modelPath([
        { calls: [{ name: 'search_products', args: { q: '演示商品' } }] },
        { text: '好的。' },
      ]),
      inputCheck: passInput,
    })(request(ctx, '演示商品').input)(out.ctx);
    expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
    const lists = out.frames.filter((frame) => frame.type === 'product_list');
    expect(lists).toHaveLength(1);
    const items = lists[0]!.data['items'] as Row[];
    expect(items.length).toBeGreaterThan(0);
    expect(deliveredProducts(out.frames).map((item) => item.product_key)).toEqual(
      items.map((item) => item['product_key']),
    );

    await expectRefs(items);
    expectRegistered(register, items);
    await expectFreshQuotes(r, sessionId, items[0]!['product_key'] as string);
  } finally {
    await r.app.close();
  }
}, 120_000);
