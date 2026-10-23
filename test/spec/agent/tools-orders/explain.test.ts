import { expect, it } from 'vitest';
import { wrapUntrusted } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import type { ToolOutcome } from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { claimDraftCard } from '../../../../apps/api/src/modules/agent/tools/claim/index.ts';
import {
  context,
  EXPLAIN,
  expectNoCards,
  item,
  okCards,
  reference,
  rejected,
  selfDetail,
  setup,
  shareDetail,
  traceOrders,
} from './kit.ts';

/** BR-AI-07 不得出现在模型视图里的订单细节键。 */
const HIDDEN_KEYS = [
  'order_id',
  'display_status',
  'reason',
  'est_rebate_fen',
  'expected_credit_period',
  'order_no',
  'masked_order_no',
  'paid_at',
  'actual_fen',
  'pay_amount_fen',
];

function expectHidden(outcome: ToolOutcome, values: readonly string[]): void {
  const view = JSON.stringify(outcome.modelView);
  for (const key of HIDDEN_KEYS) expect(view).not.toContain(`"${key}"`);
  for (const value of values) expect(view).not.toContain(value);
}

it('[AC-B3-08a#8][BR-AI-07 判定 2] 按 card_id：refs 解析后 orders.get，出 1 张由 8 个字段组成的 order_status 卡', async () => {
  const f = setup();
  const detail = selfDetail();
  f.resolve.mockResolvedValue({ kind: 'order', orderId: detail.order_id });
  f.get.mockResolvedValue(detail);
  const ctx = context();
  const outcome = await f.execute(EXPLAIN, { card_id: 'c7' }, ctx);
  expect(f.resolve).toHaveBeenCalledTimes(1);
  expect(f.resolve.mock.calls[0]?.[0]).toBe('c7');
  expect(f.resolve.mock.calls[0]?.[1]).toMatchObject({
    appId: ctx.appId,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    runId: ctx.runId,
  });
  expect(f.get).toHaveBeenCalledTimes(1);
  expect(f.get.mock.calls[0]?.[1]).toBe(detail.order_id);
  const cards = okCards(outcome);
  expect(cards).toHaveLength(1);
  expect(cards[0]?.type).toBe('order_status');
  expect(cards[0]?.data).toEqual({
    order_id: '0192f3a1-7c00-7000-8000-00000000b001',
    platform: 'taobao',
    title: '合成燕麦片家庭装',
    is_other_product: false,
    display_status: 'WAITING',
    reason: 'PART_REFUND',
    est_rebate_fen: 321,
    expected_credit_period: '2026-12',
  });
  expect(outcome.modelView).toEqual({
    card_id: reference(0),
    platform: 'taobao',
    title: wrapUntrusted('合成燕麦片家庭装'),
  });
  expectHidden(outcome, [
    detail.order_id,
    '3900112233445566778',
    'WAITING',
    'PART_REFUND',
    '321',
    '4590',
    '2026-12',
    '2026-10-20',
    'tb:synthetic-oat',
    'https://',
  ]);
  // 按 card_id 不计次数，也不走单号查询。
  expect(f.take).not.toHaveBeenCalled();
  expect(f.findOwnByNumber).not.toHaveBeenCalled();
  expect(f.searchForAgent).not.toHaveBeenCalled();
});

it('[AC-B3-08a#8][BR-TEXT-02] 按 card_id 命中分享单：卡与模型视图标题为 null，不带打码单号', async () => {
  const f = setup();
  const detail = shareDetail();
  f.resolve.mockResolvedValue({ kind: 'order', orderId: detail.order_id });
  f.get.mockResolvedValue(detail);
  const outcome = await f.execute(EXPLAIN, { card_id: 'c2' });
  const cards = okCards(outcome);
  expect(cards.map((card) => card.data)).toEqual([
    {
      order_id: '0192f3a1-7c00-7000-8000-00000000c001',
      platform: 'pdd',
      title: null,
      is_other_product: true,
      display_status: 'CREDITING',
      reason: null,
      est_rebate_fen: 88,
      expected_credit_period: '2026-11',
    },
  ]);
  expect(outcome.modelView).toEqual({ card_id: reference(0), platform: 'pdd', title: null });
  expect(JSON.stringify(cards)).not.toContain('231023-****5678');
  expectHidden(outcome, [detail.order_id, '231023', 'CREDITING', '2026-11']);
  expect(f.take).not.toHaveBeenCalled();
});

it('[AC-B3-08a#8][BR-AI-03] card_id 解析为 invalid → invalid_args，不查订单、不扣次数', async () => {
  const f = setup();
  f.resolve.mockResolvedValue({ kind: 'invalid' });
  expect(await f.execute(EXPLAIN, { card_id: 'c99' })).toEqual(rejected);
  expect(f.resolve).toHaveBeenCalledTimes(1);
  expect(f.get).not.toHaveBeenCalled();
  expect(f.take).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});

it('[AC-B3-08a#8][BR-AI-03] card_id 指向的订单 get=null → {error:not_found}，无卡、不降级成 claim_draft', async () => {
  const f = setup();
  f.resolve.mockResolvedValue({ kind: 'order', orderId: '0192f3a1-7c00-7000-8000-00000000b009' });
  f.get.mockResolvedValue(null);
  const outcome = await f.execute(EXPLAIN, { card_id: 'c3' });
  expect(outcome.kind).not.toBe('rejected');
  expect(outcome.modelView).toEqual({ error: 'not_found' });
  expectNoCards(outcome);
  expect(f.take).not.toHaveBeenCalled();
  expect(f.findOwnByNumber).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.cardReference).not.toHaveBeenCalled();
});

it('[AC-B3-08a#9][BR-AI-07][BR-AI-14] order_no 的占位符按本 run 还原后交给 findOwnByNumber', async () => {
  const f = setup();
  const ctx = context({ placeholders: { '<num_1>': '990000000001' } });
  await f.execute(EXPLAIN, { order_no: '<num_1>', platform: 'jd' }, ctx);
  expect(f.findOwnByNumber).toHaveBeenCalledTimes(1);
  expect(f.findOwnByNumber.mock.calls[0]?.[1]).toEqual({
    order_no: '990000000001',
    platform: 'jd',
  });
});

it.each([
  {
    label: '占位符不在本次还原表里',
    orderNo: '<num_2>',
    placeholders: { '<num_1>': '990000000001' },
  },
  {
    label: '嵌在文本里的占位符不在还原表里',
    orderNo: 'JD<num_3>',
    placeholders: { '<num_1>': '990000000001' },
  },
  { label: '占位符还原后为空', orderNo: '<num_1>', placeholders: { '<num_1>': '' } },
  { label: '占位符还原后全是空白', orderNo: '<num_1>', placeholders: { '<num_1>': '   ' } },
  { label: '单号本身全是空白', orderNo: '   ', placeholders: { '<num_1>': '990000000001' } },
])(
  '[AC-B3-08a#9][BR-AI-03][BR-AI-14] order_no $label → invalid_args，先拒再扣次数：不扣次数、不查单号、不读点击',
  async ({ orderNo, placeholders }) => {
    const f = setup();
    const ctx = context({ placeholders });
    const outcome = await f.execute(EXPLAIN, { order_no: orderNo, platform: 'jd' }, ctx);
    expect(outcome).toEqual(rejected);
    expect(f.take).not.toHaveBeenCalled();
    expect(f.findOwnByNumber).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.cardReference).not.toHaveBeenCalled();
  },
);

it('[AC-B3-08a#9][BR-AI-07 判定 3] 按单号查不到：出 claim_draft 卡（共享出卡函数），模型只拿 card_id', async () => {
  const f = setup();
  const ctx = context({ placeholders: { '<num_1>': '990000000001' } });
  const outcome = await f.execute(EXPLAIN, { order_no: '<num_1>', platform: 'jd' }, ctx);
  const cards = okCards(outcome);
  expect(cards).toEqual([
    await claimDraftCard(f.deps.claim, ctx, { platform: 'jd', orderNo: '990000000001' }),
  ]);
  expect(cards[0]?.type).toBe('claim_draft');
  expect(cards[0]?.data).toMatchObject({ platform: 'jd', order_no: '990000000001' });
  expect(outcome.modelView).toEqual({ card_id: reference(0) });
  expect(JSON.stringify(outcome.modelView)).not.toContain('990000000001');
});

it('[AC-B3-08a#9][BR-AI-07 判定 3][AC-S1-44③][AC-S1-106②] 不存在 / 他人单 / 本人分享单三种情形响应除单号外完全相同', async () => {
  const f = setup();
  // 三种情形在 orders 内部都表现为 findOwnByNumber=[]（范围与投影在 B3-08f 已完成）。
  const scenarios = [
    { label: '编造的单号', orderNo: '990000000101' },
    { label: '他人名下单号', orderNo: '990000000202' },
    { label: '本人分享单单号', orderNo: '990000000303' },
  ];
  const normalized: unknown[] = [];
  for (const { orderNo } of scenarios) {
    const ctx = context({ placeholders: { '<num_1>': orderNo } });
    const outcome = await f.execute(EXPLAIN, { order_no: '<num_1>', platform: 'jd' }, ctx);
    const cards = okCards(outcome);
    expect(cards.filter((card) => card.type === 'order_status')).toEqual([]);
    expect(cards.map((card) => card.type)).toEqual(['claim_draft']);
    expect(cards[0]?.data['order_no']).toBe(orderNo);
    normalized.push(JSON.parse(JSON.stringify(outcome).replaceAll(orderNo, '<order-no>')));
  }
  expect(normalized[1]).toEqual(normalized[0]);
  expect(normalized[2]).toEqual(normalized[0]);
  expect(f.findOwnByNumber).toHaveBeenCalledTimes(3);
});

it('[AC-B3-08a#9][BR-AI-07 判定 2] 按单号命中本人自购单：1 张 order_status 卡，模型视图 {card_id,platform,title}', async () => {
  const f = setup();
  const hit = item({
    order_id: '0192f3a1-7c00-7000-8000-00000000a777',
    title: '合成矿泉水',
    display_status: 'REVIEWING',
    reason: 'RIGHTS',
  });
  f.findOwnByNumber.mockResolvedValue([hit]);
  const outcome = await f.execute(EXPLAIN, { order_no: '990000000001', platform: 'jd' });
  const cards = okCards(outcome);
  expect(cards.map((card) => card.type)).toEqual(['order_status']);
  expect(cards[0]?.data).toEqual(hit);
  expect(outcome.modelView).toEqual({
    card_id: reference(0),
    platform: 'jd',
    title: wrapUntrusted('合成矿泉水'),
  });
  expectHidden(outcome, [hit.order_id, '990000000001', 'REVIEWING', 'RIGHTS']);
  expect(f.read).not.toHaveBeenCalled();
});

it('[AC-B3-08a#9][BR-AI-07] 父单号命中多个子单：每个子单 1 张卡，模型视图用列表形状', async () => {
  const f = setup();
  const first = item({ order_id: '0192f3a1-7c00-7000-8000-00000000a801', title: '合成甲' });
  const second = item({ order_id: '0192f3a1-7c00-7000-8000-00000000a802', title: '合成乙' });
  f.findOwnByNumber.mockResolvedValue([first, second]);
  const outcome = await f.execute(EXPLAIN, { order_no: '990000000001', platform: 'jd' });
  const cards = okCards(outcome);
  expect(cards.map((card) => card.data)).toEqual([first, second]);
  expect(outcome.modelView).toEqual({
    orders: [
      { card_id: reference(0), platform: 'jd', title: wrapUntrusted('合成甲') },
      { card_id: reference(1), platform: 'jd', title: wrapUntrusted('合成乙') },
    ],
    total: 2,
    truncated: false,
  });
});

// 单号取无法按格式推断平台的合成值：08 原文 platform 缺省且推断不出时查当前用户名下全部平台。
const UNINFERABLE_ORDER_NO = 'SYNTHETIC-ORDER-ABC';

it('[AC-B3-08a#9][BR-AI-07 判定 2] 只给 order_no 不给 platform 命中 1 条：查询不带 platform，1 张卡，模型视图平台取自订单', async () => {
  const f = setup();
  const hit = item({
    order_id: '0192f3a1-7c00-7000-8000-00000000a901',
    platform: 'taobao',
    title: '合成燕麦奶',
    display_status: 'CREDITING',
    reason: null,
  });
  f.findOwnByNumber.mockResolvedValue([hit]);
  const ctx = context();
  const outcome = await f.execute(EXPLAIN, { order_no: UNINFERABLE_ORDER_NO }, ctx);
  expect(f.findOwnByNumber).toHaveBeenCalledTimes(1);
  expect(f.findOwnByNumber.mock.calls[0]?.[0]).toEqual({
    app_id: ctx.appId,
    user_id: ctx.userId,
  });
  const query = f.findOwnByNumber.mock.calls[0]?.[1];
  expect(query).toEqual({ order_no: UNINFERABLE_ORDER_NO });
  expect(query).not.toHaveProperty('platform');
  const cards = okCards(outcome);
  expect(cards.map((card) => card.type)).toEqual(['order_status']);
  expect(cards[0]?.data).toEqual(hit);
  expect(outcome.modelView).toEqual({
    card_id: reference(0),
    platform: 'taobao',
    title: wrapUntrusted('合成燕麦奶'),
  });
  expectHidden(outcome, [hit.order_id, UNINFERABLE_ORDER_NO, 'CREDITING']);
  expect(f.take).toHaveBeenCalledTimes(1);
  expect(f.read).not.toHaveBeenCalled();
});

it('[AC-B3-08a#9][BR-AI-07] 只给 order_no 不给 platform 命中 2 条（不同平台）：每条 1 张卡，模型视图用列表形状', async () => {
  const f = setup();
  const first = item({
    order_id: '0192f3a1-7c00-7000-8000-00000000a911',
    platform: 'jd',
    title: '合成丙',
  });
  const second = item({
    order_id: '0192f3a1-7c00-7000-8000-00000000a912',
    platform: 'pdd',
    title: '合成丁',
  });
  f.findOwnByNumber.mockResolvedValue([first, second]);
  const outcome = await f.execute(EXPLAIN, { order_no: UNINFERABLE_ORDER_NO });
  const query = f.findOwnByNumber.mock.calls[0]?.[1];
  expect(query).toEqual({ order_no: UNINFERABLE_ORDER_NO });
  expect(query).not.toHaveProperty('platform');
  const cards = okCards(outcome);
  expect(cards.map((card) => card.type)).toEqual(['order_status', 'order_status']);
  expect(cards.map((card) => card.data)).toEqual([first, second]);
  expect(outcome.modelView).toEqual({
    orders: [
      { card_id: reference(0), platform: 'jd', title: wrapUntrusted('合成丙') },
      { card_id: reference(1), platform: 'pdd', title: wrapUntrusted('合成丁') },
    ],
    total: 2,
    truncated: false,
  });
  expectHidden(outcome, [first.order_id, second.order_id, UNINFERABLE_ORDER_NO]);
  expect(f.read).not.toHaveBeenCalled();
});

it('[AC-B3-08a#9][BR-AI-07] 无 platform 且按单号查不到：{error:platform_required}，不出卡', async () => {
  const f = setup();
  const outcome = await f.execute(EXPLAIN, { order_no: 'SYNTHETIC-ORDER-ABC' });
  expect(f.findOwnByNumber).toHaveBeenCalledTimes(1);
  expect(f.findOwnByNumber.mock.calls[0]?.[1].order_no).toBe('SYNTHETIC-ORDER-ABC');
  expect(outcome.kind).not.toBe('rejected');
  expect(outcome.modelView).toEqual({ error: 'platform_required' });
  expectNoCards(outcome);
  expect(f.read).not.toHaveBeenCalled();
});

it('[AC-B3-08a#10][BR-AI-07 判定 4] quota.take=false → {error:rate_limited}，无卡、不查单号', async () => {
  const f = setup();
  f.take.mockResolvedValue(false);
  const ctx = context({ placeholders: { '<num_1>': '990000000001' } });
  const outcome = await f.execute(EXPLAIN, { order_no: '<num_1>', platform: 'jd' }, ctx);
  expect(outcome.kind).not.toBe('rejected');
  expect(outcome.modelView).toEqual({ error: 'rate_limited' });
  expectNoCards(outcome);
  expect(f.take).toHaveBeenCalledTimes(1);
  expect(f.take).toHaveBeenCalledWith(ctx.appId, ctx.userId);
  expect(f.findOwnByNumber).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.cardReference).not.toHaveBeenCalled();
});

it('[AC-B3-08a#10][BR-AI-07 判定 4] 每次按单号调用恰扣一次，且在 findOwnByNumber 之前；按 card_id 不扣', async () => {
  const f = setup();
  const ctx = context();
  f.resolve.mockResolvedValue({ kind: 'order', orderId: selfDetail().order_id });
  f.get.mockResolvedValue(selfDetail());
  f.findOwnByNumber.mockResolvedValueOnce([item()]);
  await f.execute(EXPLAIN, { order_no: '990000000001', platform: 'jd' }, ctx);
  await f.execute(EXPLAIN, { card_id: 'c1' }, ctx);
  await f.execute(EXPLAIN, { order_no: '990000000002', platform: 'jd' }, ctx);
  expect(f.take).toHaveBeenCalledTimes(2);
  expect(f.findOwnByNumber).toHaveBeenCalledTimes(2);
  for (const [index, call] of f.take.mock.calls.entries()) {
    expect(call).toEqual([ctx.appId, ctx.userId]);
    expect(f.take.mock.invocationCallOrder[index]).toBeLessThan(
      f.findOwnByNumber.mock.invocationCallOrder[index]!,
    );
  }
});

it('[AC-B3-08a#11][BR-AI-07] explain 命中时 trace.orders 带 reason_code / display_status，未命中为 []', async () => {
  const f = setup();
  const detail = selfDetail();
  f.resolve.mockResolvedValue({ kind: 'order', orderId: detail.order_id });
  f.get.mockResolvedValue(detail);
  const byCard = await f.execute(EXPLAIN, { card_id: 'c1' });
  expect(traceOrders(byCard)).toEqual([{ reason_code: 'PART_REFUND', display_status: 'WAITING' }]);

  f.findOwnByNumber.mockResolvedValueOnce([item({ reason: null, display_status: 'PAID' })]);
  const byNumber = await f.execute(EXPLAIN, { order_no: '990000000001', platform: 'jd' });
  expect(traceOrders(byNumber)).toEqual([{ reason_code: null, display_status: 'PAID' }]);

  const miss = await f.execute(EXPLAIN, { order_no: '990000000002', platform: 'jd' });
  expect(traceOrders(miss)).toEqual([]);
  for (const outcome of [byCard, byNumber, miss]) {
    const view = JSON.stringify(outcome.modelView);
    expect(view).not.toContain('reason_code');
    expect(view).not.toContain('display_status');
  }
});
