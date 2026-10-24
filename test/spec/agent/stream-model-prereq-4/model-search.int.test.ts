// B3-03r §9 items 1–2 · BR-AI-05: the model tool call search_products. A batch becomes the
// session's current chain only once its product_list was confirmed as written: while the list is
// only handed over the chain is still the one the user saw before; a batch that never went out
// (cancelled, cut by the card limit, or written without a receipt) leaves the current chain as it
// was (or still none), so 「换一批」 and 「第 N 个」 keep addressing the same, last seen batch. Real
// stream runtime + PG through the shared kits; the assembly's own tools, intent port and result
// store (PG injected, or its in-memory fallback); scripted model, synthetic DTOs only.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { usePgEach } from '../stream-mount/kit.ts';
import {
  APP,
  STOP,
  chainOf,
  chainProbe,
  expectUnseen,
  listKeys,
  nextBatch,
  opened,
  ordinal,
  rig,
  rowAs,
  runBody,
  searchRounds,
  seenSearch,
  unseenBy,
  type At,
  type Rig,
  type Unseen,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

/** The model searches `q`, the batch is found but its product_list never reaches the user. */
async function unseenSearch(x: Rig, at: At, q: string, mode: Unseen, firstNo: number) {
  const run = await runBody(x, {
    ...at,
    text: q,
    rounds: searchRounds({ q }),
    firstNo,
    ...unseenBy(mode),
  });
  expect(
    run.searched.map((query) => query.q),
    'the batch was searched',
  ).toContain(q);
  expectUnseen(run, mode);
}

it.each(['pg', 'memory'] as const)(
  '[AC-B3-03r#1][BR-AI-05] 模型调用 search_products（结果库 %s）：这批商品列表写出并确认后才切为当前链（交出未确认时仍是上一批的链）；之后「换一批」从本轮条件翻下一页，「第 N 个」1 指向本轮第一件',
  async (kind) => {
    const x = await rig(pg.db, kind);
    try {
      const at = await opened(x);
      // Batch 1: no current chain while its list is only handed over.
      const first = chainProbe(x, at.sessionId);
      const one = await runBody(x, {
        ...at,
        text: '合成保温杯',
        rounds: searchRounds({ q: '合成保温杯' }),
        firstNo: 101,
        beforeReceipt: first.beforeReceipt,
      });
      expect(one.result).toEqual(STOP);
      expect(first.seen, 'no current chain before the receipt').toEqual([null]);
      const before = await chainOf(x.store, APP, at.sessionId);
      expect(before).toMatchObject({ status: 'has_products', conditions: { q: '合成保温杯' } });

      // Batch 2: batch 1's chain until batch 2's list is confirmed, then batch 2's.
      x.f.state.row = rowAs(x.base, 'synthetic-tea', '合成茶杯');
      const second = chainProbe(x, at.sessionId);
      const two = await runBody(x, {
        ...at,
        text: '合成茶杯',
        rounds: searchRounds({ q: '合成茶杯' }),
        firstNo: 201,
        beforeReceipt: second.beforeReceipt,
      });
      expect(two.result).toEqual(STOP);
      expect(second.seen, 'still batch 1 before the receipt').toEqual([before]);
      const after = await chainOf(x.store, APP, at.sessionId);
      expect(after).toMatchObject({ status: 'has_products', conditions: { q: '合成茶杯' } });
      expect(after?.chainId).not.toBe(before?.chainId);
      const shown = listKeys(two.frames);
      expect(shown).toHaveLength(1);
      expect(await ordinal(x, at.sessionId, 1)).toEqual({
        kind: 'product',
        productKey: shown[0]![0],
      });
      const next = await nextBatch(x, at.sessionId, at.runId);
      expect(next.searched).toEqual([{ q: '合成茶杯', page: 2 }]);
    } finally {
      await x.r.runtime.close();
    }
  },
  180_000,
);

it.each([
  ['cancel', 'pg'],
  ['limit', 'pg'],
  ['unconfirmed', 'pg'],
  ['cancel', 'memory'],
  ['unconfirmed', 'memory'],
] as const)(
  '[AC-B3-03r#2][BR-AI-05] 模型调用 search_products 这批卡没写出（%s，结果库 %s）：currentChain 的条件与页码保持为用户上一批见过的那批，「换一批」按上一批条件翻页、「第 N 个」仍指向上一批；之后写出的一批确认后才切',
  async (mode, kind) => {
    const x = await rig(pg.db, kind);
    try {
      const at = await opened(x);
      const seen = await seenSearch(x, at, '合成保温杯', 101);
      const before = await chainOf(x.store, APP, at.sessionId);
      expect(before).toMatchObject({ status: 'has_products', conditions: { q: '合成保温杯' } });

      // Batch 2 (another product), searched by the model but never seen.
      x.f.state.row = rowAs(x.base, 'synthetic-mug', '合成水杯 400ml');
      await unseenSearch(x, at, '合成水杯', mode, 201);
      expect(await chainOf(x.store, APP, at.sessionId), 'current chain unchanged').toEqual(before);
      expect(await ordinal(x, at.sessionId, 1)).toEqual({ kind: 'product', productKey: seen[0] });
      expect(await ordinal(x, at.sessionId, seen.length + 1)).toEqual({ kind: 'clarify' });
      const again = await nextBatch(x, at.sessionId, at.runId);
      expect(again.searched, '换一批 continues the batch the user saw').toEqual([
        { q: '合成保温杯', page: 2 },
      ]);

      // Batch 3, written and confirmed: the current chain from then on.
      x.f.state.row = rowAs(x.base, 'synthetic-tea', '合成茶杯');
      const probe = chainProbe(x, at.sessionId);
      const three = await runBody(x, {
        ...at,
        text: '合成茶杯',
        rounds: searchRounds({ q: '合成茶杯' }),
        firstNo: 301,
        beforeReceipt: probe.beforeReceipt,
      });
      expect(three.result).toEqual(STOP);
      expect(probe.seen).toEqual([before]);
      const after = await chainOf(x.store, APP, at.sessionId);
      expect(after).toMatchObject({ status: 'has_products', conditions: { q: '合成茶杯' } });
      expect(after?.chainId).not.toBe(before?.chainId);
      expect(await ordinal(x, at.sessionId, 1)).toEqual({
        kind: 'product',
        productKey: listKeys(three.frames)[0]![0],
      });
      const next = await nextBatch(x, at.sessionId, at.runId);
      expect(next.searched).toEqual([{ q: '合成茶杯', page: 2 }]);
    } finally {
      await x.r.runtime.close();
    }
  },
  180_000,
);

it.each(['cancel', 'limit', 'unconfirmed'] as const)(
  '[AC-B3-03r#2][BR-AI-05] 会话原来没有当前链、模型调用 search_products 这批卡没写出（%s）：currentChain 仍为空，「换一批」不检索，「第 N 个」无可指；写出一批并确认后才有当前链',
  async (mode) => {
    const x = await rig(pg.db, 'pg');
    try {
      const at = await opened(x);
      x.f.state.row = rowAs(x.base, 'synthetic-mug', '合成水杯 400ml');
      await unseenSearch(x, at, '合成水杯', mode, 101);
      expect(await chainOf(x.store, APP, at.sessionId), 'still no current chain').toBeNull();
      expect(await x.store.latestWithProducts(APP, at.sessionId)).toBeNull();
      expect(await ordinal(x, at.sessionId, 1)).toEqual({ kind: 'clarify' });
      const again = await nextBatch(x, at.sessionId, at.runId);
      expect(again.searched, '换一批 has nothing to continue').toEqual([]);
      expect(again.cards.map((card) => card.type)).toEqual(['notice']);

      x.f.state.row = x.base;
      const probe = chainProbe(x, at.sessionId);
      const shown = await runBody(x, {
        ...at,
        text: '合成保温杯',
        rounds: searchRounds({ q: '合成保温杯' }),
        firstNo: 201,
        beforeReceipt: probe.beforeReceipt,
      });
      expect(shown.result).toEqual(STOP);
      expect(probe.seen).toEqual([null]);
      expect(await chainOf(x.store, APP, at.sessionId)).toMatchObject({
        status: 'has_products',
        conditions: { q: '合成保温杯' },
      });
      expect(await ordinal(x, at.sessionId, 1)).toEqual({
        kind: 'product',
        productKey: listKeys(shown.frames)[0]![0],
      });
      const next = await nextBatch(x, at.sessionId, at.runId);
      expect(next.searched).toEqual([{ q: '合成保温杯', page: 2 }]);
    } finally {
      await x.r.runtime.close();
    }
  },
  180_000,
);
