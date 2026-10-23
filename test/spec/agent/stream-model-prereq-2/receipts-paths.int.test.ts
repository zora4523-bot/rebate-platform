// B3-03p §9 item 1 · BR-AI-05 on the production stream entry (app.module, no_model route): the
// no-model keyword search's product cards are recorded in the PG result store like the model
// path's, in delivery order, under their run; the same session's 「第 N 个」 then addresses the
// newest batch and any delivered card_id still resolves. Real runtime + PG; demo adapter only
// (stream-assembly kits, unchanged).
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createReferenceResolver } from '../../../../apps/api/src/modules/agent/orchestrator/results/index.ts';
import { createPgResultSetStore } from '../../../../apps/api/src/modules/agent/store/results/index.ts';
import type { ToolCallContext } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import { framesOf, message, openSession, send, usePgEach, type Row } from '../stream-mount/kit.ts';
import { APP } from '../stream-assembly/kit.ts';
import { production } from '../stream-assembly/regression-kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

type Production = Awaited<ReturnType<typeof production>>;

interface Shown {
  readonly card_id: string;
  readonly product_key: string;
  readonly platform: string;
  readonly final_price_fen: number;
}

/** One message on the no_model route: exactly one product_list, run ends fallback. */
async function degradedSearch(r: Production, sessionId: string) {
  const frames = framesOf((await send(r, r.caller, sessionId, message('演示商品'))).chunks);
  const lists = frames.filter(
    (frame) => frame.event === 'card' && frame.data['type'] === 'product_list',
  );
  expect(lists).toHaveLength(1);
  expect(frames.at(-1)?.data['finish_reason']).toBe('fallback');
  const list = lists[0]!;
  const items = ((list.data['data'] as Row)['items'] as Row[]).map(
    (item): Shown => ({
      card_id: item['card_id'] as string,
      product_key: item['product_key'] as string,
      platform: item['platform'] as string,
      final_price_fen: item['final_price_fen'] as number,
    }),
  );
  expect(items.length).toBeGreaterThan(0);
  return { frameCardId: list.data['card_id'] as string, items };
}

it('[AC-B3-03p#7][BR-AI-05][BR-AI-14] 生产 stream 入口无模型降级搜索下发的商品卡按下发顺序记进 PG 结果集；同会话第二批后「第 N 个」指向第二批，第一批仍可按 card_id 引用', async () => {
  const r = await production(pg.db);
  try {
    const sessionId = await openSession(r, r.caller);
    const first = await degradedSearch(r, sessionId);
    const second = await degradedSearch(r, sessionId);

    const rows = await pg.db
      .selectFrom('agent_result_deliveries')
      .select([
        'result_set_id',
        'run_id',
        'position',
        'card_id',
        'product_key',
        'platform',
        'final_price_fen',
      ])
      .where('app_id', '=', APP)
      .where('session_id', '=', sessionId)
      .execute();
    const runs = await pg.db
      .selectFrom('agent_runs')
      .select('id')
      .where('session_id', '=', sessionId)
      .execute();
    expect(runs).toHaveLength(2);
    expect(rows).toHaveLength(first.items.length + second.items.length);
    const batches = [first, second].map((batch) => {
      const mine = batch.items.map((item) => rows.find((row) => row.card_id === item.card_id));
      expect(
        mine.map((row) =>
          row === undefined
            ? undefined
            : {
                card_id: row.card_id,
                product_key: row.product_key,
                platform: row.platform,
                final_price_fen: Number(row.final_price_fen),
              },
        ),
      ).toEqual(batch.items);
      // One result set and one run per batch, positions in delivery order.
      expect(new Set(mine.map((row) => row?.result_set_id)).size).toBe(1);
      expect(new Set(mine.map((row) => row?.run_id)).size).toBe(1);
      expect(mine.map((row) => row?.position)).toEqual(batch.items.map((_, index) => index + 1));
      return { resultSetId: mine[0]?.result_set_id, runId: mine[0]?.run_id };
    });
    expect(batches[1]?.resultSetId).not.toBe(batches[0]?.resultSetId);
    expect(batches[1]?.runId).not.toBe(batches[0]?.runId);
    expect(runs.map((run) => run.id).sort()).toEqual(batches.map((batch) => batch.runId).sort());

    const store = createPgResultSetStore({ db: pg.db });
    const latest = await store.latestWithProducts(APP, sessionId);
    expect(latest?.delivered.map((item) => item.card_id)).toEqual(
      second.items.map((item) => item.card_id),
    );
    const resolver = createReferenceResolver({ store });
    const next: ToolCallContext = {
      appId: APP,
      userId: r.caller.userId,
      deviceId: r.caller.deviceId,
      phoneBound: r.caller.phoneBound,
      runId: 'synthetic-next-run',
      sessionId,
      signal: new AbortController().signal,
      placeholders: {},
    };
    for (const [index, item] of second.items.entries()) {
      const ordinal = index + 1;
      expect(await resolver.resolve({ ref_ordinal: ordinal }, next), String(ordinal)).toEqual({
        kind: 'product',
        productKey: item.product_key,
      });
    }
    expect(await resolver.resolve({ ref_ordinal: second.items.length + 1 }, next)).toEqual({
      kind: 'clarify',
    });
    for (const item of [...first.items, ...second.items]) {
      expect(await resolver.resolve({ card_id: item.card_id }, next), item.card_id).toEqual({
        kind: 'product',
        productKey: item.product_key,
      });
    }
    for (const cardId of [first.frameCardId, second.frameCardId]) {
      expect(await resolver.resolve({ card_id: cardId }, next), cardId).toEqual({
        kind: 'invalid_args',
      });
    }
  } finally {
    await r.app.close();
  }
}, 120_000);
