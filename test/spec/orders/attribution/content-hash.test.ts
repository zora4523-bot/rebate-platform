import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { orderContentHash } from '../../../../apps/api/src/modules/orders/domain/content-hash.ts';
import { orderLockKeyText } from '../../../../apps/api/src/modules/orders/infra/order-lock.ts';
import { at, ATTR, order } from './kit.ts';

it('[AC-B1-08h#19] SHA256 使用排序键、十进制 bigint、ISO 时间，排除 raw_payload_id', () => {
  const input = {
    platform: 'pdd' as const,
    order_id: 'o',
    paid_fen: 9007199254740993n,
    commission_fen: 1n,
    paid_at: at(ATTR),
    raw_payload_id: '8',
  };
  const canonical =
    '{"commission_fen":"1","order_id":"o","paid_at":"2026-10-15T16:00:00.000Z","paid_fen":"9007199254740993","platform":"pdd"}';
  expect(orderContentHash(input)).toBe(createHash('sha256').update(canonical).digest('hex'));
});
it('[AC-B1-08h#20] 字段顺序与页报文 ID 不影响 hash，嵌套对象键同样规范化', () => {
  const a = order({ subsidy_list: [{ z: 1, a: { z: 2, b: 3 } }] });
  const b = {
    ...Object.fromEntries(Object.entries(a).reverse()),
    ...order({ subsidy_list: [{ a: { b: 3, z: 2 }, z: 1 }], raw_payload_id: '202' }),
  };
  const hash = orderContentHash(a);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(orderContentHash(b)).toBe(hash);
  expect(orderContentHash({ ...a, raw_payload_id: null })).toBe(hash);
});
it('[AC-B1-08h#21] 身份、金额、时间、状态、数组顺序与原样参数变化均改变 hash', () => {
  const base = order({ subsidy_list: [1, 2] });
  const hash = orderContentHash(base);
  for (const patch of [
    { sub_order_id: 'different' },
    { paid_fen: 12346n },
    { est_commission_fen: 790n },
    { paid_at: at('2026-10-15T16:00:00.001Z') },
    { raw_status: 'invalid' },
    { promotion_slot: 'another-slot' },
    { subsidy_list: [2, 1] },
    { attr_params: { ...base.attr_params!, custom_parameters: '{ "app":"n","uid":"abcd1234"}' } },
  ])
    expect(orderContentHash({ ...base, ...patch })).not.toBe(hash);
});
it('[AC-B1-08h#22] 锁命名空间精确沿用 platform:sub_order_id，不按 app 或账号分锁', () => {
  expect(orderLockKeyText('pdd', 'child-123')).toBe('orders.order_key:pdd:child-123');
  expect(orderLockKeyText('taobao', 'child-123')).toBe('orders.order_key:taobao:child-123');
});
