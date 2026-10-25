// B2-15f list rule tests (claude-independent, SPEC_REF 736d24c5): 08 BR-PAY-05 ③④ (needs_manual 的
// 支付单与异常收款在后台可查), BR-PAY-08 ④ (不返回渠道侧的用户标识); 规划/04 §6.6 (pay-orders), §11.2
// (pay.view 只读、不要 step-up); contracts/openapi.yaml listAdminPayOrders (filters status,
// pay_channel, biz_type, user_id, out_trade_no, needs_manual, created_from inclusive / created_to
// exclusive, combined with AND; created_at descending; page_size ≤ 200; 20001 data.fields naming
// the parameter; no audit record) and listAdminPayAnomalies (filter pay_channel; created_at
// descending; evidence not returned).
// Requests go through the real admin entry (kit.ts withAdmin). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, payOrder, seedOrder, suite } from '../orders/kit.ts';
import { tradeNo } from '../result/kit.ts';
import {
  AMOUNT,
  REFUND,
  RESOLVE,
  adminChannels,
  allAudits,
  anomalyView,
  answer,
  cst,
  orderOf,
  orderView,
  page,
  payerIds,
  seedAnomalyRow,
  seedNeedsManual,
  withAdmin,
  type AdminHarness,
} from './kit.ts';

const s = suite();

const MINUTE = 60_000;

/** The pay order ids of a list query, in the order returned; total checked against them. */
async function idsOf(
  h: AdminHarness,
  query: Record<string, string>,
  expected: { readonly total: number },
): Promise<unknown[]> {
  const data = await page(await h.list(query));
  expect(data.total, JSON.stringify(query)).toBe(expected.total);
  return data.items.map((item) => item['pay_order_id']);
}

it('[AC-B2-15f#15] 支付单列表（pay.view，不要 step-up）：本应用的支付单按 created_at 倒序，每行就是契约的 AdminPayOrder（我方 user_id、业务类型与对象、渠道、金额与已退金额、状态、商户单号与渠道交易号、needs_manual、closing、各时刻）；status / pay_channel / biz_type / user_id / out_trade_no / needs_manual / created_from（含）/ created_to（不含）按 AND 过滤，total 为过滤后的总数；分页默认 1 / 20；其他应用的支付单不出现；读取不写审计', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const now = f.clock.now().getTime();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * MINUTE);
  const stranger = await f.stranger();
  // a: the needs_manual order (created 76 minutes ago).
  const a = await seedNeedsManual(f, 'wechat_pay');
  const b = await seedOrder(f, {
    pay_channel: 'alipay',
    amount_fen: AMOUNT,
    status: 'PAID',
    channel_trade_no: tradeNo('alipay'),
    refunded_fen: 500n,
    created_at: at(50),
    expire_at: at(35),
    launch_issued_at: at(50),
    paid_at: at(49),
  });
  const c = await seedOrder(f, {
    pay_channel: 'wechat_pay',
    amount_fen: AMOUNT,
    status: 'CLOSED',
    created_at: at(40),
    expire_at: at(25),
    closed_at: at(20),
    close_reason: 'user_cancel',
  });
  const d = await seedOrder(f, {
    pay_channel: 'alipay',
    amount_fen: 1_900n,
    user_id: stranger.user_id,
    created_at: at(10),
    expire_at: new Date(now + 5 * MINUTE),
    launch_issued_at: at(9),
  });
  const e = await seedOrder(f, {
    pay_channel: 'wechat_pay',
    amount_fen: AMOUNT,
    status: 'PAID',
    channel_trade_no: tradeNo('wechat_pay'),
    biz_type: 'other_item',
    created_at: at(5),
    expire_at: new Date(now + 10 * MINUTE),
    launch_issued_at: at(5),
    paid_at: at(4),
  });
  const g = await fixture(s);
  await seedNeedsManual(g, 'wechat_pay');
  await seedOrder(g, { pay_channel: 'alipay', amount_fen: AMOUNT, created_at: at(1) });
  const rows = await Promise.all([e, d, c, b, a].map((row) => payOrder(f, row.id)));
  await withAdmin(f, channels, async (h) => {
    const all = await page(await h.list());
    expect({ page: all.page, page_size: all.page_size, total: all.total }).toEqual({
      page: 1,
      page_size: 20,
      total: 5,
    });
    expect(all.items.map(orderOf)).toEqual(rows.map(orderView));
    expect(await idsOf(h, { status: 'PAID' }, { total: 2 })).toEqual([e.id, b.id]);
    expect(await idsOf(h, { status: 'PENDING' }, { total: 2 })).toEqual([d.id, a.id]);
    expect(await idsOf(h, { pay_channel: 'alipay' }, { total: 2 })).toEqual([d.id, b.id]);
    expect(await idsOf(h, { biz_type: 'other_item' }, { total: 1 })).toEqual([e.id]);
    expect(await idsOf(h, { user_id: stranger.user_id }, { total: 1 })).toEqual([d.id]);
    expect(await idsOf(h, { user_id: randomUUID() }, { total: 0 })).toEqual([]);
    expect(await idsOf(h, { out_trade_no: c.out_trade_no }, { total: 1 })).toEqual([c.id]);
    expect(await idsOf(h, { needs_manual: 'true' }, { total: 1 })).toEqual([a.id]);
    expect(await idsOf(h, { needs_manual: 'false' }, { total: 4 })).toEqual([
      e.id,
      d.id,
      c.id,
      b.id,
    ]);
    const range = { created_from: cst(b.created_at), created_to: cst(e.created_at) };
    expect(await idsOf(h, range, { total: 3 })).toEqual([d.id, c.id, b.id]);
    const both = { status: 'PENDING', pay_channel: 'wechat_pay' };
    expect(await idsOf(h, both, { total: 1 })).toEqual([a.id]);
    const none = { status: 'CLOSED', pay_channel: 'alipay' };
    expect(await idsOf(h, none, { total: 0 })).toEqual([]);
    const second = await page(await h.list({ page: '2', page_size: '2' }));
    expect({ page: second.page, page_size: second.page_size, total: second.total }).toEqual({
      page: 2,
      page_size: 2,
      total: 5,
    });
    expect(second.items.map((item) => item['pay_order_id'])).toEqual([c.id, b.id]);
    // A super admin reads it too, without ticking pay.view.
    const root = await h.caller([], { superAdmin: true });
    expect((await page(await h.list({}, root))).total).toBe(5);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-15f#16] 支付单列表的拒绝：取值不在枚举的 status / pay_channel → 20001 data.fields 指名该参数；created_from 晚于 created_to → 20001 data.fields=[created_from, created_to]；page_size 超过 200 → 20001；没有 pay.view（只有 pay.refund 或 pay.resolve）10403，不带令牌 10001', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  await seedNeedsManual(f, 'wechat_pay');
  const now = f.clock.now();
  await withAdmin(f, channels, async (h) => {
    await answer(await h.list({ status: 'REFUNDED' }), 20001, { fields: ['status'] });
    await answer(await h.list({ pay_channel: 'unionpay' }), 20001, { fields: ['pay_channel'] });
    await answer(
      await h.list({
        created_from: cst(now),
        created_to: cst(new Date(now.getTime() - MINUTE)),
      }),
      20001,
      { fields: ['created_from', 'created_to'] },
    );
    await answer(await h.list({ page_size: '201' }), 20001);
    const refunder = await h.caller([REFUND]);
    await answer(await h.list({}, refunder), 10403);
    const resolverOnly = await h.caller([RESOLVE]);
    await answer(await h.list({}, resolverOnly), 10403);
    await answer(await h.list({}, null), 10001);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-15f#17] 异常收款列表（pay.view）：本应用的异常收款按 created_at 倒序，每行就是契约的 AdminPayAnomaly（渠道、渠道交易号、商户单号、我方支付单或 null、收款金额与已退金额、状态）；登记时留存的证据（含付款人标识）不返回；pay_channel 过滤、分页；其他应用的异常收款不出现；读取不写审计', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  const now = f.clock.now().getTime();
  const payer = payerIds();
  const closed = await seedOrder(f, {
    pay_channel: 'wechat_pay',
    amount_fen: AMOUNT,
    status: 'CLOSED',
    created_at: new Date(now - 90 * MINUTE),
    expire_at: new Date(now - 75 * MINUTE),
    closed_at: new Date(now - 70 * MINUTE),
  });
  const x = await seedAnomalyRow(f, {
    channel: 'wechat_pay',
    order: closed,
    createdAt: new Date(now - 30 * MINUTE),
    evidence: {
      source: 'notify',
      transaction_id: tradeNo('wechat_pay'),
      payer: { openid: payer.openid },
    },
  });
  const y = await seedAnomalyRow(f, {
    channel: 'alipay',
    order: null,
    outTradeNo: 'PUNKNOWN0000000000001',
    amountFen: 990n,
    createdAt: new Date(now - 20 * MINUTE),
    evidence: { source: 'query', buyer_id: payer.buyerId, buyer_logon_id: 'p***@example.invalid' },
  });
  const z = await seedAnomalyRow(f, {
    channel: 'alipay',
    order: null,
    outTradeNo: null,
    amountFen: 1_900n,
    refundedFen: 1_900n,
    status: 'refunded',
    createdAt: new Date(now - 10 * MINUTE),
    evidence: { source: 'recon', buyer_id: payer.buyerId },
  });
  const g = await fixture(s);
  await seedAnomalyRow(g, {
    channel: 'alipay',
    order: null,
    createdAt: new Date(now - 5 * MINUTE),
    evidence: { source: 'notify' },
  });
  await withAdmin(f, channels, async (h) => {
    const sent = await h.anomalies();
    const all = await page(sent);
    expect({ page: all.page, page_size: all.page_size, total: all.total }).toEqual({
      page: 1,
      page_size: 20,
      total: 3,
    });
    const shown = all.items.map((item) => ({
      ...item,
      created_at: Date.parse(String(item['created_at'])),
    }));
    expect(shown).toEqual([z, y, x].map(anomalyView));
    for (const secret of [payer.openid, payer.buyerId, 'p***@example.invalid']) {
      expect(sent.body).not.toContain(secret);
    }
    expect(sent.body).not.toContain('evidence');
    const alipay = await page(await h.anomalies({ pay_channel: 'alipay' }));
    expect(alipay.total).toBe(2);
    expect(alipay.items.map((item) => item['pay_anomaly_id'])).toEqual([z.id, y.id]);
    const second = await page(await h.anomalies({ page: '2', page_size: '1' }));
    expect({ page: second.page, page_size: second.page_size, total: second.total }).toEqual({
      page: 2,
      page_size: 1,
      total: 3,
    });
    expect(second.items.map((item) => item['pay_anomaly_id'])).toEqual([y.id]);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-15f#18] 异常收款列表的拒绝：pay_channel 不在枚举 → 20001 data.fields=[pay_channel]；page_size 超过 200 → 20001；没有 pay.view 10403、不带令牌 10001；空应用是空页', async () => {
  const f = await fixture(s);
  const channels = adminChannels(f);
  await withAdmin(f, channels, async (h) => {
    expect(await page(await h.anomalies())).toEqual({
      items: [],
      page: 1,
      page_size: 20,
      total: 0,
    });
    await answer(await h.anomalies({ pay_channel: 'wechat' }), 20001, { fields: ['pay_channel'] });
    await answer(await h.anomalies({ page_size: '201' }), 20001);
    const refunder = await h.caller([REFUND]);
    await answer(await h.anomalies({}, refunder), 10403);
    await answer(await h.anomalies({}, null), 10001);
  });
});
