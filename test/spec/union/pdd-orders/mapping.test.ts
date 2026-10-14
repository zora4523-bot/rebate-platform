import { expect, it } from 'vitest';
import { collect, ctx, detailRow, incrementReply, oneIncrement, row, setup, win } from './kit.ts';

it('[AC-B1-04i-DTO#1] 订单号取 order_sn、平台 ID 单列，商品安全整数转十进制字符串', async () => {
  const source = row();
  const dto = await oneIncrement(source);
  expect(dto).toMatchObject({
    platform: 'pdd',
    order_id: source.order_sn,
    platform_order_id: source.order_id,
    goods_id: '8123456789012345',
    goods_sign: source.goods_sign,
    pid: source.p_id,
    custom_parameters: source.custom_parameters,
  });
  expect(typeof dto.order_id).toBe('string');
  expect(typeof dto.platform_order_id).toBe('string');
});

it('[AC-B1-04i-DTO#2] 金额为 bigint 分、费率为 bigint 千分比；佣金不预扣服务费、不加补贴', async () => {
  const dto = await oneIncrement(row());
  expect(dto).toMatchObject({
    paid_fen: 8765432n,
    commission_fen: 76543n,
    service_fee_fen: 4321n,
    goods_price_fen: 9876543n,
    platform_discount_fen: 6543n,
    sep_market_fee_fen: 2345n,
    promotion_rate: 127n,
    sep_rate: 19n,
    subsidy_duo_amount_level: 54321n,
    subsidy_duo_amount_ten_million: null,
    subsidy_type: 3,
    subsidy_list: [],
  });
  const changed = await oneIncrement(
    row({ subsidy_duo_amount_level: 999999, subsidy_duo_amount_ten_million: 888888 }),
  );
  expect(changed.subsidy_duo_amount_level).toBe(999999n);
  expect(changed.subsidy_duo_amount_ten_million).toBe(888888n);
  // Only dedicated subsidy columns may vary; all ordinary DTO fields stay identical.
  const { subsidy_duo_amount_level: _a, subsidy_duo_amount_ten_million: _b, ...ordinary } = dto;
  const { subsidy_duo_amount_level: _c, subsidy_duo_amount_ten_million: _d, ...other } = changed;
  void _a;
  void _b;
  void _c;
  void _d;
  expect(other).toEqual(ordinary);
});

it('[AC-B1-04i-DTO#3] 时间按 DTO 注释保留秒级整数；列表不推导售后状态', async () => {
  const dto = await oneIncrement(row());
  expect(dto).toMatchObject({
    order_create_time: 1791936001,
    order_pay_time: 1791936002,
    order_group_success_time: 1791936003,
    order_receive_time: 1791936004,
    order_verify_time: 1791936005,
    order_settle_time: 1791936006,
    order_modify_at: 1791936007,
    url_last_generate_time: null,
    return_status: null,
  });
});

it('[AC-B1-04i-DTO#4] 缺失的可选扩展是 null；JSON 文本原样透传且不要求解析成功', async () => {
  const source = row();
  for (const field of [
    'order_id',
    'p_id',
    'order_status_desc',
    'fail_reason',
    'order_create_time',
    'order_pay_time',
    'order_group_success_time',
    'order_receive_time',
    'order_verify_time',
    'order_settle_time',
    'order_modify_at',
    'duo_id_service_fee',
    'subsidy_duo_amount_level',
    'subsidy_type',
    'subsidy_list',
  ])
    delete source[field];
  source.custom_parameters = ' not valid JSON; preserve this exact text ';
  const dto = await oneIncrement(source);
  expect(dto).toMatchObject({
    platform_order_id: null,
    pid: null,
    order_status_desc: null,
    fail_reason: null,
    order_create_time: null,
    order_pay_time: null,
    order_group_success_time: null,
    order_receive_time: null,
    order_verify_time: null,
    order_settle_time: null,
    order_modify_at: null,
    url_last_generate_time: null,
    service_fee_fen: null,
    subsidy_duo_amount_level: null,
    subsidy_duo_amount_ten_million: null,
    subsidy_type: null,
    subsidy_list: null,
    return_status: null,
    custom_parameters: source.custom_parameters,
  });
});

it.each([0, 1, 2, 3, 4, 5, 10])(
  '[AC-B1-04i-DTO#5] 上游状态 %i 原样保留，不在 adapter 做 order-sync 状态映射',
  async (status) => {
    const dto = await oneIncrement(row({ order_status: status }));
    expect(dto.order_status).toBe(status);
    expect(dto.order_status_desc).toBe('合成审核失败说明');
    expect(dto.fail_reason).toBe('合成失败原因');
    expect(dto.return_status).toBeNull();
  },
);

it('[AC-B1-04i-DTO#6] 明确未获 probe 支持的字段不会因 spread 整份报文进入 DTO', async () => {
  // Deliberately unsupported input probes. These are not authorized mapping fields.
  const unsupported = {
    cps_level: 3,
    share_amount: 777777,
    no_subsidy_reason: 'synthetic-only',
    point_time: 1791936009,
    sku_id_code: 'synthetic-sku',
    request_id: 'synthetic-upstream-request',
  };
  const plain = await oneIncrement(row());
  const polluted = await oneIncrement(row(unsupported));
  expect(polluted).toEqual(plain);
  for (const key of Object.keys(unsupported)) expect(polluted).not.toHaveProperty(key);
});

it('[AC-B1-04i-DTO#7] 安全整数上界保持精确；零金额和零费率不被当作缺失', async () => {
  const dto = await oneIncrement(
    row({
      goods_id: Number.MAX_SAFE_INTEGER,
      order_amount: Number.MAX_SAFE_INTEGER,
      promotion_amount: 0,
      duo_id_service_fee: 0,
      goods_price: 0,
      platform_discount: 0,
      sep_market_fee: 0,
      promotion_rate: 0,
      sep_rate: 0,
    }),
  );
  expect(dto).toMatchObject({
    goods_id: '9007199254740991',
    paid_fen: 9007199254740991n,
    commission_fen: 0n,
    service_fee_fen: 0n,
    goods_price_fen: 0n,
    platform_discount_fen: 0n,
    sep_market_fee_fen: 0n,
    promotion_rate: 0n,
    sep_rate: 0n,
  });
});

const invalidFields: readonly [string, unknown][] = [
  ['order_sn', 12345],
  ['order_sn', ''],
  ['order_sn', undefined],
  ['order_id', 12345],
  ['goods_id', 9007199254740994],
  ['goods_id', 1.25],
  ['order_amount', 1.25],
  ['order_amount', -1],
  ['order_amount', Number.MAX_SAFE_INTEGER + 1],
  ['order_amount', undefined],
  ['promotion_amount', 1.25],
  ['promotion_amount', Number.MAX_SAFE_INTEGER + 1],
  ['promotion_amount', undefined],
  ['duo_id_service_fee', 1.25],
  ['duo_id_service_fee', Number.MAX_SAFE_INTEGER + 1],
  ['goods_price', 1.25],
  ['platform_discount', 1.25],
  ['sep_market_fee', 1.25],
  ['promotion_rate', 1.25],
  ['promotion_rate', Number.MAX_SAFE_INTEGER + 1],
  ['sep_rate', 1.25],
  ['sep_rate', Number.MAX_SAFE_INTEGER + 1],
  ['subsidy_duo_amount_level', 1.25],
  ['order_modify_at', 1.25],
  ['order_create_time', 'not-a-timestamp'],
];

it.each(invalidFields)(
  '[AC-B1-04i-DTO#8] 非整数或不合法字段 %s=%s 报 invalid_dto，不静默舍入',
  async (field, value) => {
    const { adapter } = setup(incrementReply([row({ [field]: value })]));
    await expect(collect(adapter)).rejects.toMatchObject({ code: 'invalid_dto', platform: 'pdd' });
  },
);

it('[AC-B1-04i-DTO#10] 列表不冒充详情补售后；缺失 custom_parameters 保持 null', async () => {
  // return_status is intentionally injected into the wrong API's response.
  const dto = await oneIncrement(row({ return_status: 2, custom_parameters: undefined }));
  expect(dto.return_status).toBeNull();
  expect(dto.custom_parameters).toBeNull();
});

it.each(['increment', 'pay_time'] as const)(
  '[AC-B1-04i-DTO#11] %s 的 order_list 结构损坏不能伪装成成功空页',
  async (mode) => {
    const { adapter } = setup(() => ({ order_list_get_response: { order_list: {} } }));
    await expect(adapter.listOrders(win, { queryMode: mode }, ctx)).rejects.toMatchObject({
      code: 'invalid_dto',
      platform: 'pdd',
    });
  },
);

it.each(['increment', 'pay_time', 'detail'] as const)(
  '[AC-B1-04i-DTO#9] %s 使用同样的精度校验，不能把不安全 goods_id 映射为错误商品',
  async (mode) => {
    const bad = { goods_id: 9007199254740994 };
    const { adapter } = setup(
      mode === 'increment'
        ? incrementReply([row(bad)])
        : () =>
            mode === 'detail'
              ? { order_detail_response: detailRow(bad) }
              : { order_list_get_response: { order_list: [row(bad)], last_order_id: '' } },
    );
    const result =
      mode === 'detail'
        ? adapter.getPddOrderDetail('synthetic-detail', ctx)
        : adapter.listOrders(win, { queryMode: mode }, ctx);
    await expect(result).rejects.toMatchObject({ code: 'invalid_dto', platform: 'pdd' });
  },
);

it('[AC-B1-04i-DTO#12] goods_id 恰好 2^53 按任务允许的边界精确转为十进制字符串', async () => {
  const dto = await oneIncrement(row({ goods_id: 9007199254740992 }));
  expect(dto.goods_id).toBe('9007199254740992');
});
