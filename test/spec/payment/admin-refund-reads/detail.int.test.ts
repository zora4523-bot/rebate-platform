// B2-15o detail rule tests (claude-independent, SPEC_REF 9ab94dc0): 08 BR-PAY-06 ①④⑤ (退款对象、状态、
// 结果由通知或查询判定后写回退款单); 规划/04 §6.6, §11.2 (pay.view 只读、不要 step-up);
// contracts/openapi.yaml getAdminPayRefund (same shape as a list row; the console polls it until
// SUCCESS or FAILED; an unknown pay_refund_id or a refund of another app → 20001
// data.fields=[pay_refund_id], no 404; no audit record).
// Requests go through the real admin entry (kit.ts withRefundReads). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { allAudits, keysOf, refundRows, refundView } from '../admin/kit.ts';
import { attempts, fixture, payOrder, suite, type Fixture } from '../orders/kit.ts';
import {
  anomalyRow,
  channelRefundNo,
  idempotencyRows,
  refundQueryJobs,
  refundRow,
  seedRefund,
} from '../refund/kit.ts';
import {
  REFUND_KEYS,
  VIEW,
  anomalyOf,
  answer,
  closedOrder,
  idsOf,
  minutesAgo,
  ok,
  page,
  paidOrder,
  refundOf,
  withRefundReads,
} from './kit.ts';

const s = suite();

/** The channel's result written back to a refund, as the result handling leaves the row. */
async function settle(
  f: Fixture,
  id: string,
  patch: {
    readonly status: 'SUCCESS' | 'FAILED';
    readonly channel_refund_no?: string;
    readonly succeeded_at?: Date;
    readonly failed_at?: Date;
  },
): Promise<void> {
  await f.db
    .updateTable('pay_refunds')
    .set(patch)
    .where('app_id', '=', f.subject.app_id)
    .where('id', '=', id)
    .execute();
}

it('[AC-B2-15o#8] 退款单详情（pay.view，不要 step-up）：支付单的退款、CLOSED 单上异常收款的退款、没有我方支付单的异常收款的退款都按 id 读到，data 与列表行同形（字段、取值都相同），target_type / target_id 指向退款对象本身（异常收款的退款指向异常收款，不是它名下的支付单）；超管也能读；读取不写审计', async () => {
  const f = await fixture(s);
  const order = await paidOrder(f, 'wechat_pay');
  const closed = await closedOrder(f, 'alipay');
  const onClosed = await anomalyOf(f, 'alipay', closed);
  const loose = await anomalyOf(f, 'wechat_pay', null);
  const ofOrder = await seedRefund(
    f,
    { type: 'pay_order', id: order.id },
    {
      amount_fen: 500n,
      note: '用户申请退回部分款项',
      status: 'SUCCESS',
      channel_refund_no: channelRefundNo('wechat_pay'),
      created_at: minutesAgo(f, 30),
      succeeded_at: minutesAgo(f, 29),
    },
  );
  const ofClosed = await seedRefund(
    f,
    { type: 'pay_anomaly', id: onClosed.id },
    {
      amount_fen: 1_900n,
      reason_code: 'ANOMALY_RECEIPT',
      status: 'PROCESSING',
      created_at: minutesAgo(f, 20),
    },
  );
  const ofLoose = await seedRefund(
    f,
    { type: 'pay_anomaly', id: loose.id },
    {
      amount_fen: 900n,
      reason_code: 'RECON_DIFF',
      status: 'FAILED',
      created_at: minutesAgo(f, 10),
      failed_at: minutesAgo(f, 9),
    },
  );
  await withRefundReads(f, async (h) => {
    for (const row of [ofOrder, ofClosed, ofLoose]) {
      const data = await ok(await h.detail(row.id));
      expect(keysOf(data)).toEqual([...REFUND_KEYS]);
      expect(refundOf(data)).toEqual(refundView(row));
    }
    const onAnomaly = await ok(await h.detail(ofClosed.id));
    expect([onAnomaly['target_type'], onAnomaly['target_id']]).toEqual([
      'pay_anomaly',
      onClosed.id,
    ]);
    expect(onAnomaly['target_id']).not.toBe(closed.id);
    const rows = await page(await h.list());
    expect(idsOf(rows)).toEqual([ofLoose.id, ofClosed.id, ofOrder.id]);
    for (const item of rows.items) {
      expect(await ok(await h.detail(String(item['pay_refund_id'])))).toEqual(item);
    }
    // A super admin reads it too, without ticking pay.view.
    const root = await h.caller([], { superAdmin: true });
    expect(refundOf(await ok(await h.detail(ofOrder.id, root)))).toEqual(refundView(ofOrder));
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-15o#9] 后台发起退款后轮询详情：每次读到的都是退款单的当前状态，PROCESSING 时 channel_refund_no、succeeded_at 为 null；结果写回后立刻读到 SUCCESS（带渠道退款单号与成功时刻）或 FAILED（succeeded_at 仍为 null），不缓存旧状态', async () => {
  const f = await fixture(s);
  const order = await paidOrder(f, 'wechat_pay');
  const target = { type: 'pay_order', id: order.id } as const;
  const won = await seedRefund(f, target, { amount_fen: 500n, created_at: minutesAgo(f, 5) });
  const lost = await seedRefund(f, target, { amount_fen: 600n, created_at: minutesAgo(f, 4) });
  const refundNo = channelRefundNo('wechat_pay');
  await withRefundReads(f, async (h) => {
    for (const row of [won, lost]) {
      const first = await ok(await h.detail(row.id));
      expect(refundOf(first)).toEqual(refundView(row));
      expect(first).toMatchObject({
        status: 'PROCESSING',
        channel_refund_no: null,
        succeeded_at: null,
      });
    }
    await settle(f, won.id, {
      status: 'SUCCESS',
      channel_refund_no: refundNo,
      succeeded_at: f.clock.now(),
    });
    await settle(f, lost.id, { status: 'FAILED', failed_at: f.clock.now() });
    const success = await ok(await h.detail(won.id));
    expect(refundOf(success)).toEqual(refundView(await refundRow(f, won.id)));
    expect(success).toMatchObject({ status: 'SUCCESS', channel_refund_no: refundNo });
    expect(Date.parse(String(success['succeeded_at']))).toBe(f.clock.now().getTime());
    const failure = await ok(await h.detail(lost.id));
    expect(refundOf(failure)).toEqual(refundView(await refundRow(f, lost.id)));
    expect(failure).toMatchObject({ status: 'FAILED', succeeded_at: null });
  });
});

it('[AC-B2-15o#10] 详情的未知 id：不存在的 id、其他应用的退款单、不是 UUID 的文本、超长文本、支付单或异常收款的 id、退款单号 → 20001 data.fields=[pay_refund_id]（不是 404，也不是 50001），不漏数据', async () => {
  const f = await fixture(s);
  const order = await paidOrder(f, 'alipay');
  const anomaly = await anomalyOf(f, 'alipay', null);
  const refund = await seedRefund(f, { type: 'pay_order', id: order.id });
  const g = await fixture(s);
  const foreignOrder = await paidOrder(g, 'alipay');
  const foreign = await seedRefund(g, { type: 'pay_order', id: foreignOrder.id });
  await withRefundReads(f, async (h) => {
    expect(idsOf(await page(await h.list()))).toEqual([refund.id]);
    const unknown = [
      randomUUID(),
      foreign.id,
      order.id,
      anomaly.id,
      refund.out_refund_no,
      'not-a-uuid',
      'r'.repeat(65),
    ];
    for (const id of unknown) {
      const sent = await h.detail(id);
      await answer(sent, 20001, { fields: ['pay_refund_id'] });
      expect(sent.body).not.toContain(foreign.out_refund_no);
    }
    // A forged X-App-Id does not open the other app's refund.
    const forged = await h.detail(foreign.id, undefined, { 'x-app-id': g.subject.app_id });
    await answer(forged, 20001, { fields: ['pay_refund_id'] });
    expect(forged.body).not.toContain(foreign.out_refund_no);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-15o#11] 详情的权限：要 pay.view；没有任何权限点、只有 pay.refund、pay.resolve → 10403，不带令牌 → 10001，都不漏数据；持 pay.view 的账号读到，不要 X-Step-Up-Token', async () => {
  const f = await fixture(s);
  const order = await paidOrder(f, 'wechat_pay');
  const refund = await seedRefund(f, { type: 'pay_order', id: order.id });
  await withRefundReads(f, async (h) => {
    expect(refundOf(await ok(await h.detail(refund.id)))).toEqual(refundView(refund));
    const operator = await h.caller([VIEW, 'pay.refund']);
    expect(refundOf(await ok(await h.detail(refund.id, operator)))).toEqual(refundView(refund));
    for (const points of [[], ['pay.refund'], ['pay.resolve']]) {
      const sent = await h.detail(refund.id, await h.caller(points));
      await answer(sent, 10403);
      expect(sent.body, points.join()).not.toContain(refund.out_refund_no);
    }
    const anonymous = await h.detail(refund.id, null);
    await answer(anonymous, 10001);
    expect(anonymous.body).not.toContain(refund.out_refund_no);
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-15o#12] 两个读接口只读：列表、筛选、详情、被拒的请求都不写审计，不改退款单、支付单与异常收款（状态、已退金额不动），不发起渠道查询（不留请求记录），不留幂等记录', async () => {
  const f = await fixture(s);
  const order = await paidOrder(f, 'wechat_pay');
  const anomaly = await anomalyOf(f, 'alipay', null);
  const processing = await seedRefund(
    f,
    { type: 'pay_order', id: order.id },
    { amount_fen: 500n, created_at: minutesAgo(f, 20) },
  );
  const succeeded = await seedRefund(
    f,
    { type: 'pay_anomaly', id: anomaly.id },
    {
      amount_fen: 900n,
      reason_code: 'ANOMALY_RECEIPT',
      status: 'SUCCESS',
      channel_refund_no: channelRefundNo('alipay'),
      created_at: minutesAgo(f, 10),
      succeeded_at: minutesAgo(f, 9),
    },
  );
  const before = {
    refunds: await refundRows(f),
    order: await payOrder(f, order.id),
    anomaly: await anomalyRow(f, anomaly.id),
  };
  await withRefundReads(f, async (h) => {
    expect((await page(await h.list())).total).toBe(2);
    expect((await page(await h.list({ status: 'PROCESSING' }))).total).toBe(1);
    await ok(await h.detail(processing.id));
    await ok(await h.detail(succeeded.id));
    await answer(await h.detail(randomUUID()), 20001, { fields: ['pay_refund_id'] });
    await answer(await h.list({ status: 'REFUNDED' }), 20001, { fields: ['status'] });
    await answer(await h.detail(processing.id, await h.caller(['pay.refund'])), 10403);
  });
  expect(await allAudits(f)).toEqual([]);
  expect(await refundRows(f)).toEqual(before.refunds);
  expect(await payOrder(f, order.id)).toEqual(before.order);
  expect(await anomalyRow(f, anomaly.id)).toEqual(before.anomaly);
  expect(await attempts(f)).toEqual([]);
  expect(await refundQueryJobs(f, f.subject.app_id)).toEqual([]);
  expect(await idempotencyRows(f)).toEqual([]);
});
