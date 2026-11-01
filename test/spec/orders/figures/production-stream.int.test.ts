// B1-09p · 生产装配（stream 入口）：真实 stream AppModule 提供的 orders 端口接到生产流式装配，
// list_my_orders 出的 order_status 卡片带真实金额与结算月份。骨架上 stream 入口仍回落
// createUnknownOrderFigures，所以红在断言。
import { createTestDatabase } from '@couli/db/testing';
import { afterEach, expect, it, vi } from 'vitest';
import {
  bootStream,
  callTool,
  cardsOf,
  ordersFixture,
  present,
} from '../../agent/stream-assembly-orders/kit.ts';
import { usePgEach } from '../../agent/stream-mount/kit.ts';
import { fixture, waiting, type OrderPatch } from './kit.ts';

const pg = usePgEach(createTestDatabase);
afterEach(() => vi.restoreAllMocks());

// ManualTime starts at 2026-10-06T02:00:00Z.
const PAID_AT = '2026-09-10T02:00:00.000Z';
const DAYS = { date_from: '2026-09-10', date_to: '2026-09-10' };
/** settle_period 2026-09 → expected 2026-10, deadline 2026-11-03: not overdue at the clock. */
const open: OrderPatch = { paid_at: PAID_AT, settle_period: '2026-09' };

it('[AC-B1-09p#58][BR-AI-07][BR-FUND-04] 生产 list_my_orders：8 张 order_status 卡金额、月份各归各单', async () => {
  const f = await ordersFixture(pg.db);
  const userId = present(f.caller.userId, 'the caller is a member');
  const seeded = await fixture(pg.db, {
    now: f.time.clock.now().toISOString(),
    subject: { app_id: f.caller.appId, user_id: userId },
  });
  const expected = new Map<string, unknown>();
  for (const [index, est] of [425, 850, 1275, 1700, 2125, 2550, 2975, 3400].entries()) {
    const o = await seeded.order({
      patch: waiting({ ...open, est_commission_fen: 1000n * BigInt(index + 1) }),
    });
    expected.set(o.orderId, { est_rebate_fen: est, expected_credit_period: '2026-10' });
  }
  const { app, ports } = await bootStream({ db: pg.db, time: f.time, logs: f.logs });
  try {
    const orders = present(present(ports, 'stream ports').orders, 'ports.orders');
    f.searchForAgent.mockImplementation((subject, filter) =>
      orders.searchForAgent(subject, filter),
    );
    const outcome = await callTool(f.build().tools, f.contextOf(f.caller), 'list_my_orders', DAYS);
    const cards = cardsOf(outcome).filter((card) => card.type === 'order_status');
    expect(cards).toHaveLength(8);
    expect(
      new Map(
        cards.map((card) => [
          card.data['order_id'],
          {
            est_rebate_fen: card.data['est_rebate_fen'],
            expected_credit_period: card.data['expected_credit_period'],
          },
        ]),
      ),
    ).toEqual(expected);
  } finally {
    await app.close();
  }
}, 120_000);

it('[AC-B1-09p#59][BR-FUND-17] 生产 stream 端口：详情与按单号查走同一读取器，派生状态用真实数据', async () => {
  const f = await ordersFixture(pg.db);
  const userId = present(f.caller.userId, 'the caller is a member');
  const subject = { app_id: f.caller.appId, user_id: userId };
  const seeded = await fixture(pg.db, { now: f.time.clock.now().toISOString(), subject });
  const empty = await seeded.order({ patch: { paid_at: PAID_AT, est_commission_fen: 0n } });
  const waitingOrder = await seeded.order({ patch: waiting(open) });
  const { app, ports } = await bootStream({ db: pg.db, time: f.time, logs: f.logs });
  try {
    const orders = present(present(ports, 'stream ports').orders, 'ports.orders');
    expect(await orders.get(subject, empty.orderId)).toMatchObject({
      display_status: 'NO_REBATE',
      est_rebate_fen: null,
    });
    expect(await orders.get(subject, waitingOrder.orderId)).toMatchObject({
      display_status: 'WAITING',
      est_rebate_fen: 425,
      expected_credit_period: '2026-10',
    });
    const found = await orders.findOwnByNumber(subject, { order_no: waitingOrder.subOrderId });
    expect(found.map((item) => item.est_rebate_fen)).toEqual([425]);
  } finally {
    await app.close();
  }
}, 120_000);
