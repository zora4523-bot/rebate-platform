// 02 §11（D10-48）：order.blacklist_hit_after_credit 是正式事件，在业务事务内入队；登记位置按 02 §11 的顺序：
// 紧接 order.attr_binding_conflict 之后、order.snapshot_retry_exhausted 之前。
import { expect, it } from 'vitest';
import { EVENT_NAMES } from '../../../../apps/api/src/modules/platform/events/index.ts';
import { AFTER_CREDIT } from './plan-kit.ts';

it('[AC-B1-09b#8] order.blacklist_hit_after_credit 登记一次，位于 02 §11 的位置', () => {
  const names = [...EVENT_NAMES];
  expect(names.filter((name) => name === AFTER_CREDIT)).toHaveLength(1);
  const at = names.indexOf(AFTER_CREDIT);
  expect(names[at - 1]).toBe('order.attr_binding_conflict');
  expect(names[at + 1]).toBe('order.snapshot_retry_exhausted');
});
