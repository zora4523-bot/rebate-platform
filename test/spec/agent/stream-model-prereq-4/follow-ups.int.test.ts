// B3-03r §9 items 1–2 · BR-AI-05 / BR-PRICE-15: the server's follow-ups (换一批 / 换平台 / 再便宜点 /
// a price answer), reached as the model's refine intent through the assembly's intent port. The
// refined batch's conditions become the session's current chain only once its product_list was
// confirmed as written; a refined batch that never went out (cancelled, cut by the card limit,
// written without a receipt) leaves the chain's conditions and page as the user saw them, so
// 「换一批」 and 「第 N 个」 keep addressing the same batch. Real stream runtime + PG through the
// shared kits; the assembly's own tools, intent port and result store; scripted model, synthetic
// DTOs only.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import type { SearchConditions } from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
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
  pricedRow,
  refineRounds,
  rig,
  rowAs,
  runBody,
  seenSearch,
  unseenBy,
  type Rig,
  type Row,
  type Unseen,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

/** One follow-up, the refine conditions the model outputs for it, and what it searches. */
interface FollowUp {
  readonly label: string;
  readonly conditions: Row;
  /** The refined search finds a cheaper product (再便宜点 needs one below the shown 100 yuan). */
  readonly cheaper: boolean;
  /** The chain's conditions after the refined batch was confirmed as written. */
  readonly next: (shown: SearchConditions) => SearchConditions;
}

const FOLLOW_UPS: readonly FollowUp[] = [
  {
    label: '换一批',
    conditions: { next_batch: true },
    cheaper: false,
    next: (shown) => ({ ...shown, page: (shown.page ?? 1) + 1 }),
  },
  {
    label: '换平台',
    conditions: { platform: 'taobao' },
    cheaper: false,
    next: (shown) => ({ ...shown, platforms: ['taobao'] }),
  },
  {
    // BR-PRICE-15: min(no ceiling, lowest shown 10000 − 1), ascending final price, page 1.
    label: '再便宜点',
    conditions: { cheaper: true },
    cheaper: true,
    next: (shown) => ({ ...shown, price_max_fen: 9999, sort: 'final_price_asc', page: 1 }),
  },
  {
    // A valid new price restarts at page 1 (AC-B3-05k#9).
    label: '价格续答',
    conditions: { price_max_fen: 20000 },
    cheaper: false,
    next: (shown) => ({ ...shown, price_max_fen: 20000, page: 1 }),
  },
];

function followUp(label: string): FollowUp {
  const found = FOLLOW_UPS.find((entry) => entry.label === label);
  expect(found, label).toBeDefined();
  return found!;
}

/** The product the refined search finds (another product; a cheaper one for 再便宜点). */
function refinedRow(x: Rig, follow: FollowUp) {
  return follow.cheaper
    ? rowAs(pricedRow(x.base, 8000n), 'synthetic-cheaper', '合成保温杯 便宜款')
    : rowAs(x.base, 'synthetic-mug', '合成保温杯 二号');
}

it.each(FOLLOW_UPS)(
  '[AC-B3-03r#1][BR-AI-05][BR-PRICE-15] 续答「$label」这批写出并确认后才切为当前链（交出未确认时仍是用户见过的条件）；之后「换一批」从新条件翻页，「第 N 个」1 指向新一批第一件',
  async (follow) => {
    const x = await rig(pg.db, 'pg');
    try {
      const at = await opened(x);
      await seenSearch(x, at, '合成保温杯', 101);
      const before = await chainOf(x.store, APP, at.sessionId);
      expect(before).toMatchObject({ status: 'has_products', conditions: { q: '合成保温杯' } });

      x.f.state.row = refinedRow(x, follow);
      const probe = chainProbe(x, at.sessionId);
      const run = await runBody(x, {
        ...at,
        text: follow.label,
        rounds: refineRounds(follow.conditions),
        firstNo: 201,
        beforeReceipt: probe.beforeReceipt,
      });
      expect(run.result).toEqual(STOP);
      expect(run.searched.map((query) => query.q)).toEqual(['合成保温杯']);
      const shown = listKeys(run.frames);
      expect(shown).toHaveLength(1);
      expect(probe.seen, 'still the conditions the user saw before the receipt').toEqual([before]);

      const expected = follow.next(before!.conditions!);
      expect(await chainOf(x.store, APP, at.sessionId)).toEqual({
        chainId: before!.chainId,
        status: 'has_products',
        conditions: expected,
      });
      expect(await ordinal(x, at.sessionId, 1)).toEqual({
        kind: 'product',
        productKey: shown[0]![0],
      });
      const next = await nextBatch(x, at.sessionId, at.runId);
      expect(next.searched).toEqual([{ q: '合成保温杯', page: (expected.page ?? 1) + 1 }]);
    } finally {
      await x.r.runtime.close();
    }
  },
  180_000,
);

it.each([
  ['换一批', 'cancel'],
  ['换一批', 'limit'],
  ['换一批', 'unconfirmed'],
  ['换平台', 'cancel'],
  ['换平台', 'limit'],
  ['再便宜点', 'cancel'],
  ['再便宜点', 'unconfirmed'],
  ['价格续答', 'cancel'],
  ['价格续答', 'unconfirmed'],
] as const satisfies readonly (readonly [string, Unseen])[])(
  '[AC-B3-03r#2][BR-AI-05][BR-PRICE-15] 续答「%s」这批卡没写出（%s）：currentChain 的条件与页码保持为用户上一批见过的那批；「换一批」按上一批条件翻页，「第 N 个」仍指向上一批',
  async (label, mode) => {
    const follow = followUp(label);
    const x = await rig(pg.db, 'pg');
    try {
      const at = await opened(x);
      const seen = await seenSearch(x, at, '合成保温杯', 101);
      const before = await chainOf(x.store, APP, at.sessionId);
      expect(before).toMatchObject({ status: 'has_products', conditions: { q: '合成保温杯' } });

      x.f.state.row = refinedRow(x, follow);
      const run = await runBody(x, {
        ...at,
        text: follow.label,
        rounds: refineRounds(follow.conditions),
        firstNo: 201,
        ...unseenBy(mode),
      });
      expect(
        run.searched.map((query) => query.q),
        'the refined batch was searched',
      ).toEqual(['合成保温杯']);
      expectUnseen(run, mode);

      expect(await chainOf(x.store, APP, at.sessionId), 'current chain unchanged').toEqual(before);
      expect(await ordinal(x, at.sessionId, 1)).toEqual({ kind: 'product', productKey: seen[0] });
      expect(await ordinal(x, at.sessionId, seen.length + 1)).toEqual({ kind: 'clarify' });
      const again = await nextBatch(x, at.sessionId, at.runId);
      expect(again.searched, '换一批 continues the batch the user saw').toEqual([
        { q: '合成保温杯', page: (before?.conditions?.page ?? 1) + 1 },
      ]);
    } finally {
      await x.r.runtime.close();
    }
  },
  180_000,
);
