// B3-03b card numbering: one card_id sequence per session shared by card frames and the product
// cards inside them, frame first, then product_list items[] / rebate_quote product in order, never
// reused (规划/04 §8.2 「card」, contracts/agent-stream.schema.json $defs/card_id). Numbers come from
// the CardSequence port (session-wide, possibly other instances), not from a local counter; a card
// whose write fails is not counted as delivered (BR-AI-23 细则: 发送结果不确定时按未下发).
import { expect, it } from 'vitest';
import {
  numberCard,
  type RunConfig,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import {
  IDS,
  fixtureCardFrame,
  frameIsValid,
  framesOf,
  rig,
  streamProblems,
  unnumbered,
} from './kit.ts';

const CONFIG: RunConfig = {
  maxRunMs: 60_000,
  heartbeatMs: 15_000,
  disconnectGraceMs: 30_000,
  guardPollMs: 5_000,
  signalPollMs: 500,
};

function withoutSeq(frameData: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(frameData);
  delete copy['seq'];
  return copy;
}

it('[04 §8.2] numberCard：起号 1 时与 normal 样例的 c1（items c2、c3）、c4 卡（product c5 用起号 4）逐字段一致', () => {
  const list = numberCard(unnumbered(fixtureCardFrame('product_list')), 1);
  expect(list).toEqual({ card: withoutSeq(fixtureCardFrame('product_list')), used: 3 });
  const quote = numberCard(unnumbered(fixtureCardFrame('rebate_quote')), 4);
  expect(quote).toEqual({ card: withoutSeq(fixtureCardFrame('rebate_quote')), used: 2 });
  expect(frameIsValid({ event: 'card', id: 9, data: { seq: 9, ...quote.card } })).toBe(true);
});

it('[04 §8.2] numberCard：起号 5 → 帧 c5、items 依次 c6、c7；不改调用方的对象', () => {
  const input = unnumbered(fixtureCardFrame('product_list'));
  const before = structuredClone(input);
  const out = numberCard(input, 5);
  expect(input).toEqual(before);
  const expected = withoutSeq(fixtureCardFrame('product_list'));
  expected['card_id'] = 'c5';
  const items = (expected['data'] as { items: { card_id: string }[] }).items;
  items[0]!.card_id = 'c6';
  items[1]!.card_id = 'c7';
  expect(out).toEqual({ card: expected, used: 3 });
});

it('[04 §8.2] numberCard：空 items 用 1 个号；其他类型（含未知类型带 items）只给帧取号、不动内嵌数据', () => {
  const empty = unnumbered(fixtureCardFrame('product_list'));
  (empty.data as { items: unknown[] }).items = [];
  expect(numberCard(empty, 12).used).toBe(1);
  expect(numberCard(empty, 12).card.card_id).toBe('c12');
  const notice = {
    type: 'notice',
    schema_version: 1,
    data: { level: 'info', text_key: 'agent.degraded.empty', actions: [] },
    fallback_text: '没有找到合适的商品',
  };
  expect(numberCard(structuredClone(notice), 3)).toEqual({
    card: { ...notice, card_id: 'c3' },
    used: 1,
  });
  const unknown = {
    type: 'future_card',
    schema_version: 2,
    data: { items: [{ title: '甲' }, { title: '乙' }], product: { title: '丙' } },
    fallback_text: '请升级后查看',
  };
  expect(numberCard(structuredClone(unknown), 7)).toEqual({
    card: { ...unknown, card_id: 'c7' },
    used: 1,
  });
});

it('[04 §8.2][BR-AI-05] RunManager 用 CardSequence 返回的首号（另一实例可能已用过中间的号），按本卡用号数 reserve', async () => {
  const r = rig({ config: CONFIG, cardFirsts: [5, 40] });
  const seen: number[] = [];
  const p = r.manager.start(r.start, async (ctx) => {
    seen.push(ctx.cardsDelivered);
    await ctx.card(unnumbered(fixtureCardFrame('product_list')));
    seen.push(ctx.cardsDelivered);
    await ctx.card(unnumbered(fixtureCardFrame('rebate_quote')));
    seen.push(ctx.cardsDelivered);
    return { kind: 'done', finishReason: 'stop' };
  });
  expect(await r.time.drive(p, 1_000)).toBe(true);
  expect(r.cards.calls).toEqual([
    { sessionId: IDS.session, count: 3 },
    { sessionId: IDS.session, count: 2 },
  ]);
  const cards = framesOf(r.sink.chunks).filter((f) => f.event === 'card');
  const ids = cards.map((f) => {
    const data = f.data['data'] as { items?: { card_id: string }[]; product?: { card_id: string } };
    return [f.data['card_id'], ...(data.items ?? []).map((x) => x.card_id), data.product?.card_id];
  });
  expect(ids).toEqual([
    ['c5', 'c6', 'c7', undefined],
    ['c40', 'c41'],
  ]);
  expect(seen).toEqual([0, 1, 2]);
  expect(streamProblems(framesOf(r.sink.chunks))).toEqual([]);
  expect(r.admission.calls.map((x) => x.outcome)).toEqual([{ ending: 'stop', cardsDelivered: 2 }]);
});

it('[BR-AI-23 细则「受理记录与收尾」] 卡片写入失败（发送结果不确定）不计已下发；settle 仍恰好一次', async () => {
  const r = rig({ config: CONFIG });
  r.sink.failAt = 3; // meta, card 1 succeed; the second card's write throws
  const p = r.manager.start(r.start, async (ctx) => {
    await ctx.card(unnumbered(fixtureCardFrame('product_list')));
    await ctx.card(unnumbered(fixtureCardFrame('rebate_quote'))).catch(() => undefined);
    return { kind: 'done', finishReason: 'stop' };
  });
  expect(await r.time.drive(p, 1_000)).toBe(true);
  expect(r.admission.calls.map((x) => x.outcome)).toEqual([{ ending: 'stop', cardsDelivered: 1 }]);
  expect(await p).toEqual({
    terminal: { event: 'done', data: { finish_reason: 'stop', quota_left: 17 } },
    ending: 'stop',
    cardsDelivered: 1,
  });
  expect(framesOf(r.sink.chunks).map((f) => f.event)).toEqual(['meta', 'card']);
});
