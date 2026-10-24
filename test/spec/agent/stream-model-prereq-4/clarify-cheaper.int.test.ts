// B3-03r §9 item 5 · BR-AI-08 / BR-AI-05 / BR-PRICE-15: deferring the chain switch keeps the
// clarification and 再便宜点 rules as they were. A price question (awaiting_price) is still the
// session's chain at once; an answer whose batch never reached the user leaves that question's
// chain in place, so the price slot asked once (takeOnce) stays asked on the same chain and the
// next invalid price is dropped with a notice instead of a second question. 再便宜点 without a
// cheaper result keeps the conditions (B3-05k), also after a batch the user never saw. Real
// stream runtime + PG through the shared kits; the assembly's own tools, intent port and result
// store; scripted model, synthetic DTOs only.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { usePgEach } from '../stream-mount/kit.ts';
import {
  APP,
  STOP,
  chainOf,
  expectUnseen,
  listKeys,
  nextBatch,
  opened,
  ordinal,
  refineRounds,
  rig,
  rowAs,
  runBody,
  searchRounds,
  seenSearch,
  unseenBy,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it.each(['pg', 'memory'] as const)(
  '[AC-B3-03r#5][BR-AI-08][BR-AI-05] 价格澄清后答价这批没写出（结果库 %s）：当前链仍是待答价格的那条链；同链再给非法价格不再追问（takeOnce 作用域不错位），丢弃价格检索并出 notice，写出后该链才有商品',
  async (kind) => {
    const x = await rig(pg.db, kind);
    try {
      const at = await opened(x);
      await seenSearch(x, at, '合成保温杯', 101);
      const before = await chainOf(x.store, APP, at.sessionId);
      expect(before).toMatchObject({ status: 'has_products', conditions: { q: '合成保温杯' } });

      // A new query with an invalid price: one price question, nothing searched.
      x.f.state.row = rowAs(x.base, 'synthetic-mug', '合成水杯 400ml');
      const question = await runBody(x, {
        ...at,
        text: '合成水杯 0 元以内',
        rounds: searchRounds({ q: '合成水杯', price_max_fen: 0 }),
        firstNo: 201,
      });
      expect(question.result).toEqual(STOP);
      expect(question.searched).toEqual([]);
      expect(listKeys(question.frames)).toEqual([]);
      const asked = await chainOf(x.store, APP, at.sessionId);
      expect(asked).toMatchObject({ status: 'awaiting_price', conditions: { q: '合成水杯' } });
      expect(asked?.chainId).not.toBe(before?.chainId);

      // The answer's batch is searched but cancelled before it is written.
      const answer = await runBody(x, {
        ...at,
        text: '200 元以内',
        rounds: refineRounds({ price_max_fen: 20000 }),
        firstNo: 301,
        ...unseenBy('cancel'),
      });
      expect(answer.searched.map((query) => query.q)).toEqual(['合成水杯']);
      expectUnseen(answer, 'cancel');
      expect(await chainOf(x.store, APP, at.sessionId), 'still the question').toEqual(asked);

      // Same query, invalid price again: the slot was asked on this chain, so no second question.
      const again = await runBody(x, {
        ...at,
        text: '合成水杯 0 元以内',
        rounds: searchRounds({ q: '合成水杯', price_max_fen: 0 }),
        firstNo: 401,
      });
      expect(again.result).toEqual(STOP);
      expect(again.searched.map((query) => query.q)).toEqual(['合成水杯']);
      expect(again.frames.map((frame) => frame.type)).toEqual(['notice', 'product_list']);
      expect(again.frames[0]?.data['text_key']).toBe('agent.notice.price_unrecognized');
      const after = await chainOf(x.store, APP, at.sessionId);
      expect(after).toMatchObject({
        chainId: asked?.chainId,
        status: 'has_products',
        conditions: { q: '合成水杯' },
      });
      expect(after?.conditions?.price_max_fen).toBeUndefined();
      expect(await ordinal(x, at.sessionId, 1)).toEqual({
        kind: 'product',
        productKey: listKeys(again.frames)[0]![0],
      });
      const next = await nextBatch(x, at.sessionId, at.runId);
      expect(next.searched).toEqual([{ q: '合成水杯', page: 2 }]);
    } finally {
      await x.r.runtime.close();
    }
  },
  180_000,
);

it.each(['cancel', 'unconfirmed'] as const)(
  '[AC-B3-03r#5][BR-AI-05][BR-PRICE-15] 模型搜索的一批没写出（%s）后「再便宜点」无更便宜结果：不改条件、出 no_cheaper notice；当前链仍是用户见过的那批，「换一批」按它翻页，「第 N 个」指向它',
  async (mode) => {
    const x = await rig(pg.db, 'pg');
    try {
      const at = await opened(x);
      const seen = await seenSearch(x, at, '合成保温杯', 101);
      const before = await chainOf(x.store, APP, at.sessionId);
      expect(before).toMatchObject({ status: 'has_products', conditions: { q: '合成保温杯' } });

      x.f.state.row = rowAs(x.base, 'synthetic-mug', '合成水杯 400ml');
      const unseen = await runBody(x, {
        ...at,
        text: '合成水杯',
        rounds: searchRounds({ q: '合成水杯' }),
        firstNo: 201,
        ...unseenBy(mode),
      });
      expectUnseen(unseen, mode);
      expect(await chainOf(x.store, APP, at.sessionId), 'current chain unchanged').toEqual(before);

      // 再便宜点 from the shown 100 yuan: ceiling 99.99 yuan; the only product (100 yuan) is out.
      x.f.state.row = x.base;
      const cheaper = await runBody(x, {
        ...at,
        text: '再便宜点',
        rounds: refineRounds({ cheaper: true }),
        firstNo: 301,
      });
      expect(cheaper.result).toEqual(STOP);
      expect(cheaper.searched.map((query) => query.q)).toEqual(['合成保温杯']);
      expect(listKeys(cheaper.frames).flat()).toEqual([]);
      expect(cheaper.frames.map((frame) => frame.data['text_key'])).toContain(
        'agent.notice.no_cheaper',
      );
      expect(await chainOf(x.store, APP, at.sessionId), 'no cheaper: unchanged').toEqual(before);
      expect(await ordinal(x, at.sessionId, 1)).toEqual({ kind: 'product', productKey: seen[0] });
      const next = await nextBatch(x, at.sessionId, at.runId);
      expect(next.searched).toEqual([{ q: '合成保温杯', page: 2 }]);
    } finally {
      await x.r.runtime.close();
    }
  },
  180_000,
);
