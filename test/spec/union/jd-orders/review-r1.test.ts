import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import type { QuotaLimiter } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { expectRedacted, sent, unionFailure } from '../jd-core/kit.ts';
import {
  beijingMs,
  collect,
  ctx,
  dayMs,
  govern,
  inner,
  jsonText,
  mapped,
  nowMs,
  num,
  one,
  pageAnswer,
  reply,
  row,
  rows,
  win,
  wire,
} from './kit.ts';

// 评审 r1 补的用例与负数口径（D10-522）。负数替代 amounts.test.ts #33–#36 里去掉的两行。
const FINISHED_CODES = ['17', '18'] as const;
const UNFINISHED_CODES = ['-1', '2', '3', '13', '15', '16', '19', '22', '24', '25', '43', '99'];

/** 负数原文与它的数学 floor 分值（BR-CALC-26）。 */
const NEGATIVE = [
  ['-0.01', -1n],
  ['-0.001', -1n],
  ['-3.20', -320n],
  ['-3.205', -321n],
  ['-12.3', -1230n],
  ['-12.305', -1231n],
  ['-90071992547409.93', -9007199254740993n],
] as const;

/** D10-520 不用的那个金额字段：取什么值都不影响这一行。 */
const UNREAD_VALUES: readonly (readonly [string, unknown])[] = [
  ['负数', num('-1.00')],
  ['缺字段', undefined],
];

function withUnread(codes: readonly string[]): [string, string, unknown][] {
  return codes.flatMap((code) =>
    UNREAD_VALUES.map(([name, value]): [string, string, unknown] => [code, name, value]),
  );
}

/** 内层成功报文逐键写出，键可以缺，也可以是别的类型。 */
function success(members: Record<string, unknown>): string {
  return jsonText({ code: num('200'), message: 'success', ...members });
}

it.each([
  ['重试成功的那次有归档行', '9007199254741013', '9007199254741013'],
  ['重试成功的那次没有归档行', undefined, null],
] as const)(
  '[AC-B1-04zb#67] 经治理翻页：每次尝试都带归档上下文，行取成功那次尝试的归档行 id（%s）',
  async (_name, retriedId, expected) => {
    const data = rows(1, 3);
    let throttled = false;
    const { adapter, requests, transport } = wire((body) => {
      const page = Number(body.pageIndex);
      if (page === 2 && !throttled) {
        throttled = true;
        return reply(inner([], false, num('429')), '9007199254741012');
      }
      const rawPayloadId = page === 2 ? retriedId : `900719925474100${page}`;
      return reply(inner([data[page - 1]], page < 3), rawPayloadId);
    });
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    const { orders } = await collect(govern(adapter, take));
    expect(requests.map((body) => body.pageIndex)).toEqual([1, 2, 2, 3]);
    expect(orders.map((order) => order.raw_payload_id)).toEqual([
      '9007199254741001',
      expected,
      '9007199254741003',
    ]);
    for (const index of [0, 1, 2, 3]) {
      expect(sent(transport, index).archive).toEqual({ appId: ctx.appId, kind: 'order' });
    }
  },
);

const brokenPages: readonly (readonly [string, Record<string, unknown>])[] = [
  ['data 是 null', { hasMore: false, data: null }],
  ['缺 data', { hasMore: false }],
  ['hasMore 为 true 时 data 是 null', { hasMore: true, data: null }],
  ['hasMore 为 true 时缺 data', { hasMore: true }],
  ['缺 hasMore，有行', { data: [row()] }],
  ['缺 hasMore，空页', { data: [] }],
  ['hasMore 是 null', { hasMore: null, data: [row()] }],
  ['hasMore 是字符串 true', { hasMore: 'true', data: [row()] }],
  ['hasMore 是字符串 false', { hasMore: 'false', data: [row()] }],
  ['hasMore 是数字 1', { hasMore: num('1'), data: [row()] }],
  ['hasMore 是数字 0', { hasMore: num('0'), data: [row()] }],
];

it.each(brokenPages)(
  '[AC-B1-04zb#68] %s 不当作空页或末页：游标不能越过没取到的订单',
  async (_name, members) => {
    const { adapter } = wire(() => reply(success(members)));
    await expect(adapter.listOrders(win, {}, ctx)).rejects.toBeInstanceOf(UnionError);
  },
);

it('[AC-B1-04zb#69] 翻页途中缺 hasMore 同样报错，不截断成末页', async () => {
  const [first, second] = rows(1, 2);
  const { adapter, requests } = wire((body) =>
    body.pageIndex === 1 ? reply(inner([first], true)) : reply(success({ data: [second] })),
  );
  await expect(collect(adapter)).rejects.toBeInstanceOf(UnionError);
  expect(requests.map((body) => body.pageIndex)).toEqual([1, 2]);
});

it.each([
  ['orderTime', ''],
  ['orderTime', null],
  ['orderTime', undefined],
  ['modifyTime', ''],
  ['modifyTime', null],
  ['modifyTime', undefined],
] as const)(
  '[AC-B1-04zb#70] 已付款单 %s 为 %j → invalid_dto：已知偏差里能空的只有 finishTime',
  async (field, value) => {
    await expect(one(row({ [field]: value }))).rejects.toMatchObject({
      code: 'invalid_dto',
      platform: 'jd',
    });
  },
);

it.each(withUnread(UNFINISHED_CODES))(
  '[AC-B1-04zb#71] validCode %s：不读的 actualFee、actualCosPrice 是%s时照常映射',
  async (code, _name, value) => {
    const dto = await one(
      row({
        validCode: num(code),
        actualFee: value,
        actualCosPrice: value,
        estimateCosPrice: num('45.60'),
      }),
    );
    expect(dto.settle_commission_fen).toBeNull();
    expect(dto.paid_fen).toBe(4560n);
  },
);

it.each(withUnread(FINISHED_CODES))(
  '[AC-B1-04zb#72] validCode %s：不读的 estimateCosPrice 是%s时照常映射',
  async (code, _name, value) => {
    const dto = await one(
      row({ validCode: num(code), estimateCosPrice: value, actualCosPrice: num('44.10') }),
    );
    expect(dto.paid_fen).toBe(4410n);
  },
);

it('[AC-B1-04zb#73] 缺 subUnionId 键（白名单外的账号）→ sub_union_id 是 null', async () => {
  const dto = await one(row({ subUnionId: undefined }));
  expect(dto.attr_params).toEqual({
    relation_id: null,
    custom_parameters: null,
    sub_union_id: null,
  });
});

it('[AC-B1-04zb#74] 缺 parentId 键 → parent_order_id 是 null', async () => {
  expect((await one(row({ parentId: undefined }))).parent_order_id).toBeNull();
});

const marker = 'synthetic-row-marker';

it.each([
  ['orderTime 不是时间', { orderTime: marker }],
  ['modifyTime 不是时间', { modifyTime: marker }],
  ['finishTime 不是时间', { finishTime: marker }],
  ['estimateCosPrice 不是数字', { estimateCosPrice: marker }],
  ['已完成单 actualFee 不是数字', { validCode: num('17'), actualFee: marker }],
  ['已完成单 actualCosPrice 不是数字', { validCode: num('17'), actualCosPrice: marker }],
  ['validCode 不是数字', { validCode: marker }],
  ['缺 id', { id: undefined }],
  ['缺 orderId', { orderId: undefined }],
  ['缺 validCode', { validCode: undefined }],
  ['缺 estimateFee', { estimateFee: undefined }],
] as const)('[AC-B1-04zb#75] %s：错误信息不带报文内容', async (_name, overrides) => {
  const orderKey = String(row().id);
  const error = await unionFailure(
    () => one(row({ skuName: marker, subUnionId: marker, ...overrides })),
    'invalid_dto',
  );
  expectRedacted(error, [marker, orderKey]);
});

// 单列一条：这个窗口里 #1 的「终点不越 ceil(to)」不成立，终点必须外扩才能大于起点（照 PDD incrementWindow）。
it('[AC-B1-04zb#76] 整窗落在 90 天界那一秒里：起点收回界内，终点外扩一秒，不发 start == end', async () => {
  const oldestMs = nowMs - 90 * dayMs;
  const iso = (ms: number): string => new Date(ms).toISOString();
  const { adapter, clock, requests } = wire(pageAnswer([[]]));
  clock.advanceMs(500);
  const window = { from: iso(oldestMs + 500), to: iso(oldestMs + 700) };
  await expect(adapter.listOrders(window, {}, ctx)).resolves.toEqual({
    items: [],
    nextCursor: null,
  });
  expect(requests).toHaveLength(1);
  expect(beijingMs(requests[0]!.startTime)).toBe(oldestMs + 1000);
  expect(beijingMs(requests[0]!.endTime)).toBe(oldestMs + 2000);
});

it.each(NEGATIVE)(
  '[AC-B1-04zb#77] estimateFee %s：est 保留 %s 分，commission 取 max(0, est) 即 0',
  async (text, fen) => {
    const dto = await one(row({ estimateFee: num(text) }));
    expect(dto.est_commission_fen).toBe(fen);
    expect(dto.commission_fen).toBe(0n);
  },
);

it.each(
  FINISHED_CODES.flatMap((code) =>
    NEGATIVE.map(([text, fen]): [string, string, bigint] => [code, text, fen]),
  ),
)(
  '[AC-B1-04zb#78] validCode %s：actualFee %s 保留为 settle %s 分，est 与 commission 不受影响',
  async (code, text, fen) => {
    const dto = await one(row({ validCode: num(code), actualFee: num(text) }));
    expect(dto.settle_commission_fen).toBe(fen);
    expect(dto.est_commission_fen).toBe(123n);
    expect(dto.commission_fen).toBe(123n);
  },
);

it.each(NEGATIVE)('[AC-B1-04zb#79] 未完成单 estimateCosPrice %s：paid_fen 取 0n', async (text) => {
  expect((await one(row({ estimateCosPrice: num(text) }))).paid_fen).toBe(0n);
});

it.each(FINISHED_CODES.flatMap((code) => NEGATIVE.map(([text]): [string, string] => [code, text])))(
  '[AC-B1-04zb#80] validCode %s：actualCosPrice %s 时 paid_fen 取 0n',
  async (code, text) => {
    const dto = await one(row({ validCode: num(code), actualCosPrice: num(text) }));
    expect(dto.paid_fen).toBe(0n);
  },
);

/** A negative yuan literal and its fen worked out by hand on bigint: mathematical floor. */
const negativeYuan = fc
  .tuple(fc.bigInt({ min: 0n, max: 10n ** 15n }), fc.stringMatching(/^[0-9]{0,6}$/))
  .map(([whole, tail]) => {
    const exact = whole * 100n + BigInt(tail.slice(0, 2).padEnd(2, '0'));
    const dropped = /[1-9]/.test(tail.slice(2));
    return {
      text: tail === '' ? `-${whole}` : `-${whole}.${tail}`,
      fen: -exact - (dropped ? 1n : 0n),
    };
  });

it('[AC-B1-04zb#81] 任意负的元字符串：est、settle 按数学 floor 保留，commission、paid 收到 0', () => {
  expect(() =>
    fc.assert(
      fc.property(negativeYuan, ({ text, fen }) => {
        const value = num(text);
        const dto = mapped({
          validCode: num('17'),
          estimateFee: value,
          actualFee: value,
          actualCosPrice: value,
        });
        return (
          dto.est_commission_fen === fen &&
          dto.settle_commission_fen === fen &&
          dto.commission_fen === 0n &&
          dto.paid_fen === 0n
        );
      }),
      propParams(),
    ),
  ).not.toThrow();
});
