import { inspect } from 'node:util';
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { afterEach, expect, it, vi } from 'vitest';
import { collect, mapped, num, one, pageAnswer, row, rowId, wire } from './kit.ts';

// D10-520：适配器只为金额与付款时点读 validCode，不判订单状态、不丢弃无效单、不按推广位过滤。
afterEach(() => {
  vi.unstubAllEnvs();
});

const iso = (value: Date | null | undefined): string | undefined => value?.toISOString();

it('[AC-B1-04zb#46] 一条已付款订单的完整映射', async () => {
  const dto = await one(row());
  expect(dto).toMatchObject({
    platform: 'jd',
    sub_order_id: '2026103012345678901',
    order_id: '3123456789012345',
    parent_order_id: null,
    item_id: 'synthAseg-Bseg',
    promotion_slot: '3100000001',
    attr_params: { relation_id: null, custom_parameters: null, sub_union_id: 'n_synthetic' },
    raw_status: '16',
    raw_payload_id: null,
    paid_fen: 4560n,
    commission_fen: 123n,
    est_commission_fen: 123n,
    settle_commission_fen: null,
    deposit_paid_at: null,
    received_at: null,
    settled_at: null,
  });
  expect(iso(dto.paid_at)).toBe('2026-10-30T02:00:01.000Z');
  expect(iso(dto.modified_at)).toBe('2026-10-30T02:30:02.000Z');
});

it.each([
  ['n_abc12345', 'n_abc12345'],
  ['', null],
] as const)(
  '[AC-B1-04zb#47] subUnionId %j → sub_union_id %j，attr_params 只有这一项',
  async (text, expected) => {
    const dto = await one(row({ subUnionId: text }));
    expect(dto.attr_params).toEqual({
      relation_id: null,
      custom_parameters: null,
      sub_union_id: expected,
    });
  },
);

it.each(['15', '16', '17', '18', '24', '3', '13', '43'])(
  '[AC-B1-04zb#48] raw_status 是 validCode %s 的字符串，不映射成订单状态',
  async (code) => {
    const dto = await one(row({ validCode: num(code) }));
    expect(dto.raw_status).toBe(code);
    expect(dto.order_status).toBeUndefined();
  },
);

it.each(['16', '17', '18', '-1', '3', '13', '14', '19', '22', '25', '43', '99'])(
  '[AC-B1-04zb#49] validCode %s：paid_at = orderTime，deposit_paid_at 为 null',
  async (code) => {
    const dto = await one(row({ validCode: num(code) }));
    expect(iso(dto.paid_at)).toBe('2026-10-30T02:00:01.000Z');
    expect(dto.deposit_paid_at).toBeNull();
  },
);

it('[AC-B1-04zb#50] validCode 24（已付定金）：deposit_paid_at = orderTime，paid_at 为 null', async () => {
  const dto = await one(row({ validCode: num('24') }));
  expect(iso(dto.deposit_paid_at)).toBe('2026-10-30T02:00:01.000Z');
  expect(dto.paid_at).toBeNull();
});

it('[AC-B1-04zb#51] validCode 15（待付款）：两个付款时点都是 null', async () => {
  const dto = await one(row({ validCode: num('15') }));
  expect(dto.deposit_paid_at).toBeNull();
  expect(dto.paid_at).toBeNull();
});

it('[AC-B1-04zb#52] 缺 validCode 报 invalid_dto：金额与付款时点都靠它分支，不落进「其余码」', async () => {
  await expect(one(row({ validCode: undefined }))).rejects.toMatchObject({
    code: 'invalid_dto',
    platform: 'jd',
  });
});

it('[AC-B1-04zb#53] modifyTime、finishTime 按 GMT+8 解析，跨北京零点落到 UTC 前一天', async () => {
  const dto = await one(
    row({ modifyTime: '2026-11-01 00:00:00', finishTime: '2026-11-01 07:59:59' }),
  );
  expect(iso(dto.modified_at)).toBe('2026-10-31T16:00:00.000Z');
  expect(iso(dto.received_at)).toBe('2026-10-31T23:59:59.000Z');
});

it('[AC-B1-04zb#54] 已完成单的 finishTime 进 received_at，settled_at 仍是 null', async () => {
  const dto = await one(
    row({ validCode: num('17'), finishTime: '2026-10-30 12:00:00', payMonth: num('20261120') }),
  );
  expect(iso(dto.received_at)).toBe('2026-10-30T04:00:00.000Z');
  expect(dto.settled_at).toBeNull();
});

it.each(['UTC', 'America/New_York', 'Asia/Shanghai', 'Asia/Tokyo'])(
  '[AC-B1-04zb#55] 进程时区 %s 下解析结果不变',
  (zone) => {
    vi.stubEnv('TZ', zone);
    const dto = mapped({ finishTime: '2026-10-30 12:00:00' });
    expect(iso(dto.paid_at)).toBe('2026-10-30T02:00:01.000Z');
    expect(iso(dto.modified_at)).toBe('2026-10-30T02:30:02.000Z');
    expect(iso(dto.received_at)).toBe('2026-10-30T04:00:00.000Z');
  },
);

it('[AC-B1-04zb#56] 任意 GMT+8 文本解析回同一时刻', () => {
  const offsetMs = 8 * 3_600_000;
  const seconds = fc.integer({ min: 1_500_000_000, max: 2_000_000_000 });
  const text = (epochSeconds: number): string =>
    new Date(epochSeconds * 1000 + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
  expect(() =>
    fc.assert(
      fc.property(seconds, seconds, seconds, (order, modify, finish) => {
        const dto = mapped({
          orderTime: text(order),
          modifyTime: text(modify),
          finishTime: text(finish),
        });
        return (
          dto.paid_at?.getTime() === order * 1000 &&
          dto.modified_at?.getTime() === modify * 1000 &&
          dto.received_at?.getTime() === finish * 1000
        );
      }),
      propParams(),
    ),
  ).not.toThrow();
});

it.each(['orderTime', 'modifyTime', 'finishTime'])(
  '[AC-B1-04zb#57] %s 不是时间文本 → invalid_dto，不产出 Invalid Date',
  async (field) => {
    await expect(one(row({ [field]: 'not-a-time' }))).rejects.toMatchObject({
      code: 'invalid_dto',
      platform: 'jd',
    });
  },
);

it.each([
  ['finishTime 空串', { finishTime: '' }],
  ['payMonth 整数 0', { payMonth: num('0') }],
  ['payMonth 非零整数', { payMonth: num('20261120') }],
  ['payMonth 字符串', { payMonth: '20261120' }],
  ['payMonth 空串', { payMonth: '' }],
  ['balanceExt 空串', { balanceExt: '' }],
  ['balanceExt 有值', { balanceExt: '合成结算说明' }],
  ['ext1 空串', { ext1: '' }],
  ['pid 空串', { pid: '' }],
] as const)('[AC-B1-04zb#58] 已知偏差 %s 照常接受，DTO 与基准行一致', async (_name, overrides) => {
  expect(await one(row(overrides))).toEqual(await one(row()));
});

it.each([
  ['orderPayTime', 'not-a-time'],
  ['account', 'synthetic-account'],
  ['ext1', 'synthetic-ext'],
  ['pid', 'synthetic-pid'],
  ['commissionRate', num('-1')],
  ['shopId', num('1234')],
] as const)('[AC-B1-04zb#59] 映射之外的字段 %s 不读、不校验', async (field, value) => {
  expect(await one(row({ [field]: value }))).toEqual(await one(row()));
});

it('[AC-B1-04zb#60] 报文额外字段不进 DTO：不 spread、不映射图片，平台专属键不补', async () => {
  const marker = 'synthetic-extra-marker';
  const dto = await one(
    row({
      skuName: marker,
      goodsInfo: { imageUrl: `https://img.invalid/${marker}.jpg` },
      categoryInfo: { name: marker },
    }),
  );
  expect(inspect(dto, { depth: null })).not.toContain(marker);
  for (const field of [
    'skuName',
    'goodsInfo',
    'estimateFee',
    'actualFee',
    'estimateCosPrice',
    'actualCosPrice',
    'payMonth',
    'validCode',
  ]) {
    expect(dto).not.toHaveProperty(field);
  }
  expect(dto.pid).toBeUndefined();
  expect(dto.shop_id).toBeUndefined();
});

it('[AC-B1-04zb#61] 不按推广位或 validCode 过滤：别的推广位、无效单都原样返回', async () => {
  const ids = [rowId(1, 0), rowId(1, 1), rowId(1, 2)] as const;
  const data = [
    row({ id: ids[0], positionId: num('3100000001'), validCode: num('16') }),
    row({ id: ids[1], positionId: num('3199999999'), validCode: num('3') }),
    row({ id: ids[2], positionId: num('0'), subUnionId: '', validCode: num('13') }),
  ];
  const { adapter } = wire(pageAnswer([data]));
  const { orders } = await collect(adapter);
  expect(orders.map((order) => order.sub_order_id)).toEqual(ids);
});
