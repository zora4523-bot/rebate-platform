// B3-03n §9 item 1 · BR-AI-05, through the stream runtime: the body the runtime builds must carry
// the business assembly's result store as the core's delivery receipt port, so a product card the
// model path delivered is found again by get_rebate_quote's card_id / ref_ordinal in the same
// session. Real runtime + PG; demo adapter and synthetic DTOs only (stream-assembly kits, unchanged).
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import * as core from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { ToolOutcome } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
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
import { callTool, production } from '../stream-assembly/regression-kit.ts';
import { deliveredProducts, modelPath, receiptContext, type Round } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

function searchRounds(q: string): Round[] {
  return [{ calls: [{ name: 'search_products', args: { q } }] }, { text: '好的。' }];
}

function quotedProduct(outcome: ToolOutcome): Row | undefined {
  if (outcome.kind !== 'ok') return undefined;
  const card = outcome.cards.find((entry) => entry.type === 'rebate_quote');
  return card?.data['product'] as Row | undefined;
}

it('[AC-B3-03n#2][BR-AI-05] stream 运行时把业务装配的结果集接成 core 出卡回执：模型路径出的商品卡随后按 card_id / 第 N 个报价都解析到该商品', async () => {
  const f = await fixture(pg.db);
  const assembly = f.build();
  const body = vi.spyOn(core, 'createAgentRunBody');
  const r = f.mount(assembly);
  try {
    expect(body).toHaveBeenCalledTimes(1);
    const deps = body.mock.calls[0]![0];
    const sessionId = await openSession(r, f.caller);
    const ctx = f.context(sessionId);
    const out = receiptContext({ runId: ctx.runId, sessionId });
    const result = await core.createAgentRunBody({
      ...deps,
      ...modelPath(searchRounds('保温杯')),
      inputCheck: passInput,
    })(request(ctx, '保温杯').input)(out.ctx);
    expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
    const shown = deliveredProducts(out.frames);
    expect(shown).toEqual([
      expect.objectContaining({ product_key: 'tb:synthetic-cup', final_price_fen: 10000 }),
    ]);
    const cardId = shown[0]!.card_id;

    // The receipt reached the assembly's shared store, scoped to this app and session.
    const found = await assembly.results.findDelivered(APP, sessionId, cardId);
    expect(found, 'receipt in the shared result store').not.toBeNull();
    expect(found).toMatchObject({
      card_id: cardId,
      product_key: 'tb:synthetic-cup',
      platform: 'taobao',
      final_price_fen: 10000,
    });
    expect(await assembly.results.findDelivered('another-app', sessionId, cardId)).toBeNull();

    for (const args of [{ card_id: cardId }, { ref_ordinal: 1 }]) {
      const outcome = await callTool(deps.tools, f.context(sessionId), 'get_rebate_quote', args);
      expect(outcome.kind, JSON.stringify(args)).toBe('ok');
      expect(quotedProduct(outcome), JSON.stringify(args)).toMatchObject({
        product_key: 'tb:synthetic-cup',
        final_price_fen: 10000,
      });
    }
    expect(f.readProduct).toHaveBeenCalledTimes(2);
  } finally {
    await r.runtime.close();
  }
}, 120_000);

it('[AC-B3-03n#2][BR-AI-04][BR-AI-05] 生产 stream 入口：模型路径出商品卡后回执按下发顺序写进 PG 结果集，随后 card_id / 第 N 个报价解析到该商品并现查', async () => {
  const r = await production(pg.db);
  try {
    const sessionId = await openSession(r, r.caller);
    // A real run of this session that searches nothing (token path, parsing off): the result
    // set saved by the model's search belongs to it.
    await setConfig(pg.db, APP, 'parse.tpwd.enabled', false);
    const first = framesOf((await send(r, r.caller, sessionId, message(TOKEN))).chunks);
    expect(first.at(-1)?.data['finish_reason']).toBe('stop');
    const runs = await pg.db
      .selectFrom('agent_runs')
      .select('id')
      .where('session_id', '=', sessionId)
      .execute();
    expect(runs).toHaveLength(1);
    const ctx = { ...r.context(sessionId), runId: runs[0]!.id };
    const out = receiptContext({ runId: ctx.runId, sessionId, firstNo: 101 });
    const result = await core.createAgentRunBody({
      ...r.body,
      ...modelPath(searchRounds('演示商品')),
      inputCheck: passInput,
    })(request(ctx, '演示商品').input)(out.ctx);
    expect(result).toEqual({ kind: 'done', finishReason: 'stop' });
    const shown = deliveredProducts(out.frames);
    expect(shown.length).toBeGreaterThan(0);

    const rows = await pg.db
      .selectFrom('agent_result_deliveries')
      .select(['result_set_id', 'run_id', 'card_id', 'product_key', 'platform', 'final_price_fen'])
      .where('app_id', '=', APP)
      .where('session_id', '=', sessionId)
      .orderBy('position', 'asc')
      .execute();
    expect(
      rows.map((row) => ({
        resultSetId: row.result_set_id,
        card_id: row.card_id,
        product_key: row.product_key,
        platform: row.platform,
        final_price_fen: Number(row.final_price_fen),
      })),
    ).toEqual(shown);
    expect(rows.every((row) => row.run_id === ctx.runId)).toBe(true);

    const target = shown[0]!;
    for (const args of [{ card_id: target.card_id }, { ref_ordinal: 1 }]) {
      const outcome = await callTool(r.body.tools, r.context(sessionId), 'get_rebate_quote', args);
      expect(outcome.kind, JSON.stringify(args)).toBe('ok');
      expect(quotedProduct(outcome)?.['product_key'], JSON.stringify(args)).toBe(
        target.product_key,
      );
    }
  } finally {
    await r.app.close();
  }
}, 120_000);
