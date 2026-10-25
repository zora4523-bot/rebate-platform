// B2-15f detail rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-05 ③ (处置前看支付单与
// 渠道请求记录), BR-PAY-06 ③ (退款不改支付单状态，另记 refunded_fen), BR-PAY-08 ④ (不返回渠道侧的用户
// 标识); 规划/04 §6.6, §11.2 (pay.view 只读); contracts/openapi.yaml getAdminPayOrder (pay_order as a
// list row; refunds of target_type pay_order, newest first; query_attempts: the 20 newest channel
// requests of the pay order and its refunds, newest first, kind / result / at only, bodies never
// returned; unknown or other app's id → 20001 data.fields=[pay_order_id]; no audit record).
// Requests go through the real admin entry (kit.ts withAdmin). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, payOrder, suite } from '../orders/kit.ts';
import { jobKit } from '../result/kit.ts';
import { channelRefundNo, seedPaid, seedRefund } from '../refund/kit.ts';
import {
  ATTEMPT_KEYS,
  ORDER_KEYS,
  REFUND,
  REFUND_TIMES,
  adminChannels,
  allAudits,
  answer,
  keysOf,
  normalize,
  ok,
  orderOf,
  orderView,
  payerIds,
  refundView,
  seedAttempt,
  seedNeedsManual,
  withAdmin,
} from './kit.ts';

const s = suite();

const SECOND = 1_000;

it('[AC-B2-15f#19] 支付单详情（pay.view，不要 step-up）：pay_order 与列表行同形；refunds 只列本支付单的退款（新的在前，含备注、状态、渠道退款单号、操作人），已成功的计入 refunded_fen；query_attempts 是本单及其退款最新 20 条渠道请求的 kind / result / at（新的在前），请求与应答原文（含付款人标识）不返回；别的支付单的退款与请求不出现；读取不写审计', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const kit = await jobKit(f, channels);
  const order = await seedPaid(f, kit, 'wechat_pay');
  const other = await seedPaid(f, kit, 'wechat_pay');
  const t0 = f.clock.now().getTime();
  const target = { type: 'pay_order', id: order.id } as const;
  const succeeded = await seedRefund(f, target, {
    amount_fen: 1_000n,
    status: 'SUCCESS',
    channel_refund_no: channelRefundNo('wechat_pay'),
    created_at: new Date(t0 + 30 * SECOND),
    succeeded_at: new Date(t0 + 40 * SECOND),
  });
  const processing = await seedRefund(f, target, {
    amount_fen: 2_000n,
    status: 'PROCESSING',
    note: '用户申请退回部分款项',
    created_at: new Date(t0 + 60 * SECOND),
  });
  const failed = await seedRefund(f, target, {
    amount_fen: 500n,
    reason_code: 'OTHER',
    status: 'FAILED',
    created_at: new Date(t0 + 90 * SECOND),
    failed_at: new Date(t0 + 95 * SECOND),
  });
  const elsewhere = await seedRefund(
    f,
    { type: 'pay_order', id: other.id },
    {
      amount_fen: 700n,
      created_at: new Date(t0 + 120 * SECOND),
    },
  );
  const payer = payerIds();
  type Kind = 'query' | 'close' | 'refund' | 'refund_query';
  const ours: { kind: Kind; result: string; at: number }[] = [];
  for (let i = 0; i < 25; i += 1) {
    const at = t0 + (i + 1) * 7 * SECOND;
    const onRefund = i % 3 === 2;
    const even = i % 2 === 0;
    const kind: Kind = onRefund ? (even ? 'refund' : 'refund_query') : even ? 'query' : 'close';
    const result = i % 4 === 0 ? 'unknown' : 'ok';
    await seedAttempt(
      f,
      onRefund ? { payRefundId: even ? succeeded.id : processing.id } : { payOrderId: order.id },
      {
        kind,
        result,
        at: new Date(at),
        request: { op: kind, out_trade_no: order.out_trade_no },
        response: { kind: 'ok', payer: { openid: payer.openid }, buyer_id: payer.buyerId },
      },
    );
    ours.push({ kind, result, at });
    // Requests of another pay order and of its refund, interleaved in time: never listed.
    await seedAttempt(
      f,
      { payOrderId: other.id },
      {
        kind: 'query',
        result: 'other-order',
        at: new Date(at + 1),
      },
    );
    await seedAttempt(
      f,
      { payRefundId: elsewhere.id },
      {
        kind: 'refund',
        result: 'other-refund',
        at: new Date(at + 2),
      },
    );
  }
  const expectedAttempts = [...ours]
    .sort((x, y) => y.at - x.at)
    .slice(0, 20)
    .map((attempt) => ({ kind: attempt.kind, result: attempt.result, at: attempt.at }));
  const row = await payOrder(f, order.id);
  expect(row.refunded_fen).toBe(1_000n);
  await withAdmin(f, channels, async (h) => {
    const sent = await h.detail(order.id);
    const data = await ok(sent);
    expect(keysOf(data)).toEqual(['pay_order', 'query_attempts', 'refunds']);
    expect(keysOf(data['pay_order'])).toEqual([...ORDER_KEYS]);
    expect(orderOf(data['pay_order'])).toEqual(orderView(row));
    const refunds = data['refunds'] as unknown[];
    expect(refunds.map((refund) => normalize(refund, REFUND_TIMES))).toEqual(
      [failed, processing, succeeded].map(refundView),
    );
    const attempts = data['query_attempts'] as unknown[];
    for (const attempt of attempts) expect(keysOf(attempt)).toEqual([...ATTEMPT_KEYS]);
    expect(attempts.map((attempt) => normalize(attempt, ['at']))).toEqual(expectedAttempts);
    for (const secret of [payer.openid, payer.buyerId, elsewhere.id, elsewhere.out_refund_no]) {
      expect(sent.body).not.toContain(secret);
    }
    expect(sent.body).not.toContain('other-order');
    expect(sent.body).not.toContain('other-refund');
    // A super admin reads it too, without ticking pay.view.
    const root = await h.caller([], { superAdmin: true });
    expect(orderOf((await ok(await h.detail(order.id, root)))['pay_order'])).toEqual(
      orderView(row),
    );
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-15f#20] 详情：needs_manual 的支付单照实显示 PENDING、closing、needs_manual=true，没有退款也没有请求记录时两个列表为空', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const order = await seedNeedsManual(f, 'alipay');
  await withAdmin(f, channels, async (h) => {
    const data = await ok(await h.detail(order.id));
    expect(orderOf(data['pay_order'])).toEqual(orderView(order));
    expect(orderOf(data['pay_order'])).toMatchObject({
      status: 'PENDING',
      closing: true,
      needs_manual: true,
    });
    expect(data['refunds']).toEqual([]);
    expect(data['query_attempts']).toEqual([]);
  });
});

it('[AC-B2-15f#21] 详情的拒绝：不存在的 pay_order_id、其他应用的支付单 → 20001 data.fields=[pay_order_id]（不是 404）；没有 pay.view 10403、不带令牌 10001', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const order = await seedNeedsManual(f, 'wechat_pay');
  const g = await fixture(s);
  const foreign = await seedNeedsManual(g, 'wechat_pay');
  await withAdmin(f, channels, async (h) => {
    for (const id of [randomUUID(), foreign.id]) {
      await answer(await h.detail(id), 20001, { fields: ['pay_order_id'] });
    }
    const refunder = await h.caller([REFUND]);
    await answer(await h.detail(order.id, refunder), 10403);
    await answer(await h.detail(order.id, null), 10001);
  });
  expect(await allAudits(f)).toEqual([]);
});
