// Observe app.module's actual stream composition, not the synthetic business ports in kit.ts.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createCatalog } from '../../../../apps/api/src/modules/catalog/index.ts';
import * as parsing from '../../../../apps/api/src/modules/parsing/index.ts';
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
import { APP, TOKEN, output, request } from './kit.ts';
import { callTool, production } from './regression-kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

async function search(r: Awaited<ReturnType<typeof production>>, sessionId: string) {
  const frames = framesOf((await send(r, r.caller, sessionId, message('演示商品'))).chunks);
  const lists = frames.filter(
    (frame) => frame.event === 'card' && frame.data['type'] === 'product_list',
  );
  expect(lists).toHaveLength(1);
  expect(frames.at(-1)?.data['finish_reason']).toBe('fallback');
  const items = (lists[0]!.data['data'] as Row)['items'] as Row[];
  expect(items.length).toBeGreaterThan(0);
  return items;
}

it('[AC-B3-03j#16][BR-AI-01][BR-AI-03] 生产 stream 工厂两会话出卡的 PG 登记逐次绑定会话，不串用 scene 或 runId', async () => {
  const convert = vi.spyOn(DemoUnionAdapter.prototype, 'convert');
  const r = await production(pg.db);
  try {
    // D10-140 fixture order: createAgentSession reuses the caller's newest live session while it
    // has no run (04 §6.5, agent/store/index.ts open), so each session is opened after the
    // previous one ran its search. No assertion changed.
    const sessions: string[] = [];
    const issued: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const sessionId = await openSession(r, r.caller);
      sessions.push(sessionId);
      const items = await search(r, sessionId);
      const rows = await pg.db
        .selectFrom('links')
        .selectAll()
        .where('app_id', '=', APP)
        .where('agent_session_id', '=', sessionId)
        .execute();
      expect(rows).toHaveLength(items.length);
      const runs = await pg.db
        .selectFrom('agent_runs')
        .select('id')
        .where('session_id', '=', sessionId)
        .execute();
      expect(runs).toHaveLength(1);
      for (const item of items) {
        expect(item['link_id']).toBeTypeOf('string');
        const row = rows.find((link) => link.link_id === item['link_id']);
        expect(row).toMatchObject({
          app_id: APP,
          scene: 'agent',
          agent_session_id: sessionId,
          user_id: r.caller.userId,
          device_id: r.caller.deviceId,
          convert_result: null,
        });
        expect(row?.agent_session_id).not.toBe(runs[0]?.id);
        expect(row?.identity_snapshot).toMatchObject({ agent_session_id: sessionId });
        issued.push(item['link_id'] as string);
      }
    }
    expect(new Set(sessions).size).toBe(2);
    expect(new Set(issued).size).toBe(issued.length);
    expect(convert).not.toHaveBeenCalled();
  } finally {
    await r.app.close();
  }
}, 120_000);

it('[AC-B3-03j#17][BR-AI-04] 生产 readProduct 在搜索后重新取数，两次报价均取演示适配器新价格并登记同次快照', async () => {
  const originalGetItem = DemoUnionAdapter.prototype.getItem;
  const getItem = vi.spyOn(DemoUnionAdapter.prototype, 'getItem');
  const convert = vi.spyOn(DemoUnionAdapter.prototype, 'convert');
  const r = await production(pg.db);
  try {
    const sessionId = await openSession(r, r.caller);
    const items = await search(r, sessionId);
    const first = items[0]!;
    expect(first['product_key']).toBeTypeOf('string');
    const productKey = first['product_key'] as string;
    const source = await pg.db
      .selectFrom('links')
      .selectAll()
      .where('link_id', '=', first['link_id'] as string)
      .executeTakeFirstOrThrow();
    expect(source.raw_item_id).toBeTypeOf('string');
    // Search need not persist product_refs (another task). Seed a real catalog reference from
    // the registered link, so the production lookup has a valid server-owned raw identifier.
    const catalog = createCatalog({ db: pg.db, clock: r.time.clock, warn: vi.fn() });
    await catalog.registerProductRef(
      {
        appId: APP,
        platform: 'taobao',
        productKey,
        rawItemId: source.raw_item_id!,
        rawFetchedAt: r.time.clock.now().toISOString(),
        receivedAt: r.time.clock.now().toISOString(),
        canonicalUrl: null,
        title: String(first['title']),
        shopId: null,
        shopType: null,
        source: 'search',
      },
      { parseEnabled: true, searchEnabled: true },
    );

    // Change only the demo adapter's normalized DTO, never a platform wire response, catalog
    // reader or quoter. Each quote must travel through the actual production readProduct port.
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
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') continue;
      const card = outcome.cards.find((entry) => entry.type === 'rebate_quote');
      expect(card).toBeDefined();
      const product = card!.data['product'] as Row;
      expect(product).toMatchObject({
        product_key: productKey,
        price_fen: Number(amounts.price_fen),
        coupon_fen: Number(amounts.coupon_fen),
        final_price_fen: Number(amounts.final_price_fen),
      });
      expect(getItem).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'taobao', item_id: source.raw_item_id }),
        expect.objectContaining({ appId: APP, purpose: 'online' }),
      );
      expect(product['link_id']).not.toBe(first['link_id']);
      const row = await pg.db
        .selectFrom('links')
        .selectAll()
        .where('link_id', '=', product['link_id'] as string)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        app_id: APP,
        scene: 'agent',
        agent_session_id: sessionId,
        quoted_final_price_fen: amounts.final_price_fen,
        quoted_coupon_fen: amounts.coupon_fen,
        convert_result: null,
      });
      expect(row.agent_session_id).not.toBe(ctx.runId);
    }
    expect(convert).not.toHaveBeenCalled();
  } finally {
    await r.app.close();
  }
}, 120_000);

it.each([false, true])(
  '[AC-B3-03j#18][BR-AI-04][BR-AI-14] 生产 TokenParser 调 parsing.parseToken，开关=%s；只在开时尝试演示 resolveLink',
  async (enabled) => {
    const parseToken = vi.spyOn(parsing, 'parseToken');
    const resolve = vi.spyOn(DemoUnionAdapter.prototype, 'resolveLink');
    const searchItems = vi.spyOn(DemoUnionAdapter.prototype, 'searchItems');
    const convert = vi.spyOn(DemoUnionAdapter.prototype, 'convert');
    const r = await production(pg.db);
    try {
      await setConfig(pg.db, APP, 'parse.tpwd.enabled', enabled);
      const sessionId = await openSession(r, r.caller);
      const frames = framesOf((await send(r, r.caller, sessionId, message(TOKEN))).chunks);
      expect(parseToken).toHaveBeenCalledTimes(1);
      expect(parseToken).toHaveBeenCalledWith(
        expect.any(Object),
        TOKEN,
        expect.objectContaining({ appId: APP, purpose: 'online' }),
      );
      expect(resolve).toHaveBeenCalledTimes(enabled ? 1 : 0);
      if (enabled)
        expect(resolve).toHaveBeenCalledWith(
          TOKEN,
          expect.objectContaining({ appId: APP, purpose: 'online' }),
        );
      expect(
        frames
          .filter((frame) => frame.event === 'card')
          .map((frame) => ({
            type: frame.data['type'],
            text_key: (frame.data['data'] as Row)['text_key'],
          })),
      ).toEqual([{ type: 'notice', text_key: 'error.30132' }]);
      expect(frames.at(-1)?.data['finish_reason']).toBe('stop');
      expect(searchItems).not.toHaveBeenCalled();
      expect(convert).not.toHaveBeenCalled();
      expect(await pg.db.selectFrom('links').select('link_id').execute()).toEqual([]);
    } finally {
      await r.app.close();
    }
  },
  120_000,
);

it.each([['Wallet'], ['WithdrawRecords']])(
  '[AC-B3-03j#19][BR-AI-01][BR-AI-02] 生产 routes.configured 读取 agent.page_guide.routes=%s，并与契约取交集',
  async (allowedRoute) => {
    const r = await production(pg.db, [allowedRoute]);
    try {
      const sessionId = await openSession(r, r.caller);
      for (const route of ['Wallet', 'WithdrawRecords', 'Withdraw']) {
        const ctx = r.context(sessionId);
        const out = output(ctx);
        const result = await r.body.intents!.handle(
          {
            ...request(ctx, '页面入口'),
            text: JSON.stringify({ agent_intent: 'page_guide', guide_route: route }),
          },
          out.run,
        );
        expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
        if (route === allowedRoute) {
          expect(out.cards).toEqual([
            expect.objectContaining({
              type: 'page_guide',
              data: { route, text_key: `agent.guide.${route}` },
            }),
          ]);
          expect(out.texts).toEqual([]);
        } else {
          expect(out.cards).toEqual([]);
          expect(out.texts).toEqual([
            route === 'Withdraw'
              ? '合成文案:agent.guide.account.fund'
              : '合成文案:agent.guide.unavailable',
          ]);
        }
      }
      expect(await pg.db.selectFrom('links').select('link_id').execute()).toEqual([]);
    } finally {
      await r.app.close();
    }
  },
  120_000,
);
