import { expect, it } from 'vitest';
import type { TimeWindow } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  ctx,
  DATAOKE_BASE,
  dayMs,
  FOREIGN_ADZONE,
  hourMs,
  iso,
  listed,
  num,
  OTHER_FOREIGN_ADZONE,
  OUR_ADZONE,
  punishAnswer,
  punishData,
  punishments,
  punishOf,
  punishPage,
  PUNISH_PATH,
  punishRow,
  rejection,
  reply,
  RETIRED_ADZONE,
  SETTLE_MONTH,
  setup,
  TRADE_ID,
  VERSION,
  visible,
  win,
} from './kit.ts';

// 违规（任务书「目标口径 · listPunishments / UnionPunish 映射 / 推广位过滤」）：GET
// /api/tb-service/get-foul-order-list v1.0.0；startTime 是窗口起点的北京时间文本，span 是天数（≤ 30），
// 窗口按 30 天一段顺序切，每段 span = min(30, 剩余时长向上取整到天)；段内 pageNo 从 1 起逐页，累计
// 条数达到 total_count（含别家推广位的记录）即该段结束；一次调用一个上游页。映射：order_id = tb_trade_id，
// punishment_id = `<tb_trade_id>:<settle_month>`，deduction_fen = null，punish_status / violation_type /
// settle_month 原样字符串。只留 tk_adzone_id 属于凑狸登记过的全部淘宝推广位（含 retired）的记录。

const fromMs = Date.parse(win.from);
const S0 = '2026-10-30 10:00:00';

function spanning(spanMs: number, startMs = fromMs): TimeWindow {
  return { from: iso(startMs), to: iso(startMs + spanMs) };
}

it('[AC-B1-04z#41] 请求：GET 大淘客 get-foul-order-list（v1.0.0），startTime 是窗口起点的北京时间、span 按天、pageNo 1；不碰淘宝 TOP 网关', async () => {
  const s = setup(punishPage([]));
  await punishments(s.adapter);
  expect(s.transport).toHaveBeenCalledTimes(1);
  const call = s.calls[0]!;
  expect(call.method).toBe('GET');
  expect(call.request.body).toBeUndefined();
  const url = new URL(call.request.url);
  expect(`${url.origin}${url.pathname}`).toBe(`${DATAOKE_BASE}${PUNISH_PATH}`);
  expect(call.query).toMatchObject({ version: VERSION, startTime: S0, span: '1', pageNo: '1' });
  expect(s.taobaoTransport).not.toHaveBeenCalled();
  expect(s.taobaoCredentials).not.toHaveBeenCalled();
});

it.each([
  ['1 小时', hourMs, [[S0, '1']]],
  ['恰好 1 天', dayMs, [[S0, '1']]],
  ['1 天多 1 秒', dayMs + 1000, [[S0, '2']]],
  ['恰好 30 天', 30 * dayMs, [[S0, '30']]],
  [
    '30 天多 1 秒',
    30 * dayMs + 1000,
    [
      [S0, '30'],
      ['2026-11-29 10:00:00', '1'],
    ],
  ],
  [
    '45 天',
    45 * dayMs,
    [
      [S0, '30'],
      ['2026-11-29 10:00:00', '15'],
    ],
  ],
] as const)(
  '[AC-B1-04z#42] 窗口 %s → 按 30 天一段、span 向上取整到天',
  async (_name, spanMs, expected) => {
    const s = setup(punishPage([]));
    await punishments(s.adapter, spanning(spanMs));
    expect(s.requests.map((q) => [q.startTime, q.span])).toEqual(expected);
    expect(s.requests.every((q) => q.pageNo === '1')).toBe(true);
  },
);

it('[AC-B1-04z#43] 起点不是整秒时向下取整，文本是北京时间（跨零点落到次日）', async () => {
  const s = setup(punishPage([]));
  await punishments(s.adapter, { from: '2026-09-30T16:30:00.789Z', to: '2026-09-30T17:30:00Z' });
  expect(s.requests[0]).toMatchObject({ startTime: '2026-10-01 00:30:00', span: '1' });
});

it('[AC-B1-04z#44] 段内按 pageNo 翻页，累计条数达到 total_count 即结束；每次调用只发一个上游请求', async () => {
  const rows = Array.from({ length: 25 }, (_value, index) => punishOf(index + 1));
  const pages = [rows.slice(0, 10), rows.slice(10, 20), rows.slice(20)];
  const s = setup(punishAnswer({ [S0]: pages }));
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let call = 1; call <= 3; call += 1) {
    const page = await listed(
      s.adapter.listPunishments(win, ctx, cursor === undefined ? {} : { cursor }),
    );
    expect(s.transport).toHaveBeenCalledTimes(call);
    seen.push(...page.items.map((punish) => punish.order_id));
    if (call < 3) {
      expect(page.nextCursor).toBeTypeOf('string');
      cursor = page.nextCursor!;
    } else {
      expect(page.nextCursor).toBeNull();
    }
  }
  expect(seen).toEqual(rows.map((input) => input.tb_trade_id));
  expect(s.requests.map((q) => [q.startTime, q.pageNo])).toEqual([
    [S0, '1'],
    [S0, '2'],
    [S0, '3'],
  ]);
});

it('[AC-B1-04z#45] total_count 含别家推广位的记录：别家记录占满的页之后照样翻页，翻满即止', async () => {
  const pages = [
    [punishOf(1, FOREIGN_ADZONE), punishOf(2, FOREIGN_ADZONE)],
    [punishOf(3), punishOf(4, OTHER_FOREIGN_ADZONE)],
  ];
  const s = setup(punishAnswer({ [S0]: pages }));
  const { items } = await punishments(s.adapter);
  expect(items.map((punish) => punish.order_id)).toEqual([punishOf(3).tb_trade_id]);
  expect(s.requests.map((q) => q.pageNo)).toEqual(['1', '2']);
});

it('[AC-B1-04z#46] 多段：一段翻满再进下一段（pageNo 回到 1），空段照样请求', async () => {
  const second = '2026-11-29 10:00:00';
  const third = '2026-12-29 10:00:00';
  const s = setup(
    punishAnswer({
      [S0]: [[punishOf(1)], [punishOf(2)]],
      [second]: [[]],
      [third]: [[punishOf(3)]],
    }),
  );
  const { items } = await punishments(s.adapter, spanning(61 * dayMs));
  expect(s.requests.map((q) => [q.startTime, q.span, q.pageNo])).toEqual([
    [S0, '30', '1'],
    [S0, '30', '2'],
    [second, '30', '1'],
    [third, '1', '1'],
  ]);
  expect(items.map((punish) => punish.order_id)).toEqual(
    [punishOf(1), punishOf(2), punishOf(3)].map((input) => input.tb_trade_id),
  );
});

it('[AC-B1-04z#47] 游标可在新的适配器实例上续拉；别的窗口或不认识的游标 → invalid_dto，不发请求', async () => {
  const answer = punishAnswer({ [S0]: [[punishOf(1)], [punishOf(2)]] });
  const first = setup(answer);
  const page1 = await listed(first.adapter.listPunishments(win, ctx));
  expect(page1.nextCursor).toBeTypeOf('string');

  const second = setup(answer);
  const page2 = await listed(
    second.adapter.listPunishments(win, ctx, { cursor: page1.nextCursor! }),
  );
  expect(second.requests).toEqual([expect.objectContaining({ startTime: S0, pageNo: '2' })]);
  expect(page2.items.map((punish) => punish.order_id)).toEqual([punishOf(2).tb_trade_id]);
  expect(page2.nextCursor).toBeNull();

  const third = setup(answer);
  const attempts: [TimeWindow, string][] = [
    [spanning(2 * hourMs), page1.nextCursor!],
    [win, 'garbage'],
    [win, '%%%'],
  ];
  for (const [other, cursor] of attempts) {
    await rejection(() => third.adapter.listPunishments(other, ctx, { cursor }), 'invalid_dto');
  }
  expect(third.transport).not.toHaveBeenCalled();
});

it('[AC-B1-04z#48] 维权的游标拿来续拉违规 → invalid_dto，不发违规请求', async () => {
  const s = setup((call) =>
    call.path.endsWith(PUNISH_PATH)
      ? reply(punishData([], 0))
      : reply({
          has_next: true,
          has_pre: false,
          position_index: '1793300000_|1793300001_',
          result: [],
        }),
  );
  const refundPage = await listed(s.adapter.listRefunds(win, ctx));
  expect(refundPage.nextCursor).toBeTypeOf('string');
  await rejection(
    () => s.adapter.listPunishments(win, ctx, { cursor: refundPage.nextCursor! }),
    'invalid_dto',
  );
  expect(s.calls.filter((call) => call.path.endsWith(PUNISH_PATH))).toEqual([]);
});

it.each([
  ['相等', { from: win.from, to: win.from }],
  ['逆序', { from: win.to, to: win.from }],
  ['起点不是时刻', { from: 'not-a-time', to: win.to }],
] as const)('[AC-B1-04z#49] 时间窗%s → invalid_dto，不读推广位、不发请求', async (_name, bad) => {
  const s = setup(punishPage([]));
  await rejection(() => s.adapter.listPunishments(bad, ctx), 'invalid_dto');
  expect(s.transport).not.toHaveBeenCalled();
  expect(s.dataokeCredentials).not.toHaveBeenCalled();
  expect(s.orderSlots).not.toHaveBeenCalled();
});

it('[AC-B1-04z#50] 一页没有记录而累计仍不足 total_count → upstream_unavailable（不原地打转）', async () => {
  const s = setup(({ query }) =>
    reply(punishData(query.pageNo === '1' ? [punishOf(1)] : [], 5, Number(query.pageNo))),
  );
  const first = await listed(s.adapter.listPunishments(win, ctx));
  expect(first.nextCursor).toBeTypeOf('string');
  await rejection(
    () => s.adapter.listPunishments(win, ctx, { cursor: first.nextCursor! }),
    'upstream_unavailable',
  );
  expect(s.requests.map((q) => q.pageNo)).toEqual(['1', '2']);
});

it.each([
  ['total_count 缺失', punishData([punishOf(1)], null)],
  ['results 不是数组', { ...punishData([], 1), results: { list: [] } }],
])('[AC-B1-04z#51] %s → upstream_unavailable', async (_name, data) => {
  const s = setup(() => reply(data));
  await rejection(() => s.adapter.listPunishments(win, ctx), 'upstream_unavailable');
});

it('[AC-B1-04z#52] total_count 为 0、没有记录 → 一次请求、空页', async () => {
  const s = setup(() => reply(punishData([], 0)));
  const page = await listed(s.adapter.listPunishments(win, ctx));
  expect(page).toEqual({ items: [], nextCursor: null });
  expect(s.transport).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04z#53] 映射：order_id、稳定的 punishment_id、deduction_fen = null，状态与月份原样字符串', async () => {
  const s = setup(punishPage([punishRow()]));
  const { items } = await punishments(s.adapter);
  expect(items).toEqual([
    {
      order_id: TRADE_ID,
      punishment_id: `${TRADE_ID}:${SETTLE_MONTH}`,
      deduction_fen: null,
      punish_status: '0',
      violation_type: '1',
      settle_month: SETTLE_MONTH,
    },
  ]);

  // 同一条记录再拉一次，键不变；换个结算月就是另一条处罚。
  const again = setup(punishPage([punishRow({ settle_month: num(SETTLE_MONTH) })]));
  const next = await punishments(again.adapter);
  expect(next.items.map((punish) => punish.punishment_id)).toEqual([`${TRADE_ID}:${SETTLE_MONTH}`]);
  const other = setup(punishPage([punishRow({ settle_month: '202611' })]));
  const later = await punishments(other.adapter);
  expect(later.items.map((punish) => punish.punishment_id)).toEqual([`${TRADE_ID}:202611`]);
});

it('[AC-B1-04z#54] tb_trade_id 是 JSON 整数时取十进制原文；状态字段缺失 → null', async () => {
  const s = setup(
    punishPage([
      punishRow({
        tb_trade_id: num('2900000000000000777'),
        punish_status: undefined,
        violation_type: null,
      }),
    ]),
  );
  const { items } = await punishments(s.adapter);
  expect(items).toEqual([
    {
      order_id: '2900000000000000777',
      punishment_id: `2900000000000000777:${SETTLE_MONTH}`,
      deduction_fen: null,
      punish_status: null,
      violation_type: null,
      settle_month: SETTLE_MONTH,
    },
  ]);
});

it.each([
  ['tb_trade_id', undefined],
  ['tb_trade_id', ''],
  ['tb_trade_id', null],
  ['settle_month', undefined],
  ['settle_month', ''],
  ['settle_month', '--'],
] as const)(
  '[AC-B1-04z#55] %s 为 %s → 跳过该条并告警（带字段名），同页其他记录不受影响',
  async (field, value) => {
    const s = setup(punishPage([punishRow({ [field]: value }), punishOf(2)]));
    const { items } = await punishments(s.adapter);
    expect(items.map((punish) => punish.order_id)).toEqual([punishOf(2).tb_trade_id]);
    expect(s.punishWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'taobao_punish_row_skipped', field }),
    );
  },
);

it('[AC-B1-04z#56] 只留我方推广位（含已停用）的记录；别家不返回，整页只打一条计数告警，不带订单号与推广位', async () => {
  const s = setup(
    punishPage([
      punishOf(1, OUR_ADZONE),
      punishOf(2, FOREIGN_ADZONE),
      punishOf(3, RETIRED_ADZONE),
      punishOf(4, OTHER_FOREIGN_ADZONE),
    ]),
  );
  const { items } = await punishments(s.adapter);
  expect(items.map((punish) => punish.order_id)).toEqual([
    punishOf(1).tb_trade_id,
    punishOf(3).tb_trade_id,
  ]);
  const foreign = s.punishWarn.mock.calls.filter(
    ([event]) => event.event === 'taobao_punish_foreign_slot',
  );
  expect(foreign).toEqual([[expect.objectContaining({ count: 2 })]]);
  const printed = visible(foreign);
  for (const marker of [
    String(punishOf(2).tb_trade_id),
    String(punishOf(4).tb_trade_id),
    FOREIGN_ADZONE,
    OTHER_FOREIGN_ADZONE,
  ]) {
    expect(printed).not.toContain(marker);
  }
});

it('[AC-B1-04z#57] 只按 PID 最后一段整段比对；tk_adzone_id 缺失或不是整数的记录不当作我方', async () => {
  const s = setup(
    punishPage([
      punishOf(1, OUR_ADZONE),
      punishRow({ tb_trade_id: '2900000000000000301', tk_adzone_id: undefined }),
      punishRow({ tb_trade_id: '2900000000000000302', tk_adzone_id: 'not-a-number' }),
      punishRow({ tb_trade_id: '2900000000000000303', tk_adzone_id: num('123456789034.5') }),
    ]),
    {
      slots: [
        `mm_1000000001_3000000001_${OUR_ADZONE}0`,
        `mm_1000000001_${OUR_ADZONE}_999999999998`,
        `mm_1000000001_3000000001_${RETIRED_ADZONE}`,
      ],
    },
  );
  const { items } = await punishments(s.adapter);
  expect(items).toEqual([]);
  expect(s.punishWarn).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'taobao_punish_foreign_slot', count: 4 }),
  );
});

it('[AC-B1-04z#58] tk_adzone_id 是十进制字符串时同样比对', async () => {
  const s = setup(punishPage([punishRow({ tk_adzone_id: OUR_ADZONE })]));
  const { items } = await punishments(s.adapter);
  expect(items.map((punish) => punish.order_id)).toEqual([TRADE_ID]);
});

it('[AC-B1-04z#59] 推广位清单经注入端口、以本次调用的上下文读取；清单为空 → 不取凭据、不发请求，空页，告警一次', async () => {
  const wired = setup(punishPage([punishOf(1)]));
  await listed(wired.adapter.listPunishments(win, ctx));
  expect(wired.orderSlots).toHaveBeenCalled();
  expect(wired.orderSlots.mock.calls[0]![0]).toMatchObject({ appId: ctx.appId });

  const empty = setup(punishPage([punishOf(1)]), { slots: [] });
  const page = await listed(empty.adapter.listPunishments(win, ctx));
  expect(page).toEqual({ items: [], nextCursor: null });
  expect(empty.orderSlots).toHaveBeenCalledTimes(1);
  expect(empty.transport).not.toHaveBeenCalled();
  expect(empty.dataokeCredentials).not.toHaveBeenCalled();
  expect(empty.punishWarn.mock.calls).toEqual([
    [expect.objectContaining({ event: 'taobao_punish_no_slots' })],
  ]);
});

it.each([
  ['没有大淘客订单源', { source: false }],
  ['没有推广位端口', { slots: null }],
] as const)(
  '[AC-B1-04z#60] %s → adapter_unimplemented，不取凭据、不发请求',
  async (_name, options) => {
    const s = setup(punishPage([punishOf(1)]), options);
    await rejection(() => s.adapter.listPunishments(win, ctx), 'adapter_unimplemented');
    expect(s.transport).not.toHaveBeenCalled();
    expect(s.dataokeCredentials).not.toHaveBeenCalled();
    expect(s.taobaoCredentials).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04z#61] 归档上下文是调用方 app 与 kind=order；直接调用把 ctx.signal 挂在传输请求上', async () => {
  const controller = new AbortController();
  const s = setup(punishPage([]));
  await listed(s.adapter.listPunishments(win, { ...ctx, signal: controller.signal }));
  const request = s.calls[0]!.request;
  expect(request.archive).toEqual({ appId: ctx.appId, kind: 'order' });
  expect(request.signal).toBe(controller.signal);
});
