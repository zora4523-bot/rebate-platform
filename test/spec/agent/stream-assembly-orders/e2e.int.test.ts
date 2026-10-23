// B3-08g · BR-AI-03 / BR-AI-07 end to end on the production stream assembly (real PG for config,
// sessions and agent_cards; orders, link_logs and the counter are recording stand-ins). The model
// tools are called through assembly.tools exactly as the core calls them (card call scope open).
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { item, selfDetail } from '../tools-orders/kit.ts';
import { newMember, usePgEach } from '../stream-mount/kit.ts';
import {
  APP,
  callTool,
  cardsOf,
  insertCard,
  insertRun,
  ordersFixture,
  sessionOf,
  type OrderDetail,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

const ORDER_NO = '3900112233445566778';
const ORDER_ID = '0192f3a1-7c00-7000-8000-00000000d001';

it('[AC-B3-08g#11][BR-AI-07] 已绑手机 explain_order {order_no, platform}，本人名下查无此单 → 恰 1 张 claim_draft、无 order_status；按单号计数扣 1', async () => {
  const f = await ordersFixture(pg.db);
  const assembly = f.build();
  const ctx = f.contextOf(f.caller);
  const outcome = await callTool(assembly.tools, ctx, 'explain_order', {
    order_no: ORDER_NO,
    platform: 'taobao',
  });
  const cards = cardsOf(outcome);
  expect(cards.map((card) => card.type)).toEqual(['claim_draft']);
  expect(cards[0]?.data).toMatchObject({ platform: 'taobao', order_no: ORDER_NO });
  expect(f.findOwnByNumber).toHaveBeenCalledTimes(1);
  expect(f.findOwnByNumber).toHaveBeenCalledWith(
    { app_id: APP, user_id: f.caller.userId },
    { order_no: ORDER_NO, platform: 'taobao' },
  );
  // One number lookup counted against this user of this app.
  expect(f.daily.incr).toHaveBeenCalledTimes(1);
  const [key] = f.daily.incr.mock.calls[0]!;
  expect(key).toContain(APP);
  expect(key).toContain(f.caller.userId!);
  // The draft's click times are read for the caller only.
  expect(f.read).toHaveBeenCalledWith(
    expect.objectContaining({ app_id: APP, user_id: f.caller.userId }),
  );
  expect(f.get).not.toHaveBeenCalled();
}, 120_000);

it('[AC-B3-08g#12][BR-AI-07] list_my_orders 查到 0 笔 → 恰 1 张 handoff 卡；不计按单号次数', async () => {
  const f = await ordersFixture(pg.db);
  const assembly = f.build();
  const outcome = await callTool(assembly.tools, f.contextOf(f.caller), 'list_my_orders', {
    date_from: '2026-10-01',
    date_to: '2026-10-06',
  });
  expect(cardsOf(outcome).map((card) => card.type)).toEqual(['handoff']);
  expect(f.searchForAgent).toHaveBeenCalledTimes(1);
  expect(f.searchForAgent).toHaveBeenCalledWith(
    { app_id: APP, user_id: f.caller.userId },
    expect.objectContaining({ date_from: '2026-10-01', date_to: '2026-10-06' }),
  );
  expect(f.daily.incr).not.toHaveBeenCalled();
}, 120_000);

it('[AC-B3-08g#12][BR-AI-03][BR-AI-07] explain_order {card_id} 引用本会话上一轮已落库的 order_status 卡 → orders.get 收到该 order_id，出 order_status 卡，不扣按单号次数；别的会话同号卡 → rejected', async () => {
  const f = await ordersFixture(pg.db);
  const sessionId = await sessionOf(pg.db, f.caller);
  const runId = await insertRun(pg.db, sessionId);
  await insertCard(pg.db, {
    sessionId,
    runId,
    cardId: 'c2',
    type: 'order_status',
    data: { ...item({ order_id: ORDER_ID }) },
  });
  const detail: OrderDetail = { ...selfDetail(), order_id: ORDER_ID };
  f.get.mockImplementation(async (_subject, orderId) => (orderId === ORDER_ID ? detail : null));
  const assembly = f.build();

  const ctx = f.contextOf(f.caller, sessionId);
  const outcome = await callTool(assembly.tools, ctx, 'explain_order', { card_id: 'c2' });
  const cards = cardsOf(outcome);
  expect(cards.map((card) => card.type)).toEqual(['order_status']);
  expect(cards[0]?.data['order_id']).toBe(ORDER_ID);
  expect(f.get).toHaveBeenCalledTimes(1);
  expect(f.get).toHaveBeenCalledWith({ app_id: APP, user_id: f.caller.userId }, ORDER_ID);
  expect(f.daily.incr).not.toHaveBeenCalled();
  expect(f.findOwnByNumber).not.toHaveBeenCalled();

  // The same card_id from another session of the same user resolves to nothing.
  const elsewhere = f.contextOf(f.caller, randomUUID());
  const other = await callTool(assembly.tools, elsewhere, 'explain_order', { card_id: 'c2' });
  expect(other).toEqual({ kind: 'rejected', modelView: { error: 'invalid_args' } });
  expect(f.get).toHaveBeenCalledTimes(1);
}, 120_000);

it('[AC-B3-08g#13][BR-AI-03] prefill_claim 的 claimEntries.read 收到的 app_id / user_id 恒为调用上下文的值；参数带身份字段 → rejected，不读外跳日志', async () => {
  const f = await ordersFixture(pg.db);
  const second = await newMember(pg.db);
  const assembly = f.build();
  for (const subject of [f.caller, second]) {
    const outcome = await callTool(assembly.tools, f.contextOf(subject), 'prefill_claim', {
      platform: 'taobao',
      order_no: ORDER_NO,
    });
    expect(cardsOf(outcome).map((card) => card.type)).toEqual(['claim_draft']);
    expect(f.read).toHaveBeenLastCalledWith(
      expect.objectContaining({ app_id: APP, user_id: subject.userId }),
    );
  }
  expect(f.read).toHaveBeenCalledTimes(2);

  for (const field of ['user_id', 'app_id', 'device_id']) {
    const forged = await callTool(assembly.tools, f.contextOf(f.caller), 'prefill_claim', {
      platform: 'taobao',
      order_no: ORDER_NO,
      [field]: second.userId,
    });
    expect(forged, field).toEqual({ kind: 'rejected', modelView: { error: 'invalid_args' } });
  }
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.logs.lines.join('\n')).toContain('agent.identity_arg');
}, 120_000);
