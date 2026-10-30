// B1-08zc：platform_restore 差错单的 ref_id 与 dedupe_key（编排 9.2 第 3、6 条）。一次作废 / 扣回只出一张单：
// 键里带的是进入当前返利状态的那条 order_status_history 行 id，不是只按 order_key（重新作废后会漏单）。
// 构造函数从 orders 的 index.ts 导出，settlement 的 P9 登记接线复用同一出处。
import { orderKey } from '@couli/domain';
import { expect, it } from 'vitest';
import {
  platformRestoreDedupeKey,
  platformRestoreRefId,
} from '../../../../apps/api/src/modules/orders/index.ts';

const KEY = orderKey('taobao', '5550001');

it('[AC-B1-08zc#1] dedupe_key = platform_restore:{order_key}:{entry_id}', () => {
  expect(platformRestoreDedupeKey(KEY, 41n)).toBe('platform_restore:taobao:5550001:41');
  expect(platformRestoreDedupeKey('pdd:abc-123', 9007199254740993n)).toBe(
    'platform_restore:pdd:abc-123:9007199254740993',
  );
});

it('[AC-B1-08zc#2] ref_id = {order_key}#RESTORE#{entry_id}', () => {
  expect(platformRestoreRefId(KEY, 41n)).toBe('taobao:5550001#RESTORE#41');
  expect(platformRestoreRefId('pdd:abc-123', 9007199254740993n)).toBe(
    'pdd:abc-123#RESTORE#9007199254740993',
  );
});

it('[AC-B1-08zc#3] 同一订单重新作废（新的进入行）得到新键；不同订单同一进入行 id 也不相撞', () => {
  const first = platformRestoreDedupeKey(KEY, 41n);
  const again = platformRestoreDedupeKey(KEY, 57n);
  const other = platformRestoreDedupeKey(orderKey('taobao', '5550002'), 41n);
  expect(new Set([first, again, other]).size).toBe(3);
  expect(platformRestoreRefId(KEY, 41n)).not.toBe(platformRestoreRefId(KEY, 57n));
  // 同一输入总得到同一键（幂等登记依赖它）。
  expect(platformRestoreDedupeKey(KEY, 41n)).toBe(first);
});
