// B3-03r §9 items 3–4 · BR-AI-05: what counts is the product_list actually confirmed as written.
// A list confirmed as written still switches the chain when the user stops the run afterwards,
// before it ends; with several lists in one round, only one confirmed as written decides the chain
// (another one cancelled, cut by the card limit or never confirmed does not). Real stream runtime
// + PG through the shared kits; the assembly's own tools, intent port and result store; scripted
// model, synthetic DTOs only.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { usePgEach } from '../stream-mount/kit.ts';
import {
  APP,
  STOP,
  chainOf,
  chainProbe,
  listKeys,
  nextBatch,
  opened,
  ordinal,
  rig,
  rowAs,
  runBody,
  searchRounds,
  seenSearch,
  type Fate,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

it.each(['pg', 'memory'] as const)(
  '[AC-B3-03r#3][BR-AI-05] 模型路径本轮商品列表已确认写出、随后在收尾前用户停止本轮（结果库 %s）：仍切为本轮的链（确认前仍是上一批的链）；「换一批」从本轮条件翻下一页，「第 N 个」指向本轮',
  async (kind) => {
    const x = await rig(pg.db, kind);
    try {
      const at = await opened(x);
      await seenSearch(x, at, '合成保温杯', 101);
      const before = await chainOf(x.store, APP, at.sessionId);
      expect(before).toMatchObject({ status: 'has_products', conditions: { q: '合成保温杯' } });

      x.f.state.row = rowAs(x.base, 'synthetic-tea', '合成茶杯');
      const probe = chainProbe(x, at.sessionId);
      // The user stops the run when the model is asked for its final text (round 2).
      const run = await runBody(x, {
        ...at,
        text: '合成茶杯',
        rounds: searchRounds({ q: '合成茶杯' }),
        firstNo: 201,
        beforeReceipt: probe.beforeReceipt,
        stopAtRound: 2,
      });
      expect(run.result).toEqual(STOP);
      const shown = listKeys(run.frames);
      expect(shown).toHaveLength(1);
      expect(probe.seen, 'still the previous batch before the receipt').toEqual([before]);
      const after = await chainOf(x.store, APP, at.sessionId);
      expect(after).toMatchObject({ status: 'has_products', conditions: { q: '合成茶杯' } });
      expect(after?.chainId).not.toBe(before?.chainId);
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

/** Two model search calls in one round: 合成水杯 first, then 合成茶杯. */
interface PartialCase {
  readonly label: string;
  /** Fate of the 1st / 2nd list handed over. */
  readonly fates: readonly [Fate, Fate];
  /** The run's card limit (none: the default). */
  readonly cards?: number;
  readonly finish: 'stop' | 'limit';
  /** Which list was confirmed (its index among the written frames) and its query. */
  readonly written: number;
  readonly q: string;
  /**
   * The query of the chain each probe sees (one probe per written product_list, before its
   * receipt): the latest batch confirmed so far; '合成保温杯' is the previous batch (`before`).
   */
  readonly probes: readonly string[];
}

const PARTIAL: readonly PartialCase[] = [
  {
    label: '第 1 张写出、第 2 张交出未确认',
    fates: ['write', 'unconfirmed'],
    finish: 'stop',
    written: 0,
    q: '合成水杯',
    probes: ['合成保温杯', '合成水杯'],
  },
  {
    label: '第 1 张交出未确认、第 2 张写出',
    fates: ['unconfirmed', 'write'],
    finish: 'stop',
    written: 1,
    q: '合成茶杯',
    probes: ['合成保温杯', '合成保温杯'],
  },
  {
    label: '第 1 张写出、第 2 张写出前取消',
    fates: ['write', 'cancel'],
    finish: 'stop',
    written: 0,
    q: '合成水杯',
    probes: ['合成保温杯'],
  },
  {
    // 2 (list frame and its product) fit in 3; the second list (2 more) is cut, never split.
    label: '第 1 张写出、第 2 张被卡片上限截掉',
    fates: ['write', 'write'],
    cards: 3,
    finish: 'limit',
    written: 0,
    q: '合成水杯',
    probes: ['合成保温杯'],
  },
];

it.each(PARTIAL)(
  '[AC-B3-03r#4][BR-AI-05] 同轮两次 search_products 只部分写出（$label）：以确认写出的那张 product_list 切链；「换一批」按它的条件翻页，「第 N 个」指向它',
  async (partial) => {
    const x = await rig(pg.db, 'pg');
    try {
      const at = await opened(x);
      await seenSearch(x, at, '合成保温杯', 101);
      const before = await chainOf(x.store, APP, at.sessionId);
      expect(before).toMatchObject({ status: 'has_products', conditions: { q: '合成保温杯' } });

      const mug = rowAs(x.base, 'synthetic-mug', '合成水杯 400ml');
      const tea = rowAs(x.base, 'synthetic-tea', '合成茶杯');
      x.f.searchProducts.mockImplementation(async (query) => [query.q === '合成水杯' ? mug : tea]);
      const probe = chainProbe(x, at.sessionId);
      const run = await runBody(x, {
        ...at,
        text: '合成水杯和合成茶杯',
        rounds: searchRounds({ q: '合成水杯' }, { q: '合成茶杯' }),
        firstNo: 201,
        fate: (_card, index) => partial.fates[index] ?? 'write',
        beforeReceipt: probe.beforeReceipt,
        ...(partial.cards === undefined ? {} : { cards: partial.cards }),
      });
      expect(run.searched.map((query) => query.q)).toEqual(['合成水杯', '合成茶杯']);
      expect(run.result).toEqual({ kind: 'done', finishReason: partial.finish });
      expect(probe.seen.length).toBeGreaterThan(0);
      expect(probe.seen, 'the latest confirmed batch before each receipt').toEqual(
        partial.probes.map((q) =>
          q === '合成保温杯'
            ? before
            : expect.objectContaining({
                status: 'has_products',
                conditions: expect.objectContaining({ q }),
              }),
        ),
      );

      const after = await chainOf(x.store, APP, at.sessionId);
      expect(after).toMatchObject({ status: 'has_products', conditions: { q: partial.q } });
      expect(after?.chainId).not.toBe(before?.chainId);
      const shown = listKeys(run.frames)[partial.written];
      expect(shown?.length).toBeGreaterThan(0);
      expect(await ordinal(x, at.sessionId, 1)).toEqual({
        kind: 'product',
        productKey: shown?.[0],
      });
      const next = await nextBatch(x, at.sessionId, at.runId);
      expect(next.searched).toEqual([{ q: partial.q, page: 2 }]);
    } finally {
      await x.r.runtime.close();
    }
  },
  180_000,
);
