// 单元测试（不连库）：执行器的纯函数。真实 PG 行为由 test/spec/settlement/batch-executor 覆盖。
import { expect, it } from 'vitest';
import { compareItems, previousDay, switchOn, type SortableItem } from './rules.ts';

it('[AC-B2-04p-UNIT#1] 开关只认 true 与 on，缺省、false、off 及其他值都是 off', () => {
  expect(switchOn(true)).toBe(true);
  expect(switchOn('on')).toBe(true);
  for (const value of [false, 'off', undefined, null, 1, 'true', 'ON']) {
    expect(switchOn(value)).toBe(false);
  }
});

it('[AC-B2-04p-UNIT#2] 前一自然日：月内、月初、年初、闰年二月', () => {
  expect(previousDay('2032-07-24')).toBe('2032-07-23');
  expect(previousDay('2032-08-01')).toBe('2032-07-31');
  expect(previousDay('2032-05-01')).toBe('2032-04-30');
  expect(previousDay('2033-01-01')).toBe('2032-12-31');
  expect(previousDay('2032-03-01')).toBe('2032-02-29');
  expect(previousDay('2033-03-01')).toBe('2033-02-28');
});

function item(over: Partial<SortableItem>): SortableItem {
  return {
    id: 'i',
    item_type: 'order',
    platform: 'taobao',
    sub_order_id: 's',
    user_id: null,
    role: null,
    ...over,
  };
}

it('[AC-B2-04p-UNIT#3] 明细按 order_key 升序；同一订单先子订单项、再按用户与角色的补记项', () => {
  const rows = [
    item({ id: '4', sub_order_id: 'b', item_type: 'beneficiary', user_id: 'u2', role: 'self' }),
    item({ id: '3', sub_order_id: 'b', item_type: 'beneficiary', user_id: 'u1', role: 'self' }),
    item({ id: '2', sub_order_id: 'b' }),
    item({ id: '1', sub_order_id: 'a' }),
  ];
  expect([...rows].sort(compareItems).map((r) => r.id)).toEqual(['1', '2', '3', '4']);
});
