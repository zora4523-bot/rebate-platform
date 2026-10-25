// 规划/02 §11：order.reassigned 在后台指派未归因订单时发出（2026-10-18 改），由需要它的任务按 02 §11 的
// 位置登记进 EVENT_NAMES（platform/events 契约第 1 节）：order.settle_adjusted 之后、claim.resolved 之前。
import { expect, it } from 'vitest';
import { EVENT_NAMES } from '../../../../apps/api/src/modules/platform/events/index.ts';

it('[AC-B1-10f#24] EVENT_NAMES 含 order.reassigned 一次，位于 order.settle_adjusted 与 claim.resolved 之间', () => {
  expect(EVENT_NAMES.filter((name) => name === 'order.reassigned')).toHaveLength(1);
  const at = EVENT_NAMES.indexOf('order.reassigned');
  expect(EVENT_NAMES[at - 1]).toBe('order.settle_adjusted');
  expect(EVENT_NAMES[at + 1]).toBe('claim.resolved');
  expect(Object.isFrozen(EVENT_NAMES)).toBe(true);
});
