// B2-04lb rule tests, D10-467 ② (随本单做): an R9 partial-refund clawback (BR-FUND-08 R9, cause
// PARTIAL_REFUND, sub_type PART_REFUND) also publishes the domain event order.clawed_back (EVENT_NAMES,
// 规划/02 §11), on the same transaction as its CLAWBACK vouchers, so identity's CLAWBACK station
// message (B1-12s) can fan out per beneficiary. The payload carries the order key and each
// beneficiary's clawback amount in integer fen (as a decimal string, like order.credited's
// booked_base_fen); the payload field names below are the test author's choice, listed for the
// orchestrator. The R9 of a rights partial result is not covered here (AC-B2-04l#41 pins that it
// publishes no order.clawed_back).
//
// Default order (credit kit), credited at N 1000 (425 / 85 / 42, platform 448); commission version
// moved to 5, new commission 600 → B 510 → 255 / 51 / 25: clawback 170 / 34 / 17, platform 179,
// rights_event_id C5.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { TIMEOUT, databaseFixture, harness } from './kit.ts';

const p = databaseFixture(createTestDatabase);

const PARTIAL_REFUND_600 = {
  cause: 'PARTIAL_REFUND',
  ref: { kind: 'commission' },
  newCommissionFen: 600n,
} as const;

it(
  '[AC-B2-04lb#12] R9 部分退款扣回（N 1000 → 600，键 C5）补发 order.clawed_back：同事务入队一条，载荷带订单 id、订单键、rights_event_id 与三位受益人的扣回额 170 / 34 / 17（整数分字符串）',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    await h.bumpCommissionVersion(o, 5);
    const published = h.publish.mock.calls.length;

    expect(await h.apply(o, PARTIAL_REFUND_600)).toMatchObject({
      outcome: 'clawed_back',
      transition: 'R9',
      rightsEventId: 'C5',
    });
    expect(h.publishedSince(published)).toEqual(['order.clawed_back']);
    const call = h.publish.mock.calls.at(-1);
    expect(call).toBeDefined();
    const [trx, event] = call!;
    expect(trx).toBe(h.transactions.at(-1));
    expect(event).toMatchObject({
      appId: h.appId,
      name: 'order.clawed_back',
      payload: {
        order_id: o.orderId,
        order_key: o.orderKey,
        rights_event_id: 'C5',
      },
    });
    const beneficiaries = event.payload['beneficiaries'];
    expect(beneficiaries).toHaveLength(3);
    expect(beneficiaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user_id: o.user('self'), role: 'self', clawback_fen: '170' }),
        expect.objectContaining({ user_id: o.user('direct'), role: 'direct', clawback_fen: '34' }),
        expect.objectContaining({
          user_id: o.user('indirect'),
          role: 'indirect',
          clawback_fen: '17',
        }),
      ]),
    );
    expect((await h.published()).filter((e) => e.name === 'order.clawed_back')).toHaveLength(1);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#13] R9 部分退款的 order.clawed_back 与扣回凭证同事务：入队失败 → 整个扣回回滚，凭证、余额、订单列、历史与事件都回到扣回前',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    await h.bumpCommissionVersion(o, 5);
    const before = await h.everything();
    h.publish.mockImplementationOnce(async () => {
      throw new Error('injected publish failure');
    });

    await expect(h.apply(o, PARTIAL_REFUND_600)).rejects.toThrow('injected publish failure');
    expect(await h.everything()).toEqual(before);
  },
  TIMEOUT,
);
