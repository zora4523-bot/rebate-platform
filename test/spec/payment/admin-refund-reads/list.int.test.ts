// B2-15o list rule tests (claude-independent, SPEC_REF 9ab94dc0): 08 BR-PAY-06 ① (退款对象是 PAID 的
// 支付单或异常收款，状态 PROCESSING / SUCCESS / FAILED，金额为正整数分), BR-PAY-05 ④ (异常收款可以没有
// 我方支付单); 规划/04 §6.6, §11.2 (pay.view 只读、不要 step-up); contracts/openapi.yaml
// listAdminPayRefunds (one row per refund with target_type / target_id; filters status, target_type,
// reason_code combined with AND; a value outside an enum → 20001 data.fields naming the parameter;
// created_at descending; page / page_size ≤ 200; integer fen; no audit record).
// Requests go through the real admin entry (kit.ts withRefundReads). Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import { allAudits, keysOf, refundView, type RefundRow } from '../admin/kit.ts';
import { fixture, suite, type Fixture } from '../orders/kit.ts';
import { channelRefundNo, seedRefund, type RefundTargetRef } from '../refund/kit.ts';
import {
  AMOUNT,
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
  type RefundReads,
} from './kit.ts';

const s = suite();

type Status = 'PROCESSING' | 'SUCCESS' | 'FAILED';

/** A refund of the target created `minutes` ago, with the columns its status implies. */
function refundIn(
  f: Fixture,
  target: RefundTargetRef,
  status: Status,
  reason: string,
  minutes: number,
): Promise<RefundRow> {
  return seedRefund(f, target, {
    status,
    reason_code: reason,
    created_at: minutesAgo(f, minutes),
    ...(status === 'SUCCESS'
      ? {
          channel_refund_no: channelRefundNo('wechat_pay'),
          succeeded_at: minutesAgo(f, minutes - 1),
        }
      : {}),
    ...(status === 'FAILED' ? { failed_at: minutesAgo(f, minutes - 1) } : {}),
  });
}

/** The ids of a filtered list, in the order returned; total checked against the filter. */
async function matching(
  h: RefundReads,
  query: Record<string, string>,
  total: number,
): Promise<unknown[]> {
  const data = await page(await h.list(query));
  expect(data.total, JSON.stringify(query)).toBe(total);
  return idsOf(data);
}

it('[AC-B2-15o#1] 退款单列表（pay.view，不要 step-up）：本应用的退款单按 created_at 倒序，每行就是契约的 AdminPayRefund（pay_refund_id、对象类型与对象 id、退款单号、金额、原因码、备注、状态、渠道退款单号、操作人、创建与成功时刻），支付单的退款与异常收款的退款同在一张表里，没有我方支付单的异常收款的退款也在；其他应用的退款单不出现；分页默认 1 / 20；超管也能读；读取不写审计', async () => {
  const f = await fixture(s);
  const order = await paidOrder(f, 'wechat_pay');
  const anomaly = await anomalyOf(f, 'alipay', null);
  const onClosed = await anomalyOf(f, 'wechat_pay', await closedOrder(f, 'wechat_pay'));
  const succeeded = await seedRefund(
    f,
    { type: 'pay_order', id: order.id },
    {
      amount_fen: 1_000n,
      reason_code: 'USER_REQUEST',
      status: 'SUCCESS',
      note: '用户申请退回部分款项',
      channel_refund_no: channelRefundNo('wechat_pay'),
      created_at: minutesAgo(f, 50),
      succeeded_at: minutesAgo(f, 49),
    },
  );
  const processing = await seedRefund(
    f,
    { type: 'pay_anomaly', id: anomaly.id },
    {
      amount_fen: 1_900n,
      reason_code: 'ANOMALY_RECEIPT',
      status: 'PROCESSING',
      created_at: minutesAgo(f, 40),
    },
  );
  const failed = await seedRefund(
    f,
    { type: 'pay_anomaly', id: onClosed.id },
    {
      amount_fen: 700n,
      reason_code: 'RECON_DIFF',
      status: 'FAILED',
      created_at: minutesAgo(f, 30),
      failed_at: minutesAgo(f, 29),
    },
  );
  const g = await fixture(s);
  const foreignOrder = await paidOrder(g, 'wechat_pay');
  const foreign = await seedRefund(
    g,
    { type: 'pay_order', id: foreignOrder.id },
    { created_at: minutesAgo(g, 1) },
  );
  await withRefundReads(f, async (h) => {
    const sent = await h.list();
    const all = await page(sent);
    expect({ page: all.page, page_size: all.page_size, total: all.total }).toEqual({
      page: 1,
      page_size: 20,
      total: 3,
    });
    for (const item of all.items) expect(keysOf(item)).toEqual([...REFUND_KEYS]);
    expect(all.items.map(refundOf)).toEqual([failed, processing, succeeded].map(refundView));
    expect(all.items.map((item) => [item['target_type'], item['target_id']])).toEqual([
      ['pay_anomaly', onClosed.id],
      ['pay_anomaly', anomaly.id],
      ['pay_order', order.id],
    ]);
    for (const secret of [foreign.id, foreign.out_refund_no, succeeded.idempotency_key]) {
      expect(sent.body).not.toContain(secret);
    }
    // A super admin reads it too, without ticking pay.view.
    const root = await h.caller([], { superAdmin: true });
    expect((await page(await h.list({}, root))).total).toBe(3);
    // A forged X-App-Id does not change the app: the account's own refunds, nobody else's.
    const forged = await h.list({}, undefined, { 'x-app-id': g.subject.app_id });
    const own = await page(forged);
    expect(own.total).toBe(3);
    expect(idsOf(own)).toEqual([failed.id, processing.id, succeeded.id]);
    for (const secret of [foreign.id, foreign.out_refund_no]) {
      expect(forged.body).not.toContain(secret);
    }
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-15o#2] 退款单列表的筛选：status、target_type、reason_code 各自过滤，组合时按 AND；total 是过滤后的总数；筛选下翻页按过滤后的结果翻；没有匹配时是空页', async () => {
  const f = await fixture(s);
  const order = { type: 'pay_order', id: (await paidOrder(f, 'wechat_pay')).id } as const;
  const anomaly = { type: 'pay_anomaly', id: (await anomalyOf(f, 'alipay', null)).id } as const;
  const r1 = await refundIn(f, order, 'SUCCESS', 'USER_REQUEST', 60);
  const r2 = await refundIn(f, order, 'PROCESSING', 'DUPLICATE_PAYMENT', 50);
  const r3 = await refundIn(f, anomaly, 'PROCESSING', 'ANOMALY_RECEIPT', 40);
  const r4 = await refundIn(f, anomaly, 'FAILED', 'ANOMALY_RECEIPT', 30);
  const r5 = await refundIn(f, order, 'FAILED', 'RECON_DIFF', 20);
  const r6 = await refundIn(f, anomaly, 'SUCCESS', 'OTHER', 10);
  await withRefundReads(f, async (h) => {
    expect(await matching(h, { status: 'SUCCESS' }, 2)).toEqual([r6.id, r1.id]);
    expect(await matching(h, { status: 'PROCESSING' }, 2)).toEqual([r3.id, r2.id]);
    expect(await matching(h, { status: 'FAILED' }, 2)).toEqual([r5.id, r4.id]);
    expect(await matching(h, { target_type: 'pay_order' }, 3)).toEqual([r5.id, r2.id, r1.id]);
    expect(await matching(h, { target_type: 'pay_anomaly' }, 3)).toEqual([r6.id, r4.id, r3.id]);
    expect(await matching(h, { reason_code: 'USER_REQUEST' }, 1)).toEqual([r1.id]);
    expect(await matching(h, { reason_code: 'DUPLICATE_PAYMENT' }, 1)).toEqual([r2.id]);
    expect(await matching(h, { reason_code: 'ANOMALY_RECEIPT' }, 2)).toEqual([r4.id, r3.id]);
    expect(await matching(h, { reason_code: 'RECON_DIFF' }, 1)).toEqual([r5.id]);
    expect(await matching(h, { reason_code: 'OTHER' }, 1)).toEqual([r6.id]);
    const two = { status: 'PROCESSING', target_type: 'pay_anomaly' };
    expect(await matching(h, two, 1)).toEqual([r3.id]);
    const three = { status: 'FAILED', target_type: 'pay_anomaly', reason_code: 'ANOMALY_RECEIPT' };
    expect(await matching(h, three, 1)).toEqual([r4.id]);
    const none = { status: 'SUCCESS', reason_code: 'ANOMALY_RECEIPT' };
    expect(await page(await h.list(none))).toEqual({
      items: [],
      page: 1,
      page_size: 20,
      total: 0,
    });
    const second = await page(
      await h.list({ target_type: 'pay_order', page: '2', page_size: '2' }),
    );
    expect({ page: second.page, page_size: second.page_size, total: second.total }).toEqual({
      page: 2,
      page_size: 2,
      total: 3,
    });
    expect(idsOf(second)).toEqual([r1.id]);
  });
});

it('[AC-B2-15o#3] 退款单列表的拒绝：status（含支付单的状态值、大小写不符）、target_type、reason_code 取值不在枚举 → 20001，data.fields 指名该参数；其余参数合法也一样；空应用是空页', async () => {
  const f = await fixture(s);
  await withRefundReads(f, async (h) => {
    expect(await page(await h.list())).toEqual({ items: [], page: 1, page_size: 20, total: 0 });
    await answer(await h.list({ status: 'PENDING' }), 20001, { fields: ['status'] });
    await answer(await h.list({ status: 'success' }), 20001, { fields: ['status'] });
    await answer(await h.list({ target_type: 'order' }), 20001, { fields: ['target_type'] });
    await answer(await h.list({ reason_code: 'FRAUD' }), 20001, { fields: ['reason_code'] });
    await answer(await h.list({ status: 'SUCCESS', reason_code: 'user_request' }), 20001, {
      fields: ['reason_code'],
    });
  });
  expect(await allAudits(f)).toEqual([]);
});

it('[AC-B2-15o#4] 退款单列表的分页：默认每页 20 条，page / page_size 翻页且 total 不变，page_size 200 可用，翻过末页是空页；page_size 超过 200 或小于 1、page 小于 1 → 20001 data.fields 指名该参数', async () => {
  const f = await fixture(s);
  const target = { type: 'pay_order', id: (await paidOrder(f, 'alipay')).id } as const;
  const rows: RefundRow[] = [];
  for (let minutes = 21; minutes >= 1; minutes -= 1) {
    rows.push(await refundIn(f, target, 'PROCESSING', 'USER_REQUEST', minutes));
  }
  const newestFirst = rows.map((row) => row.id).reverse();
  await withRefundReads(f, async (h) => {
    const first = await page(await h.list());
    expect({ page: first.page, page_size: first.page_size, total: first.total }).toEqual({
      page: 1,
      page_size: 20,
      total: 21,
    });
    expect(idsOf(first)).toEqual(newestFirst.slice(0, 20));
    const second = await page(await h.list({ page: '2' }));
    expect({ page: second.page, page_size: second.page_size, total: second.total }).toEqual({
      page: 2,
      page_size: 20,
      total: 21,
    });
    expect(idsOf(second)).toEqual(newestFirst.slice(20));
    const beyond = await page(await h.list({ page: '3' }));
    expect(beyond).toEqual({ items: [], page: 3, page_size: 20, total: 21 });
    const large = await page(await h.list({ page_size: '200' }));
    expect({ page_size: large.page_size, total: large.total }).toEqual({
      page_size: 200,
      total: 21,
    });
    expect(idsOf(large)).toEqual(newestFirst);
    const small = await page(await h.list({ page: '3', page_size: '7' }));
    expect(idsOf(small)).toEqual(newestFirst.slice(14, 21));
    await answer(await h.list({ page_size: '201' }), 20001, { fields: ['page_size'] });
    await answer(await h.list({ page_size: '0' }), 20001, { fields: ['page_size'] });
    await answer(await h.list({ page: '0' }), 20001, { fields: ['page'] });
  });
});

it('[AC-B2-15o#5] 退款单列表的顺序只看 created_at，与写入先后无关；created_at 相同的行翻页时不重不漏', async () => {
  const f = await fixture(s);
  const target = { type: 'pay_order', id: (await paidOrder(f, 'wechat_pay')).id } as const;
  const middle = await refundIn(f, target, 'PROCESSING', 'OTHER', 20);
  const newest = await refundIn(f, target, 'PROCESSING', 'OTHER', 10);
  const older = await refundIn(f, target, 'PROCESSING', 'OTHER', 30);
  const tied: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    tied.push((await refundIn(f, target, 'PROCESSING', 'OTHER', 40)).id);
  }
  await withRefundReads(f, async (h) => {
    const walked: unknown[] = [];
    for (let at = 1; at <= 5; at += 1) {
      const data = await page(await h.list({ page: String(at), page_size: '2' }));
      expect(data.total).toBe(9);
      walked.push(...idsOf(data));
    }
    expect(walked).toHaveLength(9);
    expect(walked.slice(0, 3)).toEqual([newest.id, middle.id, older.id]);
    expect([...walked.slice(3)].sort()).toEqual([...tied].sort());
  });
});

it('[AC-B2-15o#6] 金额是退款单自己的整数分，JSON 里是整数原样返回（1 分、1999 分、2^53-1 分都不四舍五入、不换算成元、不变成字符串），不是对象的金额', async () => {
  const f = await fixture(s);
  const order = await paidOrder(f, 'wechat_pay');
  const target = { type: 'pay_order', id: order.id } as const;
  const largest = BigInt(Number.MAX_SAFE_INTEGER);
  const rows: RefundRow[] = [];
  for (const [index, amount] of [1n, 1_999n, largest].entries()) {
    rows.push(
      await seedRefund(f, target, {
        amount_fen: amount,
        created_at: minutesAgo(f, 30 - index),
      }),
    );
  }
  await withRefundReads(f, async (h) => {
    const sent = await h.list();
    const data = await page(sent);
    expect(data.items.map((item) => item['amount_fen'])).toEqual([
      Number.MAX_SAFE_INTEGER,
      1_999,
      1,
    ]);
    for (const item of data.items) expect(Number.isSafeInteger(item['amount_fen'])).toBe(true);
    expect(sent.body).toMatch(/"amount_fen":9007199254740991[,}]/);
    expect(sent.body).toMatch(/"amount_fen":1999[,}]/);
    expect(sent.body).toMatch(/"amount_fen":1[,}]/);
    for (const row of rows) {
      const detail = refundOf(await ok(await h.detail(row.id)));
      expect(detail).toEqual(refundView(row));
      expect(detail['amount_fen']).not.toBe(Number(AMOUNT));
    }
  });
});

it('[AC-B2-15o#7] 退款单列表的权限：要 pay.view；没有任何权限点、只有 pay.refund、pay.resolve 或别的模块的查看权限 → 10403，不带令牌 → 10001，都不漏数据；持 pay.view 的账号读到，不要 X-Step-Up-Token', async () => {
  const f = await fixture(s);
  const order = await paidOrder(f, 'wechat_pay');
  const refund = await seedRefund(f, { type: 'pay_order', id: order.id });
  await withRefundReads(f, async (h) => {
    expect(idsOf(await page(await h.list()))).toEqual([refund.id]);
    const withMore = await h.caller([VIEW, 'pay.refund']);
    expect(idsOf(await page(await h.list({}, withMore)))).toEqual([refund.id]);
    for (const points of [[], ['pay.refund'], ['pay.resolve'], ['fund.view']]) {
      const sent = await h.list({}, await h.caller(points));
      await answer(sent, 10403);
      expect(sent.body, points.join()).not.toContain(refund.out_refund_no);
    }
    const anonymous = await h.list({}, null);
    await answer(anonymous, 10001);
    expect(anonymous.body).not.toContain(refund.out_refund_no);
  });
  expect(await allAudits(f)).toEqual([]);
});
