// B2-15b rule tests of POST /v1/pay/orders (claude-independent, SPEC_REF 48e55e6a): 08 BR-PAY-01
// ①②④, BR-PAY-02, BR-PAY-03; AC-S2-82 ①⑩; task §9.2 ～ §9.6; ruling D10-236 ④. Real api entry
// and PostgreSQL (kit.ts); the channels are FakePayChannel. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import {
  BIZ,
  CHANNELS,
  OUT_TRADE_NO,
  TITLE,
  TTL_MS,
  answer,
  attempts,
  conflict,
  createBody,
  enable,
  fixture,
  ledgerRows,
  normalize,
  payOrder,
  payOrders,
  seedOrder,
  setConfig,
  success,
  suite,
  view,
  withHttp,
} from './kit.ts';

const s = suite();
const LAUNCH_KEYS: Record<PayChannelCode, string[]> = {
  wechat_pay: ['appid', 'noncestr', 'package', 'partnerid', 'prepayid', 'sign', 'timestamp'],
  alipay: ['order_str'],
};
const SECRET_KEYS: Record<PayChannelCode, string[]> = {
  wechat_pay: ['prepayid', 'noncestr', 'sign'],
  alipay: ['order_str'],
};

it.each(CHANNELS)(
  '[AC-B2-15b#13] %s 下单：服务端定价 1 分落 PENDING 单，返回支付单与该渠道调起参数，记下单尝试与 launch_issued_at，调起参数不进日志、不记账',
  async (channel) => {
    const f = await fixture(s);
    await enable(f);
    const bizRef = randomUUID();
    await withHttp(f, async (send, logs) => {
      const data = await success(await send('create', { body: createBody(bizRef, channel) }));
      const rows = await payOrders(f);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        user_id: f.subject.user_id,
        biz_type: BIZ,
        biz_ref: bizRef,
        pay_channel: channel,
        amount_fen: 1n,
        refunded_fen: 0n,
        status: 'PENDING',
        closing: false,
        needs_manual: false,
        channel_trade_no: null,
        paid_at: null,
        closed_at: null,
      });
      expect(row.out_trade_no).toMatch(OUT_TRADE_NO);
      expect(row.expire_at.getTime()).toBe(f.clock.now().getTime() + TTL_MS);
      expect(row.created_at.getTime()).toBe(f.clock.now().getTime());
      expect(row.launch_issued_at?.getTime()).toBe(f.clock.now().getTime());

      const { launch, ...shown } = normalize(data);
      expect(shown).toEqual(view(row));
      expect(shown).toMatchObject({ amount_fen: 1, refunded_fen: 0, status: 'PENDING' });
      const params = launch as Record<string, unknown>;
      expect(Object.keys(params).sort()).toEqual(LAUNCH_KEYS[channel]);

      const calls = f.channels[channel].createCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ outTradeNo: row.out_trade_no, amountFen: 1n });
      expect(calls[0]!.description).toBe(TITLE);
      expect(calls[0]!.expireAt.getTime()).toBeLessThanOrEqual(row.expire_at.getTime());
      expect(f.channels[channel === 'wechat_pay' ? 'alipay' : 'wechat_pay'].createCalls()).toEqual(
        [],
      );

      const tries = await attempts(f);
      expect(tries).toHaveLength(1);
      expect(tries[0]).toMatchObject({
        pay_order_id: row.id,
        pay_refund_id: null,
        kind: 'query',
        result: 'prepay',
      });
      expect(tries[0]!.at.getTime()).toBe(f.clock.now().getTime());

      for (const key of SECRET_KEYS[channel]) {
        const secret = String(params[key]);
        expect(secret.length).toBeGreaterThan(0);
        expect(
          logs.filter((line) => line.includes(secret)),
          `launch ${key} logged`,
        ).toEqual([]);
      }
      expect(await ledgerRows(f)).toEqual({ vouchers: 0, entries: 0 });
    });
  },
  60_000,
);

it('[AC-B2-15b#14] expire_at = 创建时刻 + pay.order_ttl_minutes（三个时点；配置 30 照用、坏值回默认 15），渠道截止不晚于 expire_at', async () => {
  const cases: Array<{ at: string; ttl?: unknown; minutes: number }> = [
    { at: '2026-10-22T01:00:00.000Z', minutes: 15 },
    { at: '2026-10-22T15:50:00.000Z', minutes: 15 },
    { at: '2028-02-28T23:59:59.999Z', minutes: 15 },
    { at: '2026-10-22T01:00:00.000Z', ttl: 30, minutes: 30 },
    { at: '2026-10-22T01:00:00.000Z', ttl: 'abc', minutes: 15 },
  ];
  for (const item of cases) {
    const f = await fixture(s, item.at);
    await enable(f);
    if (item.ttl !== undefined) await setConfig(f, 'pay.order_ttl_minutes', item.ttl);
    await withHttp(f, async (send) => {
      const data = await success(
        await send('create', { body: createBody(randomUUID(), 'alipay') }),
      );
      const expected = Date.parse(item.at) + item.minutes * 60_000;
      expect(normalize(data)['expire_at'], JSON.stringify(item)).toBe(expected);
      const [row] = await payOrders(f);
      expect(row!.expire_at.getTime()).toBe(expected);
      const call = f.channels.alipay.createCalls()[0];
      expect(call, JSON.stringify(item)).toBeDefined();
      expect(call!.expireAt.getTime()).toBeLessThanOrEqual(expected);
    });
  }
}, 120_000);

it('[AC-B2-15b#15] 每个业务对象一张单：out_trade_no 各不相同、符合格式，且就是传给渠道的单号', async () => {
  const f = await fixture(s);
  await enable(f);
  await withHttp(f, async (send) => {
    const ids: unknown[] = [];
    for (const channel of ['wechat_pay', 'alipay', 'wechat_pay'] as const) {
      const sent = await send('create', { body: createBody(randomUUID(), channel) });
      ids.push((await success(sent))['pay_order_id']);
    }
    const rows = await payOrders(f);
    expect(rows.map((row) => row.id).sort()).toEqual([...ids].sort());
    const numbers = rows.map((row) => row.out_trade_no);
    expect(new Set(numbers).size).toBe(3);
    for (const no of numbers) expect(no).toMatch(OUT_TRADE_NO);
    const given = [...f.channels.wechat_pay.createCalls(), ...f.channels.alipay.createCalls()];
    expect(given.map((call) => call.outTradeNo).sort()).toEqual([...numbers].sort());
  });
}, 60_000);

it('[AC-B2-15b#16] 同一业务对象已有同渠道 PENDING 单：返回原单并重新取调起参数，更新 launch_issued_at，不建新单', async () => {
  const f = await fixture(s);
  await enable(f);
  const body = createBody(randomUUID(), 'wechat_pay');
  await withHttp(f, async (send) => {
    const first = await success(await send('create', { body }));
    const created = await payOrder(f, String(first['pay_order_id']));
    f.clock.advanceMs(60_000);
    const again = await success(await send('create', { body }));
    expect(again['pay_order_id']).toBe(first['pay_order_id']);
    const { launch: launchAgain, ...shownAgain } = normalize(again);
    const { launch: launchFirst } = normalize(first);
    expect(launchAgain).not.toEqual(launchFirst);
    const rows = await payOrders(f);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(shownAgain).toEqual(view(row));
    expect(row.out_trade_no).toBe(created.out_trade_no);
    expect(row.expire_at).toEqual(created.expire_at);
    expect(row.status).toBe('PENDING');
    expect(row.launch_issued_at?.getTime()).toBe(f.clock.now().getTime());
    expect(f.channels.wechat_pay.createCalls()).toHaveLength(2);
    expect((await attempts(f)).map((a) => [a.pay_order_id, a.kind, a.result])).toEqual([
      [row.id, 'query', 'prepay'],
      [row.id, 'query', 'prepay'],
    ]);
  });
}, 60_000);

it('[AC-B2-15b#17] 原单 PENDING 时换渠道：20902 resource=pay_order，不建新单、不向新渠道下单（D10-236 ④）', async () => {
  const f = await fixture(s);
  await enable(f);
  const bizRef = randomUUID();
  await withHttp(f, async (send) => {
    const first = await success(await send('create', { body: createBody(bizRef, 'wechat_pay') }));
    const before = await payOrders(f);
    await answer(await send('create', { body: createBody(bizRef, 'alipay') }), 20902, conflict);
    expect(await payOrders(f)).toEqual(before);
    expect(before.map((row) => row.id)).toEqual([first['pay_order_id']]);
    expect(f.channels.alipay.createCalls()).toEqual([]);
  });
}, 60_000);

it('[AC-B2-15b#18] 原单在关单流程中（closing=true）：同渠道不再返回调起参数、换渠道也不行，都是 20902', async () => {
  const f = await fixture(s);
  await enable(f);
  const issued = new Date(f.clock.now().getTime() - 60_000);
  const closing = await seedOrder(f, {
    closing: true,
    close_reason: 'user_cancel',
    launch_issued_at: issued,
  });
  f.clock.advanceMs(1_000);
  await withHttp(f, async (send) => {
    for (const channel of CHANNELS) {
      const sent = await send('create', { body: createBody(closing.biz_ref, channel) });
      await answer(sent, 20902, conflict);
      expect(sent.json()).not.toHaveProperty('data.launch');
    }
    expect(await payOrders(f)).toEqual([closing]);
    expect(f.channels.wechat_pay.createCalls()).toEqual([]);
    expect(f.channels.alipay.createCalls()).toEqual([]);
    expect(await attempts(f)).toEqual([]);
  });
}, 60_000);

it('[AC-B2-15b#19] 业务对象已有 PAID 单：两个渠道都 30902 data.pay_order_id；只有 CLOSED 单时可以新建', async () => {
  const f = await fixture(s);
  await enable(f);
  const paid = await seedOrder(f, {
    status: 'PAID',
    paid_at: f.clock.now(),
    launch_issued_at: f.clock.now(),
    channel_trade_no: 'FIXTURE-TRADE-1',
  });
  const closed = await seedOrder(f, {
    pay_channel: 'alipay',
    status: 'CLOSED',
    closed_at: f.clock.now(),
    close_reason: 'expired',
  });
  await withHttp(f, async (send) => {
    for (const channel of CHANNELS) {
      await answer(await send('create', { body: createBody(paid.biz_ref, channel) }), 30902, {
        pay_order_id: paid.id,
      });
    }
    expect(f.channels.wechat_pay.createCalls()).toEqual([]);
    expect(f.channels.alipay.createCalls()).toEqual([]);
    const fresh = await success(
      await send('create', { body: createBody(closed.biz_ref, 'wechat_pay') }),
    );
    expect(fresh['pay_order_id']).not.toBe(closed.id);
    const rows = await payOrders(f);
    expect(rows).toHaveLength(3);
    expect(await payOrder(f, closed.id)).toEqual(closed);
    expect(await payOrder(f, paid.id)).toEqual(paid);
    expect(await payOrder(f, String(fresh['pay_order_id']))).toMatchObject({
      biz_ref: closed.biz_ref,
      pay_channel: 'wechat_pay',
      status: 'PENDING',
    });
  });
}, 60_000);

it('[AC-B2-15b#20] 渠道下单结果未知 → 50306 data.pay_channel，单已落库并保持 PENDING；同一业务对象重试取到原单的调起参数', async () => {
  const f = await fixture(s);
  await enable(f);
  const body = createBody(randomUUID(), 'wechat_pay');
  f.channels.wechat_pay.scriptCreate(['unknown']);
  await withHttp(f, async (send, logs) => {
    await answer(await send('create', { body }), 50306, { pay_channel: 'wechat_pay' });
    const [row] = await payOrders(f);
    expect(row).toMatchObject({ status: 'PENDING', closing: false, launch_issued_at: null });
    expect((await attempts(f)).map((a) => [a.pay_order_id, a.kind, a.result])).toEqual([
      [row!.id, 'query', 'unknown'],
    ]);
    f.clock.advanceMs(30_000);
    const retried = await success(await send('create', { body }));
    expect(retried['pay_order_id']).toBe(row!.id);
    const rows = await payOrders(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.out_trade_no).toBe(row!.out_trade_no);
    expect(rows[0]!.status).toBe('PENDING');
    expect(rows[0]!.launch_issued_at?.getTime()).toBe(f.clock.now().getTime());
    expect((await attempts(f)).map((a) => a.result)).toEqual(['unknown', 'prepay']);
    expect(f.channels.wechat_pay.createCalls()).toHaveLength(2);
    const launch = normalize(retried)['launch'] as Record<string, unknown>;
    for (const key of SECRET_KEYS.wechat_pay) {
      const secret = String(launch[key]);
      expect(logs.filter((line) => line.includes(secret))).toEqual([]);
    }
  });
}, 60_000);

interface SwitchCase {
  readonly name: string;
  readonly config: ReadonlyArray<readonly [string, unknown]>;
  readonly channel: PayChannelCode;
  readonly platform: 'ios' | 'android' | 'harmony';
  readonly bizType: string;
  readonly reason: string;
}
const ON = [
  ['pay.enabled', true],
  ['pay.channel_enabled.wechat_pay', true],
  ['pay.channel_enabled.alipay', true],
] as const;
const SWITCH_CASES: SwitchCase[] = [
  {
    name: 'defaults',
    config: [],
    channel: 'wechat_pay',
    platform: 'android',
    bizType: BIZ,
    reason: 'pay_disabled',
  },
  {
    name: 'pay.enabled string',
    config: [['pay.enabled', 'true'], ...ON.slice(1)],
    channel: 'alipay',
    platform: 'android',
    bizType: BIZ,
    reason: 'pay_disabled',
  },
  {
    name: 'pay.enabled false, unregistered type',
    config: [['pay.enabled', false], ...ON.slice(1)],
    channel: 'wechat_pay',
    platform: 'ios',
    bizType: 'unknown_item',
    reason: 'pay_disabled',
  },
  {
    name: 'channel off',
    config: [
      ['pay.enabled', true],
      ['pay.channel_enabled.wechat_pay', true],
    ],
    channel: 'alipay',
    platform: 'android',
    bizType: BIZ,
    reason: 'channel_disabled',
  },
  {
    name: 'channel 1, unregistered type',
    config: [
      ['pay.enabled', true],
      ['pay.channel_enabled.wechat_pay', 1],
    ],
    channel: 'wechat_pay',
    platform: 'android',
    bizType: 'unknown_item',
    reason: 'channel_disabled',
  },
  {
    name: 'platform',
    config: [...ON, ['pay.biz.test_item.platforms', ['android', 'harmony']]],
    channel: 'wechat_pay',
    platform: 'ios',
    bizType: BIZ,
    reason: 'platform_not_allowed',
  },
  {
    name: 'unregistered type with a platforms config',
    config: [...ON, ['pay.biz.unknown_item.platforms', ['ios', 'android', 'harmony']]],
    channel: 'alipay',
    platform: 'android',
    bizType: 'unknown_item',
    reason: 'biz_not_sellable',
  },
];

it('[AC-B2-15b#21] AC-S2-82 ①：开关与可售端不满足 → 30901，reason 依次 pay_disabled / channel_disabled / platform_not_allowed / biz_not_sellable，默认 off，不落单、不调渠道', async () => {
  for (const item of SWITCH_CASES) {
    const f = await fixture(s);
    for (const [key, value] of item.config) await setConfig(f, key, value);
    await withHttp(f, async (send) => {
      const sent = await send('create', {
        body: createBody(randomUUID(), item.channel, item.bizType),
        platform: item.platform,
      });
      await answer(sent, 30901, { reason: item.reason });
      expect(await payOrders(f), item.name).toEqual([]);
      expect(f.channels.wechat_pay.createCalls(), item.name).toEqual([]);
      expect(f.channels.alipay.createCalls(), item.name).toEqual([]);
    });
  }
  // 鸿蒙仍可售：只有 iOS 被 pay.biz.test_item.platforms 排除。
  const f = await fixture(s);
  await enable(f);
  await setConfig(f, 'pay.biz.test_item.platforms', ['android', 'harmony']);
  await withHttp(f, async (send) => {
    const sent = await send('create', {
      body: createBody(randomUUID(), 'wechat_pay'),
      platform: 'harmony',
    });
    await success(sent);
    expect(await payOrders(f)).toHaveLength(1);
  });
}, 180_000);

it('[AC-B2-15b#22] Idempotency-Key：同键同体原样返回首个结果不再下单；同键异体 20901；缺键 20001', async () => {
  const f = await fixture(s);
  await enable(f);
  const key = `pay-${randomUUID()}`;
  const body = createBody(randomUUID(), 'alipay');
  await withHttp(f, async (send) => {
    const first = await send('create', { body, key });
    await success(first);
    const replay = await send('create', { body, key });
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.body).toBe(first.body);
    expect(await payOrders(f)).toHaveLength(1);
    expect(f.channels.alipay.createCalls()).toHaveLength(1);
    expect(await attempts(f)).toHaveLength(1);
    await answer(await send('create', { body: createBody(randomUUID(), 'alipay'), key }), 20901);
    expect(await payOrders(f)).toHaveLength(1);
    const keyless = await send('create', { body: createBody(randomUUID(), 'alipay'), key: null });
    await answer(keyless, 20001);
    expect(await payOrders(f)).toHaveLength(1);
    expect(f.channels.alipay.createCalls()).toHaveLength(1);
  });
}, 60_000);

it('[AC-B2-15b#23] AC-S2-82 ⑩：请求体带金额、标题或身份字段，或渠道不在枚举 → 20001，不落单，金额只由服务端定', async () => {
  const f = await fixture(s);
  await enable(f);
  await withHttp(f, async (send) => {
    const good = createBody(randomUUID(), 'wechat_pay');
    for (const body of [
      { ...good, amount_fen: 100 },
      { ...good, amount: '1.00' },
      { ...good, total_amount: 1 },
      { ...good, title: '自定义标题' },
      { ...good, user_id: f.subject.user_id },
      { ...good, pay_channel: 'balance' },
      { biz_type: BIZ, pay_channel: 'wechat_pay' },
    ]) {
      const sent = await send('create', { body });
      await answer(sent, 20001);
    }
    expect(await payOrders(f)).toEqual([]);
    expect(f.channels.wechat_pay.createCalls()).toEqual([]);
    const data = await success(await send('create', { body: good }));
    expect(data['amount_fen']).toBe(1);
  });
}, 60_000);
