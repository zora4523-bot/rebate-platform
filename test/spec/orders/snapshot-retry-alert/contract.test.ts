import { expect, it } from 'vitest';
import { EVENT_NAMES } from '../../../../apps/api/src/modules/platform/events/index.ts';

it('[AC-B1-08u#1] 耗尽告警登记一次并位于规划事件清单末尾', () => {
  const names = [...EVENT_NAMES];
  expect(names.filter((name) => name === 'order.snapshot_retry_exhausted')).toHaveLength(1);
  expect(names.at(-1)).toBe('order.snapshot_retry_exhausted');
  // blacklist 尚可待登记；登记后也必须排在本事件之前。
  expect(names.indexOf('order.blacklist_hit_after_credit')).toBeLessThan(names.length - 1);
});
