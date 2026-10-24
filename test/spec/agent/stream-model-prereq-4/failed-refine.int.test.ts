// B3-03r §10 (D10-333) · BR-AI-05: a 「换一批」 that never showed a batch does not move the page. The
// user saw page 1 of 合成保温杯; 「换一批」 asks the upstream for page 2 and every platform fails (or
// the user stops the run while page 2 is fetched): no product_list, so the current chain keeps its
// chainId, conditions and page as the user saw them, the next 「换一批」 asks for page 2 again (not
// page 3) and 「第 N 个」 still points at page 1. Control: a new query that searched fine but found
// nothing still becomes the chain the follow-ups (换平台 / a price answer) continue. Real stream
// runtime + PG through the shared kits; the assembly's own tools, intent port and result store;
// scripted model, synthetic DTOs only.
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { usePgEach } from '../stream-mount/kit.ts';
import { output, passInput, request } from '../stream-assembly/kit.ts';
import { modelPath } from '../stream-model-prereq/kit.ts';
import {
  APP,
  STOP,
  batchContext,
  chainOf,
  listKeys,
  nextBatch,
  opened,
  ordinal,
  refineRounds,
  rig,
  rowAs,
  runBody,
  searchRounds,
  searchedSince,
  seenSearch,
  type At,
  type Rig,
  type Row,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const CUP = '合成保温杯';
const NEW_QUERY = '合成水杯';
const PAGE_TWO_KEY = 'tb:synthetic-mug';

/**
 * The synthetic upstream: page 1 of 合成保温杯 is the fixture's product, page 2 throws while
 * `failing` is set (every platform fails) and is another product afterwards; 合成水杯 searches
 * fine and finds nothing.
 */
function upstream(x: Rig) {
  const state = { failing: true };
  const pageTwo = rowAs(x.base, 'synthetic-mug', '合成保温杯 二号');
  x.f.searchProducts.mockImplementation(async (query, _ctx, page) => {
    if (query.q === NEW_QUERY) return [];
    if (page !== 2) return [x.base];
    if (state.failing) throw new Error('synthetic upstream failure');
    return [pageTwo];
  });
  return state;
}

/** A refine follow-up through the assembly's intent port (its list is never confirmed). */
async function refineProbe(x: Rig, at: At, label: string, conditions: Row) {
  const ctx = { ...x.f.context(at.sessionId), runId: at.runId };
  const out = output(ctx);
  const from = x.f.searchProducts.mock.calls.length;
  const intents = x.deps.intents;
  expect(intents, 'the runtime body has the intent port').toBeDefined();
  const result = await intents!.handle(
    { ...request(ctx, label), text: JSON.stringify({ agent_intent: 'refine', conditions }) },
    out.run,
  );
  expect(result).toEqual(STOP);
  return searchedSince(x, from);
}

it.each(['pg', 'memory'] as const)(
  '[AC-B3-03r#7][BR-AI-05] 「换一批」请求第 2 页但上游全部失败（结果库 %s）：只出失败提示、没有商品列表，currentChain 仍为用户见过的第 1 页那批（chainId、条件与页码不变）；再「换一批」请求的仍是第 2 页而不是第 3 页，「第 N 个」仍指第 1 页那批；对照：检索成功但无结果的新查询之后当前链跟新查询走（第 1 页），换平台与价格追问按新查询检索',
  async (kind) => {
    const x = await rig(pg.db, kind);
    try {
      const at = await opened(x);
      const seen = await seenSearch(x, at, CUP, 101);
      const before = await chainOf(x.store, APP, at.sessionId);
      expect(before).toMatchObject({ status: 'has_products', conditions: { q: CUP } });
      expect(before?.conditions?.page ?? 1).toBe(1);
      const up = upstream(x);

      // 换一批: page 2 is asked for, every platform fails, only a failure notice goes out.
      const failed = await runBody(x, {
        ...at,
        text: '换一批',
        rounds: refineRounds({ next_batch: true }),
        firstNo: 201,
      });
      expect(failed.result).toEqual(STOP);
      expect(failed.searched, 'the server asked for page 2').toEqual([{ q: CUP, page: 2 }]);
      expect(listKeys(failed.frames)).toEqual([]);
      expect(failed.frames.map((frame) => frame.type)).toEqual(['notice']);
      expect(failed.frames[0]?.data['level']).toBe('warn');

      const kept = await chainOf(x.store, APP, at.sessionId);
      expect(kept, 'the failed 换一批 leaves the batch the user saw').toEqual(before);
      expect(kept?.chainId).toBe(before?.chainId);
      expect(kept?.conditions?.page ?? 1, 'still page 1').toBe(1);
      expect(await ordinal(x, at.sessionId, 1)).toEqual({ kind: 'product', productKey: seen[0] });
      expect(await ordinal(x, at.sessionId, seen.length + 1)).toEqual({ kind: 'clarify' });

      // 换一批 again: page 2 again, not page 3.
      const again = await nextBatch(x, at.sessionId, at.runId);
      expect(again.searched, 'page 2 again, not page 3').toEqual([{ q: CUP, page: 2 }]);
      expect(await chainOf(x.store, APP, at.sessionId)).toEqual(before);

      // The upstream is back: page 2 is written and confirmed, only then the chain is on page 2.
      up.failing = false;
      const shown = await runBody(x, {
        ...at,
        text: '换一批',
        rounds: refineRounds({ next_batch: true }),
        firstNo: 301,
      });
      expect(shown.result).toEqual(STOP);
      expect(shown.searched).toEqual([{ q: CUP, page: 2 }]);
      expect(listKeys(shown.frames)).toEqual([[PAGE_TWO_KEY]]);
      expect(await chainOf(x.store, APP, at.sessionId)).toEqual({
        chainId: before!.chainId,
        status: 'has_products',
        conditions: { ...before!.conditions!, page: 2 },
      });
      expect(await ordinal(x, at.sessionId, 1)).toEqual({
        kind: 'product',
        productKey: PAGE_TWO_KEY,
      });
      const third = await nextBatch(x, at.sessionId, at.runId);
      expect(third.searched).toEqual([{ q: CUP, page: 3 }]);

      // Control: a new query that searched fine and found nothing; the chain follows it.
      const empty = await runBody(x, {
        ...at,
        text: NEW_QUERY,
        rounds: searchRounds({ q: NEW_QUERY }),
        firstNo: 401,
      });
      expect(empty.result).toEqual(STOP);
      expect(empty.searched).toEqual([{ q: NEW_QUERY, page: 1 }]);
      expect(listKeys(empty.frames).flat()).toEqual([]);
      const fresh = await chainOf(x.store, APP, at.sessionId);
      expect(fresh?.conditions?.q, 'the chain follows the new query').toBe(NEW_QUERY);
      expect(fresh?.conditions?.page ?? 1).toBe(1);
      expect(fresh?.chainId).not.toBe(before?.chainId);
      // 「第 N 个」 addresses the latest result set with products (BR-AI-05 细则): page 2.
      expect(await ordinal(x, at.sessionId, 1)).toEqual({
        kind: 'product',
        productKey: PAGE_TWO_KEY,
      });

      for (const [label, conditions] of [
        ['换成淘宝的', { platform: 'taobao' }],
        ['200 元以内', { price_max_fen: 20000 }],
      ] as const) {
        const searched = await refineProbe(x, at, label, conditions);
        expect(searched.length, label).toBeGreaterThan(0);
        expect(
          searched.map((query) => query.q),
          `${label} continues the new query`,
        ).toEqual(searched.map(() => NEW_QUERY));
      }
    } finally {
      await x.r.runtime.close();
    }
  },
  180_000,
);

it('[AC-B3-03r#7][BR-AI-05] 「换一批」检索第 2 页时用户停止本轮：没有商品列表写出，currentChain 仍为用户见过的第 1 页那批（chainId、条件与页码不变）；再「换一批」请求的仍是第 2 页，「第 N 个」仍指第 1 页那批', async () => {
  const x = await rig(pg.db, 'pg');
  try {
    const at = await opened(x);
    const seen = await seenSearch(x, at, CUP, 101);
    const before = await chainOf(x.store, APP, at.sessionId);
    expect(before).toMatchObject({ status: 'has_products', conditions: { q: CUP } });
    expect(before?.conditions?.page ?? 1).toBe(1);

    // The run of the core body the runtime built; the user stops it while page 2 is fetched.
    const out = batchContext({ ...at, firstNo: 201 });
    x.f.searchProducts.mockImplementation(async (_query, _ctx, page) => {
      if (page !== 2) return [x.base];
      out.controller.abort('cancelled');
      throw new Error('synthetic: the user stopped the run');
    });
    const from = x.f.searchProducts.mock.calls.length;
    const ctx = { ...x.f.context(at.sessionId), runId: at.runId };
    const result = await core.createAgentRunBody({
      ...x.deps,
      ...modelPath(refineRounds({ next_batch: true })),
      inputCheck: passInput,
    })(request(ctx, '换一批').input)(out.ctx);
    expect(result).toEqual(STOP);
    expect(searchedSince(x, from), 'the server asked for page 2').toEqual([{ q: CUP, page: 2 }]);
    expect(listKeys(out.frames)).toEqual([]);

    const kept = await chainOf(x.store, APP, at.sessionId);
    expect(kept, 'the stopped 换一批 leaves the batch the user saw').toEqual(before);
    expect(kept?.chainId).toBe(before?.chainId);
    expect(kept?.conditions?.page ?? 1, 'still page 1').toBe(1);
    expect(await ordinal(x, at.sessionId, 1)).toEqual({ kind: 'product', productKey: seen[0] });
    expect(await ordinal(x, at.sessionId, seen.length + 1)).toEqual({ kind: 'clarify' });

    x.f.searchProducts.mockImplementation(async () => [x.base]);
    const again = await nextBatch(x, at.sessionId, at.runId);
    expect(again.searched, 'page 2 again, not page 3').toEqual([{ q: CUP, page: 2 }]);
  } finally {
    await x.r.runtime.close();
  }
}, 180_000);
