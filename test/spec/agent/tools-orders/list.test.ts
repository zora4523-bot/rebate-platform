import { expect, it } from 'vitest';
import { wrapUntrusted } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import { handoffCard } from '../../../../apps/api/src/modules/agent/tools/handoff/index.ts';
import type { AgentOrderItem } from '../../../../apps/api/src/modules/orders/index.ts';
import {
  context,
  item,
  LIST,
  okCards,
  orderCards,
  referenceOf,
  rejected,
  setup,
  traceOrders,
} from './kit.ts';

const MAX_SPAN_KEY = 'agent.orders.max_span_days';

/** 三笔合成订单（orders 已按付款时间倒序给出）；字段值彼此可区分。 */
function threeItems(): AgentOrderItem[] {
  return [
    item({
      order_id: '0192f3a1-7c00-7000-8000-00000000d001',
      platform: 'jd',
      title: '合成纯牛奶 <整箱> & 赠品',
      display_status: 'CREDITING',
      reason: 'PRICE_PROTECT',
      est_rebate_fen: 98765,
      expected_credit_period: '2026-12',
    }),
    item({
      order_id: '0192f3a1-7c00-7000-8000-00000000d002',
      platform: 'pdd',
      title: null,
      is_other_product: true,
      display_status: 'WAITING',
      reason: null,
      est_rebate_fen: 4321,
      expected_credit_period: '2026-11',
    }),
    item({
      order_id: '0192f3a1-7c00-7000-8000-00000000d003',
      platform: 'taobao',
      title: '合成燕麦片',
      display_status: 'NO_REBATE',
      reason: 'COMMISSION_ZERO',
      est_rebate_fen: null,
      expected_credit_period: null,
    }),
  ];
}

it.each([
  { label: 'date_to 早于 date_from', args: { date_from: '2026-10-10', date_to: '2026-10-09' } },
  { label: '跨度 91 天（默认上限 90）', args: { date_from: '2026-07-01', date_to: '2026-09-30' } },
  { label: '跨度远超上限', args: { date_from: '2025-10-01', date_to: '2026-10-01' } },
  { label: 'date_to 为明天（+08:00）', args: { date_from: '2026-10-20', date_to: '2026-10-24' } },
])('[AC-B3-08a#4][BR-AI-07] $label → invalid_args，不查订单、不出卡', async ({ args }) => {
  const f = setup();
  expect(await f.execute(LIST, args)).toEqual(rejected);
  expect(f.searchForAgent).not.toHaveBeenCalled();
});

it.each([
  { label: '同一天', args: { date_from: '2026-10-23', date_to: '2026-10-23' } },
  { label: '跨度 89 天', args: { date_from: '2026-07-26', date_to: '2026-10-23' } },
])('[AC-B3-08a#4][BR-AI-07] $label 在默认上限内照常查询', async ({ args }) => {
  const f = setup();
  const outcome = await f.execute(LIST, args);
  expect(outcome.kind).toBe('ok');
  expect(f.searchForAgent).toHaveBeenCalledTimes(1);
  expect(f.searchForAgent.mock.calls[0]?.[1]).toMatchObject(args);
});

it.each([
  { label: '读到 30', value: 30, short: true, long: false },
  { label: '读不到（undefined）', value: undefined, short: true, long: true },
  { label: '非法值（字符串）', value: 'ninety', short: true, long: true },
  { label: '读取抛错', value: 'throw', short: true, long: true },
])(
  '[AC-B3-08a#4][BR-AI-07] 跨度上限配置$label：短区间可查，长区间按上限判断',
  async ({ value, short, long }) => {
    const f = setup();
    f.config.mockImplementation(async (_appId, key) => {
      if (key !== MAX_SPAN_KEY) return undefined;
      if (value === 'throw') throw new Error('合成配置读取失败');
      return value;
    });
    // 29 天在 30 与 90 内；60 天超过 30、在默认 90 内；端点不取上限本身，避免区间开闭歧义。
    const shortArgs = { date_from: '2026-09-24', date_to: '2026-10-23' };
    const longArgs = { date_from: '2026-08-24', date_to: '2026-10-23' };
    const shortOutcome = await f.execute(LIST, shortArgs);
    const longOutcome = await f.execute(LIST, longArgs);
    expect(shortOutcome.kind === 'ok').toBe(short);
    expect(longOutcome.kind === 'ok').toBe(long);
    if (!long) expect(longOutcome).toEqual(rejected);
    expect(f.searchForAgent).toHaveBeenCalledTimes(Number(short) + Number(long));
    expect(f.config).toHaveBeenCalledWith('synthetic-app', MAX_SPAN_KEY);
  },
);

it.each([
  { label: 'UTC 23:30（+08:00 已是次日）', now: '2026-10-22T23:30:00.000Z', today: '2026-10-23' },
  { label: 'UTC 15:30（+08:00 当日 23:30）', now: '2026-10-23T15:30:00.000Z', today: '2026-10-23' },
  { label: 'UTC 16:00（+08:00 次日零点）', now: '2026-10-23T16:00:00.000Z', today: '2026-10-24' },
])('[AC-B3-08a#4][BR-AI-07] 今天按 +08:00 自然日：$label', async ({ now, today }) => {
  const f = setup();
  f.clock.set(now);
  const tomorrow = today === '2026-10-23' ? '2026-10-24' : '2026-10-25';
  const okOutcome = await f.execute(LIST, { date_from: '2026-10-20', date_to: today });
  expect(okOutcome.kind).toBe('ok');
  expect(await f.execute(LIST, { date_from: '2026-10-20', date_to: tomorrow })).toEqual(rejected);
  expect(f.searchForAgent).toHaveBeenCalledTimes(1);
  expect(f.searchForAgent.mock.calls[0]?.[1]).toMatchObject({ date_to: today });
});

it('[AC-B3-08a#5][BR-AI-07][BR-AI-05] 命中时每笔一张 order_status 卡，数据逐字段等于条目且顺序保留', async () => {
  const f = setup();
  const items = threeItems();
  f.searchForAgent.mockResolvedValue({ orders: items, total: 3 });
  const outcome = await f.execute(LIST, { date_from: '2026-10-01', date_to: '2026-10-23' });
  const cards = okCards(outcome);
  const orders = orderCards(cards);
  expect(orders).toHaveLength(3);
  expect(orders.map((card) => card.data)).toEqual(items);
  for (const card of orders) expect(card.schema_version).toBe(1);
  expect(cards.filter((card) => card.type !== 'order_status')).toEqual([]);
  expect(outcome.modelView).toEqual({
    orders: [
      {
        card_id: referenceOf(cards, orders[0]!),
        platform: 'jd',
        title: wrapUntrusted('合成纯牛奶 <整箱> & 赠品'),
      },
      { card_id: referenceOf(cards, orders[1]!), platform: 'pdd', title: null },
      {
        card_id: referenceOf(cards, orders[2]!),
        platform: 'taobao',
        title: wrapUntrusted('合成燕麦片'),
      },
    ],
    total: 3,
    truncated: false,
  });
});

it('[AC-B3-08a#5][BR-AI-05] 模型视图不含 order_id、状态、原因、金额、结算月与单号', async () => {
  const f = setup();
  const items = threeItems();
  f.searchForAgent.mockResolvedValue({ orders: items, total: 3 });
  const outcome = await f.execute(LIST, { date_from: '2026-10-01', date_to: '2026-10-23' });
  expect(okCards(outcome)).toHaveLength(3);
  const view = JSON.stringify(outcome.modelView);
  for (const key of [
    'order_id',
    'display_status',
    'reason',
    'est_rebate_fen',
    'expected_credit_period',
    'is_other_product',
    'order_no',
    'masked_order_no',
    'paid_at',
  ]) {
    expect(view).not.toContain(`"${key}"`);
  }
  for (const value of [
    ...items.map((entry) => entry.order_id),
    'CREDITING',
    'WAITING',
    'NO_REBATE',
    'PRICE_PROTECT',
    'COMMISSION_ZERO',
    '98765',
    '4321',
    '2026-12',
    '2026-11',
    '2026-10',
  ]) {
    expect(view).not.toContain(value);
  }
});

it.each([
  { label: '默认 limit（8）', limit: undefined, returned: 8, total: 9 },
  { label: 'limit 3', limit: 3, returned: 3, total: 5 },
])(
  '[AC-B3-08a#5][BR-AI-07] $label 且 total>limit：truncated=true 并多出 1 张「更多订单」notice',
  async ({ limit, returned, total }) => {
    const f = setup();
    const items = Array.from({ length: returned }, (_, index) =>
      item({ order_id: `0192f3a1-7c00-7000-8000-0000000e00${index}a`, title: '合成商品' }),
    );
    f.searchForAgent.mockResolvedValue({ orders: items, total });
    const args = {
      date_from: '2026-10-01',
      date_to: '2026-10-23',
      ...(limit === undefined ? {} : { limit }),
    };
    const outcome = await f.execute(LIST, args);
    const cards = okCards(outcome);
    expect(orderCards(cards).map((card) => card.data)).toEqual(items);
    const notices = cards.filter((card) => card.type === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.data).toMatchObject({ text_key: 'agent.notice.more_orders' });
    expect(cards).toHaveLength(returned + 1);
    expect(outcome.modelView).toMatchObject({ total, truncated: true });
    expect((outcome.modelView as { orders: unknown[] }).orders).toHaveLength(returned);
    expect(f.searchForAgent.mock.calls[0]?.[1].limit ?? 8).toBe(limit ?? 8);
  },
);

it('[AC-B3-08a#5][BR-AI-07] total 恰等于 limit 时不截断、不出 notice', async () => {
  const f = setup();
  const items = threeItems();
  f.searchForAgent.mockResolvedValue({ orders: items, total: 3 });
  const outcome = await f.execute(LIST, {
    date_from: '2026-10-01',
    date_to: '2026-10-23',
    limit: 3,
  });
  const cards = okCards(outcome);
  expect(cards.filter((card) => card.type === 'notice')).toEqual([]);
  expect(outcome.modelView).toMatchObject({ total: 3, truncated: false });
});

it('[AC-B3-08a#6][BR-AI-07] 0 笔：不出 order_status 卡，只出 1 张 handoff 卡', async () => {
  const f = setup();
  f.searchForAgent.mockResolvedValue({ orders: [], total: 0 });
  const ctx = context();
  const outcome = await f.execute(LIST, { date_from: '2026-10-01', date_to: '2026-10-23' }, ctx);
  const cards = okCards(outcome);
  expect(cards).toEqual([await handoffCard(f.deps.handoff, ctx.appId)]);
  expect(cards[0]?.type).toBe('handoff');
  expect(outcome.modelView).toEqual({ orders: [], total: 0, truncated: false });
});

it('[AC-B3-08a#7][BR-TEXT-02][AC-S1-106③④] keyword 原样交给 orders，agent 不按标题过滤或补查', async () => {
  const f = setup();
  const items = threeItems();
  f.searchForAgent.mockResolvedValue({ orders: items, total: 3 });
  // 返回条目的标题都不含关键词：agent 不得自行再按标题过滤。
  const outcome = await f.execute(LIST, {
    date_from: '2026-10-01',
    date_to: '2026-10-23',
    keyword: 'Milk 牛奶 ',
    platform: 'jd',
  });
  expect(orderCards(okCards(outcome)).map((card) => card.data)).toEqual(items);
  expect(f.searchForAgent).toHaveBeenCalledTimes(1);
  const filter = f.searchForAgent.mock.calls[0]?.[1];
  expect(filter).toMatchObject({
    date_from: '2026-10-01',
    date_to: '2026-10-23',
    keyword: 'Milk 牛奶 ',
    platform: 'jd',
  });
  expect(f.findOwnByNumber).not.toHaveBeenCalled();
  expect(f.get).not.toHaveBeenCalled();
});

it('[AC-B3-08a#7][BR-TEXT-02][AC-S1-106④] is_other_product=true 的条目照出，卡与模型视图标题均为 null', async () => {
  const f = setup();
  const other = item({
    order_id: '0192f3a1-7c00-7000-8000-00000000f001',
    title: null,
    is_other_product: true,
  });
  f.searchForAgent.mockResolvedValue({ orders: [other], total: 1 });
  const outcome = await f.execute(LIST, { date_from: '2026-10-01', date_to: '2026-10-23' });
  const cards = okCards(outcome);
  expect(orderCards(cards).map((card) => card.data)).toEqual([other]);
  expect(outcome.modelView).toEqual({
    orders: [{ card_id: referenceOf(cards, cards[0]!), platform: 'jd', title: null }],
    total: 1,
    truncated: false,
  });
});

it('[AC-B3-08a#11][BR-AI-07] trace.orders 逐笔带 reason_code 与 display_status，模型视图不含之', async () => {
  const f = setup();
  const items = threeItems();
  f.searchForAgent.mockResolvedValue({ orders: items, total: 3 });
  const outcome = await f.execute(LIST, { date_from: '2026-10-01', date_to: '2026-10-23' });
  expect(traceOrders(outcome)).toEqual([
    { reason_code: 'PRICE_PROTECT', display_status: 'CREDITING' },
    { reason_code: null, display_status: 'WAITING' },
    { reason_code: 'COMMISSION_ZERO', display_status: 'NO_REBATE' },
  ]);
  expect(JSON.stringify(outcome.modelView)).not.toContain('reason_code');
});

it('[AC-B3-08a#11][BR-AI-07] 0 笔时 trace.orders 为空数组', async () => {
  const f = setup();
  const outcome = await f.execute(LIST, { date_from: '2026-10-01', date_to: '2026-10-23' });
  expect(traceOrders(outcome)).toEqual([]);
});
