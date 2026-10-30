// B2-04lb rule tests, D10-474 ③ (编排裁定): an R9 partial clawback whose cause is a rights success
// also publishes order.clawed_back (EVENT_NAMES), on the same transaction as its CLAWBACK vouchers.
// Payload (暂定, identity to confirm): order_key and beneficiaries [{ user_id, role, clawback_fen }],
// clawback_fen in integer fen as a decimal string. Only these fields are pinned here.
// (This supersedes AC-B2-04l#41's「不发 order.clawed_back」; that frozen test is changed through a
// separate test-change, not here.)
//
// Default order (credit kit), credited at N 1000: 425 / 85 / 42, platform 448. Deduction 400, or the
// union's new commission 600 on a WAIT_COMMISSION record → N_new 600 → B 510 → 255 / 51 / 25:
// clawback 170 / 34 / 17, platform 179.
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { TIMEOUT, databaseFixture, harness, type Harness, type SeededOrder } from './kit.ts';

const p = databaseFixture(createTestDatabase);

/** The order.clawed_back publish calls after call index `from`. */
function clawedBackCalls(h: Harness, from: number) {
  const calls = h.publish.mock.calls.slice(from);
  return calls.filter(([, event]) => event.name === 'order.clawed_back');
}

/** order.clawed_back carries the order key and the three clawbacks 170 / 34 / 17. */
function expectPayload(o: SeededOrder, payload: { readonly [key: string]: unknown }): void {
  expect(payload).toMatchObject({ order_key: o.orderKey });
  const beneficiaries = payload['beneficiaries'];
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
}

it(
  '[AC-B2-04lb#22] D10-474 ③ 入账后维权部分成功（应扣佣金 400）按 R9 扣回 170 / 34 / 17 时也发 order.clawed_back：在 rights.record 的同一事务入队一条，载荷带订单键与三位受益人的扣回额（整数分字符串）',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const published = h.publish.mock.calls.length;
    let recordTrx: Transaction<DB> | undefined;

    const result = await h.record(
      o,
      { deductionFen: 400n },
      {
        after: (t) => {
          recordTrx = t;
          return Promise.resolve();
        },
      },
    );
    expect(result).toEqual({ kind: 'applied' });
    const row = await h.read(o);
    expect(row.rebate_status).toBe('CREDITED');
    expect(row.booked_n_fen).toBe(600n);
    const calls = clawedBackCalls(h, published);
    expect(calls).toHaveLength(1);
    const [trx, event] = calls[0]!;
    expect(recordTrx).toBeDefined();
    expect(trx).toBe(recordTrx);
    expect(event).toMatchObject({ appId: h.appId, name: 'order.clawed_back' });
    expectPayload(o, event.payload);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#23] D10-474 ③ 入账后 WAIT_COMMISSION 之后联盟新佣金 600 经扣回编排的维权成功入口（ref 该维权记录）按 R9 扣回：同事务发一条 order.clawed_back，载荷带订单键与 170 / 34 / 17',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    expect(await h.record(o, { deductionFen: null })).toEqual({ kind: 'applied' });
    const waiting = await h.onlyRights(o);
    expect(waiting).toMatchObject({ status: 'WAIT_COMMISSION' });
    const published = h.publish.mock.calls.length;

    const result = await h.apply(o, {
      cause: 'RIGHTS',
      ref: { kind: 'rights', orderRightsId: waiting.id },
      newCommissionFen: 600n,
    });
    expect(result).toMatchObject({ outcome: 'clawed_back', transition: 'R9' });
    const calls = clawedBackCalls(h, published);
    expect(calls).toHaveLength(1);
    const [trx, event] = calls[0]!;
    expect(trx).toBe(h.transactions.at(-1));
    expectPayload(o, event.payload);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04lb#24] D10-474 ③ 维权原因 R9 的 order.clawed_back 与扣回凭证同事务：入队失败 → rights.record 整体回滚，维权记录、凭证、余额、订单列、历史与事件都回到之前',
  async () => {
    const h = await harness(p.db);
    const o = await h.credited();
    const before = await h.everything();
    h.publish.mockImplementationOnce(async () => {
      throw new Error('injected publish failure');
    });

    const failing = h.record(o, { deductionFen: 400n });
    await expect(failing).rejects.toThrow('injected publish failure');
    expect(await h.everything()).toEqual(before);
  },
  TIMEOUT,
);
