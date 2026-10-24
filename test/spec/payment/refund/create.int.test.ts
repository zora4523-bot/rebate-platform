// B2-15e creation rule tests (claude-independent, SPEC_REF c4cfc1a2): 08 BR-PAY-06 ①②③ (后台原路
// 退款：超管或 pay.refund 权限点、不设二次验证、写审计、必选原因码；对象为 PAID 支付单或异常收款；
// Idempotency-Key 同键同体返回原退款单、同键不同体 20901；幂等记录、退款单、额度占用同一事务；业务
// 对象级锁后「已成功 + 处理中」+ 本次 ≤ 可退金额；out_refund_no 创建时生成、唯一) and ⑤ (结果未知
// 只查询、不重提); payment/AGENTS.md rule 7 (外部写先落单); 规划/04 §5 a:<admin_user_id>;
// contracts/openapi.yaml createAdminPayRefund / createAdminPayAnomalyRefund (20001 amount_fen,
// 20902 pay_order, audit action pay_refund_create); D10-350 (pay_refunds.note 由建单的 INSERT 写入，
// 重放取自已存的行); D10-351 (幂等唯一键 (app_id, operator, idempotency_key)；refund.query 与建单同一
// 事务入队、渠道退款调用在提交之后).
// Requests go through the real admin entry (kit.ts withAdmin). Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, payOrder, seedOrder, suite, track } from '../orders/kit.ts';
import { received, sends, userTraces, vouchers } from '../result/kit.ts';
import {
  AMOUNT,
  AUDIT_ACTION,
  CHANNELS,
  OUT_REFUND_NO,
  REFUND_EVENT,
  REFUND_QUERY_JOB,
  REFUND_SUCCESS,
  anomalyRow,
  answer,
  created,
  idempotencyRows,
  newKey,
  refundAttempts,
  refundAudits,
  refundBody,
  refundChannels,
  refundJobs,
  refundNote,
  refundQueryJobs,
  refundRow,
  refundVoucherOf,
  refundedAnswer,
  refunds,
  seedAnomaly,
  seedPaid,
  seedRefund,
  settled,
  until,
  voucherShape,
  withAdmin,
  type RefundRow,
} from './kit.ts';

const s = suite();

/** The fields the channel must receive for a refund (BR-PAY-06: 原路, the refund's own number). */
function submittedShape(input: {
  outTradeNo: string | null;
  outRefundNo: string;
  refundFen: bigint;
  totalFen: bigint;
}) {
  return {
    outTradeNo: input.outTradeNo,
    outRefundNo: input.outRefundNo,
    refundFen: input.refundFen,
    totalFen: input.totalFen,
  };
}

it.each(CHANNELS)(
  '[AC-B2-15e#4] %s PAID 支付单的后台原路退款（pay.refund，不设二次验证）：一张 PROCESSING 退款单、out_refund_no 创建时生成、备注存入退款单；幂等记录主体 a:<admin_user_id>（user_id 空）、退款单与延迟的 refund.query 任务同一事务提交后才向渠道发起原路退款（D10-351 ③）；记一条渠道请求、一条审计；支付单状态与 refunded_fen 不变、不记账',
  async (channel) => {
    const f = await fixture(s);
    const { channels } = refundChannels(f);
    const { kit } = await refundJobs(f, channels);
    const order = await seedPaid(f, kit, channel);
    f.clock.advanceMs(60_000);
    const atCall: { refunds: string[]; keys: string[]; queries: number }[] = [];
    // Another pool connection than the request's: only what was committed is visible here.
    channels[channel].onRefund = async (input) => {
      const rows = await refunds(f);
      const mine = rows.find((row) => row.out_refund_no === input.outRefundNo);
      atCall.push({
        refunds: rows.map((row) => `${row.id}:${row.status}`),
        keys: (await idempotencyRows(f)).map((row) => row.status),
        queries: mine === undefined ? 0 : (await refundQueryJobs(f, mine.id)).length,
      });
    };
    await withAdmin(f, channels, async (h) => {
      const key = newKey();
      const note = '用户申请退回部分款项';
      const target = { type: 'pay_order', id: order.id } as const;
      const data = await created(
        await h.refund(target, refundBody(5_000, 'USER_REQUEST', note), { key }),
      );
      const rows = await refunds(f);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        target_type: 'pay_order',
        target_id: order.id,
        idempotency_key: key,
        amount_fen: 5_000n,
        reason_code: 'USER_REQUEST',
        status: 'PROCESSING',
        channel_refund_no: null,
        operator: h.operator.id,
        created_at: f.clock.now(),
        succeeded_at: null,
        failed_at: null,
      });
      expect(row.out_refund_no).toMatch(OUT_REFUND_NO);
      expect(row.out_refund_no).not.toBe(order.out_trade_no);
      expect({ ...data, created_at: Date.parse(String(data['created_at'])) }).toEqual({
        pay_refund_id: row.id,
        target_type: 'pay_order',
        target_id: order.id,
        out_refund_no: row.out_refund_no,
        amount_fen: 5_000,
        reason_code: 'USER_REQUEST',
        note,
        status: 'PROCESSING',
        channel_refund_no: null,
        operator: h.operator.id,
        created_at: f.clock.now().getTime(),
        succeeded_at: null,
      });
      // 原路: the order's own channel, its own numbers, this refund's number and amount.
      expect(channels[channel].submitted.map(submittedShape)).toEqual([
        {
          outTradeNo: order.out_trade_no,
          outRefundNo: row.out_refund_no,
          refundFen: 5_000n,
          totalFen: AMOUNT,
        },
      ]);
      const other = channel === 'wechat_pay' ? 'alipay' : 'wechat_pay';
      expect(channels[other].submitted).toEqual([]);
      // 外部写先落单: the refund row, the completed idempotency record and the refund's
      // refund.query job were committed before the channel was called (D10-351 ③).
      expect(atCall).toEqual([
        { refunds: [`${row.id}:PROCESSING`], keys: ['completed'], queries: 1 },
      ]);
      // D10-350: the note is kept on the refund row by the creating INSERT.
      expect(await refundNote(f, row.id)).toBe(note);
      expect(
        (await idempotencyRows(f)).map((k) => ({
          subject: k.subject,
          user_id: k.user_id,
          method: k.method,
          path: k.path,
          key: k.key,
          status: k.status,
        })),
      ).toEqual([
        {
          subject: `a:${h.operator.id}`,
          user_id: null,
          method: 'POST',
          path: `/admin/v1/pay-orders/${order.id}/refunds`,
          key,
          status: 'completed',
        },
      ]);
      const attempts = await refundAttempts(f, row.id);
      expect(attempts.map((a) => [a.kind, a.pay_order_id])).toEqual([['refund', null]]);
      const audits = await refundAudits(f);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ admin_id: h.operator.id, action: AUDIT_ACTION });
      const audited = JSON.stringify([audits[0]?.target, audits[0]?.before, audits[0]?.after]);
      expect(audited).toContain('5000');
      expect(audited).toContain('USER_REQUEST');
      const jobs = await refundQueryJobs(f, row.id);
      expect(jobs.length, 'a refund.query job of the refund').toBeGreaterThan(0);
      expect(jobs[0]?.payload).toMatchObject({ app_id: f.subject.app_id, pay_refund_id: row.id });
      expect(jobs[0]?.delay, 'the refund.query job is delayed').toBeGreaterThan(0);
    });
    // BR-PAY-06 ③: the order's status never changes; refunded_fen moves only on SUCCESS.
    expect(await payOrder(f, order.id)).toMatchObject({
      status: 'PAID',
      amount_fen: AMOUNT,
      refunded_fen: 0n,
      channel_trade_no: order.channel_trade_no,
      paid_at: order.paid_at,
    });
    expect((await vouchers(f)).map((v) => v.voucher_kind)).toEqual(['PAY_RECEIPT']);
    expect(await userTraces(f)).toEqual({ user_accounts: 0, balances: 0, user_entries: 0 });
  },
);

it('[AC-B2-15e#5] 同一幂等键、同一请求体再提交（响应丢失后再点一次）返回原退款单（同一个 out_refund_no，备注取自已存的退款单），不生成第二张、不再向渠道提交、不再写审计；同键不同请求体（金额、原因码或备注不同）20901', async () => {
  const f = await fixture(s);
  const { channels } = refundChannels(f);
  const { kit } = await refundJobs(f, channels);
  const order = await seedPaid(f, kit, 'wechat_pay', { amount_fen: 10_000n });
  await withAdmin(f, channels, async (h) => {
    const target = { type: 'pay_order', id: order.id } as const;
    const key = newKey();
    const note = '重复扣款，退回一笔';
    const body = refundBody(1_000, 'USER_REQUEST', note);
    const first = await created(await h.refund(target, body, { key }));
    const id = String(first['pay_refund_id']);
    expect(await refundNote(f, id)).toBe(note);
    f.clock.advanceMs(5_000);
    const again = await created(await h.refund(target, body, { key }));
    expect(again).toEqual(first);
    expect(again['note']).toBe(await refundNote(f, id));
    await answer(await h.refund(target, refundBody(1_001, 'USER_REQUEST', note), { key }), 20901);
    await answer(await h.refund(target, refundBody(1_000, 'OTHER', note), { key }), 20901);
    await answer(await h.refund(target, refundBody(1_000, 'USER_REQUEST'), { key }), 20901);
    const rows = await refunds(f);
    expect(rows.map((row) => [row.id, row.out_refund_no, row.amount_fen])).toEqual([
      [first['pay_refund_id'], first['out_refund_no'], 1_000n],
    ]);
    expect(channels.wechat_pay.submitted).toHaveLength(1);
    expect(await refundAudits(f)).toHaveLength(1);
  });
});

it('[AC-B2-15e#6] 请求不合格不建退款单：缺 Idempotency-Key（20001 idempotency-key）、缺原因码或原因码不在枚举、金额非正整数、多带字段、备注超长都是 20001；不写幂等记录、不调渠道、不写审计，被 2xxxx 拒绝的键之后可以照常使用（原因码 OTHER 不带备注也可，备注存为 NULL）', async () => {
  const f = await fixture(s);
  const { channels } = refundChannels(f);
  const { kit } = await refundJobs(f, channels);
  const order = await seedPaid(f, kit, 'alipay');
  await withAdmin(f, channels, async (h) => {
    const target = { type: 'pay_order', id: order.id } as const;
    await answer(await h.refund(target, refundBody(100), { key: null }), 20001, {
      fields: ['idempotency-key'],
    });
    const key = newKey();
    const bad: unknown[] = [
      { amount_fen: 100 },
      { amount_fen: 100, reason_code: 'REFUND' },
      { amount_fen: 100, reason_code: '' },
      { amount_fen: 0, reason_code: 'USER_REQUEST' },
      { amount_fen: -1, reason_code: 'USER_REQUEST' },
      { amount_fen: 1.5, reason_code: 'USER_REQUEST' },
      { amount_fen: '100', reason_code: 'USER_REQUEST' },
      { reason_code: 'USER_REQUEST' },
      { amount_fen: 100, reason_code: 'USER_REQUEST', pay_channel: 'alipay' },
      { amount_fen: 100, reason_code: 'USER_REQUEST', out_refund_no: 'R1' },
      { amount_fen: 100, reason_code: 'USER_REQUEST', note: 'x'.repeat(201) },
    ];
    for (const body of bad) {
      const sent = await h.refund(target, body, { key });
      expect(sent.statusCode, `${JSON.stringify(body)} → ${sent.body}`).toBe(400);
      await answer(sent, 20001);
    }
    expect(await refunds(f)).toEqual([]);
    expect(await idempotencyRows(f)).toEqual([]);
    expect(channels.alipay.submitted).toEqual([]);
    expect(await refundAudits(f)).toEqual([]);
    // OTHER without a note is accepted (D10-350 adds no rule); the stored note is NULL.
    const data = await created(await h.refund(target, refundBody(100, 'OTHER'), { key }));
    expect(data).toMatchObject({
      amount_fen: 100,
      reason_code: 'OTHER',
      note: null,
      status: 'PROCESSING',
    });
    expect(await refundNote(f, String(data['pay_refund_id']))).toBeNull();
  });
});

it('[AC-B2-15e#7] 额度：业务对象级锁后「已成功 + 处理中」合计加本次不超过支付单金额，FAILED 不占额；超出 20001 data.fields=[amount_fen]、不建单不调渠道；恰好用完可退；各退款单的 out_refund_no 互不相同', async () => {
  const f = await fixture(s);
  const { channels } = refundChannels(f);
  const { kit } = await refundJobs(f, channels);
  const order = await seedPaid(f, kit, 'wechat_pay');
  const target = { type: 'pay_order', id: order.id } as const;
  await seedRefund(f, target, {
    amount_fen: 3_000n,
    status: 'SUCCESS',
    succeeded_at: f.clock.now(),
  });
  await seedRefund(f, target, { amount_fen: 4_000n, status: 'PROCESSING' });
  await seedRefund(f, target, { amount_fen: 5_000n, status: 'FAILED', failed_at: f.clock.now() });
  const remainder = AMOUNT - 7_000n;
  await withAdmin(f, channels, async (h) => {
    await answer(await h.refund(target, refundBody(remainder + 1n)), 20001, {
      fields: ['amount_fen'],
    });
    expect(channels.wechat_pay.submitted).toEqual([]);
    expect(await refunds(f)).toHaveLength(3);
    const data = await created(await h.refund(target, refundBody(remainder)));
    expect(data).toMatchObject({ amount_fen: Number(remainder), status: 'PROCESSING' });
    await answer(await h.refund(target, refundBody(1)), 20001, { fields: ['amount_fen'] });
  });
  const rows = await refunds(f);
  expect(rows).toHaveLength(4);
  expect(new Set(rows.map((row) => row.out_refund_no)).size).toBe(4);
  expect(channels.wechat_pay.submitted.map((input) => input.refundFen)).toEqual([remainder]);
  expect(await payOrder(f, order.id)).toMatchObject({ status: 'PAID', refunded_fen: 3_000n });
});

it('[AC-B2-15e#8] 退款对象必须是本应用 PAID 的支付单：PENDING / CLOSED → 20902 resource=pay_order；不存在或其他应用的支付单 → 20001 data.fields=[pay_order_id]；都不建单、不写幂等记录、不调渠道', async () => {
  const f = await fixture(s);
  const { channels } = refundChannels(f);
  const pending = await seedOrder(f, { pay_channel: 'wechat_pay', amount_fen: AMOUNT });
  const closed = await seedOrder(f, {
    pay_channel: 'wechat_pay',
    amount_fen: AMOUNT,
    status: 'CLOSED',
    closed_at: f.clock.now(),
  });
  const g = await fixture(s);
  const other = await refundJobs(g, refundChannels(g).channels);
  const foreign = await seedPaid(g, other.kit, 'wechat_pay');
  await withAdmin(f, channels, async (h) => {
    for (const order of [pending, closed]) {
      await answer(await h.refund({ type: 'pay_order', id: order.id }, refundBody(100)), 20902, {
        resource: 'pay_order',
      });
    }
    for (const id of [randomUUID(), foreign.id]) {
      await answer(await h.refund({ type: 'pay_order', id }, refundBody(100)), 20001, {
        fields: ['pay_order_id'],
      });
    }
  });
  expect(await refunds(f)).toEqual([]);
  expect(await refunds(g)).toEqual([]);
  expect(await idempotencyRows(f)).toEqual([]);
  expect(channels.wechat_pay.submitted).toEqual([]);
});

it('[AC-B2-15e#9] 权限：只有 pay.view 的账号 10403、不带令牌 10001，均不建单；超管不需勾选权限点即可退款（不设二次验证，不带 step-up 令牌）', async () => {
  const f = await fixture(s);
  const { channels } = refundChannels(f);
  const { kit } = await refundJobs(f, channels);
  const order = await seedPaid(f, kit, 'alipay');
  await withAdmin(f, channels, async (h) => {
    const target = { type: 'pay_order', id: order.id } as const;
    const viewer = await h.caller(['pay.view']);
    await answer(await h.refund(target, refundBody(100), { caller: viewer }), 10403);
    await answer(await h.refund(target, refundBody(100), { caller: null }), 10001);
    expect(await refunds(f)).toEqual([]);
    expect(channels.alipay.submitted).toEqual([]);
    const root = await h.caller([], { superAdmin: true });
    const data = await created(await h.refund(target, refundBody(100), { caller: root }));
    expect(data).toMatchObject({ operator: root.id, status: 'PROCESSING' });
    expect(await refunds(f)).toHaveLength(1);
    expect(await refundAudits(f)).toMatchObject([{ admin_id: root.id }]);
  });
});

it.each([
  ['关闭后收到钱的异常收款（有我方商户单号）', true],
  ['找不到我方支付单的异常收款（无商户单号，按渠道交易号原路退）', false],
] as const)(
  '[AC-B2-15e#10] 对 %s 原路退款：退款单 target_type=pay_anomaly，额度为其收款金额；渠道收到原单号或渠道交易号与收款金额；异常收款行在成功前不变；超额 20001 amount_fen，不存在的异常收款 20001 pay_anomaly_id',
  async (label, withOrder) => {
    const f = await fixture(s);
    const { channels } = refundChannels(f);
    const { kit } = await refundJobs(f, channels);
    const { anomaly } = await seedAnomaly(f, kit, 'alipay', { withOrder, amountFen: 1_900n });
    expect(anomaly.out_trade_no === null, label).toBe(!withOrder);
    const target = { type: 'pay_anomaly', id: anomaly.id } as const;
    await withAdmin(f, channels, async (h) => {
      const key = newKey();
      const data = await created(
        await h.refund(target, refundBody(1_900, 'ANOMALY_RECEIPT'), { key }),
      );
      const rows = await refunds(f);
      expect(rows).toHaveLength(1);
      const row: RefundRow = rows[0]!;
      expect(row).toMatchObject({
        target_type: 'pay_anomaly',
        target_id: anomaly.id,
        amount_fen: 1_900n,
        reason_code: 'ANOMALY_RECEIPT',
        status: 'PROCESSING',
      });
      expect(data).toMatchObject({
        pay_refund_id: row.id,
        target_type: 'pay_anomaly',
        target_id: anomaly.id,
        out_refund_no: row.out_refund_no,
        status: 'PROCESSING',
      });
      expect(
        channels.alipay.submitted.map((input) => ({
          ...submittedShape(input),
          channelTradeNo: input.channelTradeNo,
        })),
      ).toEqual([
        {
          outTradeNo: anomaly.out_trade_no,
          outRefundNo: row.out_refund_no,
          refundFen: 1_900n,
          totalFen: 1_900n,
          channelTradeNo: anomaly.channel_trade_no,
        },
      ]);
      expect((await idempotencyRows(f)).map((k) => [k.subject, k.user_id, k.path])).toEqual([
        [`a:${h.operator.id}`, null, `/admin/v1/pay-anomalies/${anomaly.id}/refunds`],
      ]);
      await answer(await h.refund(target, refundBody(1, 'ANOMALY_RECEIPT')), 20001, {
        fields: ['amount_fen'],
      });
      await answer(
        await h.refund({ type: 'pay_anomaly', id: randomUUID() }, refundBody(1, 'ANOMALY_RECEIPT')),
        20001,
        { fields: ['pay_anomaly_id'] },
      );
    });
    expect(await refunds(f)).toHaveLength(1);
    expect(await anomalyRow(f, anomaly.id)).toMatchObject({ refunded_fen: 0n, status: 'open' });
    expect(await refundAudits(f)).toHaveLength(1);
  },
);

it('[AC-B2-15e#11] 幂等记录、退款单、额度占用、refund.query 入队同一事务：退款单写入后幂等记录写失败 → 整体回滚（无退款单、无幂等记录、无 refund.query 任务、无审计、不调渠道、5xx）；同一键随后重提照常建出一张', async () => {
  const f = await fixture(s);
  const { channels } = refundChannels(f);
  const { kit } = await refundJobs(f, channels);
  const order = await seedPaid(f, kit, 'wechat_pay');
  await withAdmin(f, channels, async (h) => {
    const target = { type: 'pay_order', id: order.id } as const;
    const key = newKey();
    h.fault.idempotencyAfterRefund = true;
    const failed = await h.refund(target, refundBody(2_000), { key });
    expect(h.fault.tripped, 'the idempotency write after the refund insert was reached').toBe(1);
    expect(failed.statusCode, failed.body).toBeGreaterThanOrEqual(500);
    expect(await refunds(f)).toEqual([]);
    expect(await idempotencyRows(f)).toEqual([]);
    expect(await refundQueryJobs(f, f.subject.app_id)).toEqual([]);
    expect(await refundAudits(f)).toEqual([]);
    expect(channels.wechat_pay.submitted).toEqual([]);
    const data = await created(await h.refund(target, refundBody(2_000), { key }));
    expect(data).toMatchObject({ amount_fen: 2_000, status: 'PROCESSING' });
    expect(await refunds(f)).toHaveLength(1);
    expect((await refundQueryJobs(f, f.subject.app_id)).length).toBeGreaterThan(0);
    expect(channels.wechat_pay.submitted).toHaveLength(1);
  });
});

it('[AC-B2-15e#12] 渠道退款应答未知：退款单仍是 PROCESSING（只有 ok / unknown，没有「失败」）；之后只查询、不用同一退款单号重提——查询超时不迁移，查到成功才 SUCCESS', async () => {
  const f = await fixture(s);
  const { channels, identity } = refundChannels(f);
  const { kit, handle } = await refundJobs(f, channels);
  const order = await seedPaid(f, kit, 'wechat_pay');
  channels.wechat_pay.scriptRefund(['unknown']);
  let refundId = '';
  await withAdmin(f, channels, async (h) => {
    const target = { type: 'pay_order', id: order.id } as const;
    const data = await created(await h.refund(target, refundBody(800)));
    expect(data['status']).toBe('PROCESSING');
    refundId = String(data['pay_refund_id']);
  });
  const row = await refundRow(f, refundId);
  expect(row.status).toBe('PROCESSING');
  const jobs = await refundQueryJobs(f, refundId);
  expect(jobs.length, 'a refund.query job of the refund').toBeGreaterThan(0);
  const job = received(REFUND_QUERY_JOB, jobs[0]?.payload ?? {});
  channels.wechat_pay.setRefund(row.out_refund_no, 'timeout');
  f.clock.advanceMs(30_000);
  await settled(handle(job));
  expect(await refundRow(f, refundId)).toMatchObject({ status: 'PROCESSING', succeeded_at: null });
  channels.wechat_pay.setRefund(row.out_refund_no, {
    channelState: REFUND_SUCCESS.wechat_pay,
    refundFen: 800n,
    outTradeNo: order.out_trade_no,
    channelTradeNo: order.channel_trade_no,
    channelRefundNo: null,
    identity: identity.wechat_pay,
  });
  f.clock.advanceMs(30_000);
  expect(await settled(handle(job))).toBe('resolved');
  expect(await refundRow(f, refundId)).toMatchObject({
    status: 'SUCCESS',
    succeeded_at: f.clock.now(),
    out_refund_no: row.out_refund_no,
  });
  expect(channels.wechat_pay.submitted).toHaveLength(1);
  expect(channels.wechat_pay.refundQueried).toEqual([row.out_refund_no, row.out_refund_no]);
  expect((await refundAttempts(f, refundId)).map((a) => a.kind)).toEqual([
    'refund',
    'refund_query',
    'refund_query',
  ]);
  expect(await payOrder(f, order.id)).toMatchObject({ status: 'PAID', refunded_fen: 800n });
});

it('[AC-B2-15e#25] D10-351 ② 幂等按主体隔离：两名不同的管理员（都有 pay.refund）用同一个 Idempotency-Key、同一请求体对同一张 PAID 支付单各提交一笔部分退款（合计不超可退）→ 各得一张退款单（不同 id、不同 out_refund_no）、各一次渠道提交，都不是 20901；各自同键同体重放仍返回自己的原单', async () => {
  const f = await fixture(s);
  const { channels } = refundChannels(f);
  const { kit } = await refundJobs(f, channels);
  const order = await seedPaid(f, kit, 'alipay');
  await withAdmin(f, channels, async (h) => {
    const target = { type: 'pay_order', id: order.id } as const;
    const other = await h.caller(['pay.refund']);
    const key = newKey();
    const body = refundBody(3_000, 'USER_REQUEST');
    const mine = await created(await h.refund(target, body, { key }));
    const theirs = await created(await h.refund(target, body, { key, caller: other }));
    expect(mine).toMatchObject({
      operator: h.operator.id,
      amount_fen: 3_000,
      status: 'PROCESSING',
    });
    expect(theirs).toMatchObject({ operator: other.id, amount_fen: 3_000, status: 'PROCESSING' });
    expect(theirs['pay_refund_id']).not.toBe(mine['pay_refund_id']);
    expect(theirs['out_refund_no']).not.toBe(mine['out_refund_no']);
    expect(await created(await h.refund(target, body, { key }))).toEqual(mine);
    expect(await created(await h.refund(target, body, { key, caller: other }))).toEqual(theirs);
    const rows = await refunds(f);
    expect(rows).toHaveLength(2);
    const byOperator = new Map(rows.map((row) => [row.operator, row]));
    expect(byOperator.get(h.operator.id)).toMatchObject({
      id: mine['pay_refund_id'],
      idempotency_key: key,
      out_refund_no: mine['out_refund_no'],
    });
    expect(byOperator.get(other.id)).toMatchObject({
      id: theirs['pay_refund_id'],
      idempotency_key: key,
      out_refund_no: theirs['out_refund_no'],
    });
    expect(channels.alipay.submitted.map((input) => input.outRefundNo).sort()).toEqual(
      [String(mine['out_refund_no']), String(theirs['out_refund_no'])].sort(),
    );
    expect((await idempotencyRows(f)).map((row) => [row.subject, row.key]).sort()).toEqual(
      [
        [`a:${h.operator.id}`, key],
        [`a:${other.id}`, key],
      ].sort(),
    );
    expect((await refundAudits(f)).map((audit) => audit.admin_id).sort()).toEqual(
      [h.operator.id, other.id].sort(),
    );
  });
  expect(await payOrder(f, order.id)).toMatchObject({ status: 'PAID', refunded_fen: 0n });
});

it.each(['throws', 'hangs'] as const)(
  '[AC-B2-15e#26] D10-351 ③ 渠道退款调用在建单事务提交之后，调用中途进程退出（渠道调用 %s）：退款单停在 PROCESSING、它的 refund.query 任务仍在、不用同一 out_refund_no 重提；之后执行该 refund.query、渠道查到成功 → 退款单 SUCCESS，与通知相同的同事务结果（refunded_fen、PAY_REFUND、biz.reconcile、pay_refund.succeeded）',
  async (mode) => {
    const f = await fixture(s);
    const { channels, identity } = refundChannels(f);
    const { kit, handle } = await refundJobs(f, channels);
    const order = await seedPaid(f, kit, 'wechat_pay');
    f.clock.advanceMs(60_000);
    let exit: (error: Error) => void = () => undefined;
    const pending = new Promise<void>((_resolve, reject) => {
      exit = reject;
    });
    void pending.catch(() => undefined);
    channels.wechat_pay.onRefund = () =>
      mode === 'throws' ? Promise.reject(new Error('synthetic: the process went away')) : pending;
    await withAdmin(f, channels, async (h) => {
      const call = track(h.refund({ type: 'pay_order', id: order.id }, refundBody(2_500)));
      if (mode === 'hangs') {
        const reached = await until(() => channels.wechat_pay.submitted.length > 0, call);
        expect(reached, 'the channel was called').toBe(true);
        // While the channel call is still open, the refund and its query job are committed.
        const open = await refunds(f);
        expect(open.map((row) => row.status)).toEqual(['PROCESSING']);
        expect((await refundQueryJobs(f, open[0]!.id)).length).toBeGreaterThan(0);
        exit(new Error('synthetic: the process went away'));
      }
      await settled(call.promise);
    });
    const rows = await refunds(f);
    expect(rows.map((row) => [row.status, row.amount_fen])).toEqual([['PROCESSING', 2_500n]]);
    const row = rows[0]!;
    const jobs = await refundQueryJobs(f, row.id);
    expect(jobs.length, 'the refund.query job of the refund is still there').toBeGreaterThan(0);
    expect(channels.wechat_pay.submitted.map((input) => input.outRefundNo)).toEqual([
      row.out_refund_no,
    ]);
    channels.wechat_pay.setRefund(
      row.out_refund_no,
      refundedAnswer(
        identity.wechat_pay,
        row,
        { outTradeNo: order.out_trade_no, channelTradeNo: order.channel_trade_no ?? '' },
        'wechat_pay',
      ),
    );
    f.clock.advanceMs(30_000);
    expect(await settled(handle(received(REFUND_QUERY_JOB, jobs[0]?.payload ?? {})))).toBe(
      'resolved',
    );
    expect(await refundRow(f, row.id)).toMatchObject({
      status: 'SUCCESS',
      succeeded_at: f.clock.now(),
      out_refund_no: row.out_refund_no,
    });
    expect(await payOrder(f, order.id)).toMatchObject({ status: 'PAID', refunded_fen: 2_500n });
    expect((await vouchers(f)).map((v) => voucherShape(v))).toContainEqual(
      refundVoucherOf(order, row),
    );
    expect(sends(kit, 'biz.reconcile').map((job) => job.inTransaction)).toEqual([true]);
    expect(kit.published.map((p) => [p.event.name, p.inTransaction])).toEqual([
      [REFUND_EVENT, true],
    ]);
    expect(channels.wechat_pay.submitted).toHaveLength(1);
    expect(channels.wechat_pay.refundQueried).toEqual([row.out_refund_no]);
  },
);
