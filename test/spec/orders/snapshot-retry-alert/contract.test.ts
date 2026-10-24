import { expect, it } from 'vitest';
import { EVENT_NAMES } from '../../../../apps/api/src/modules/platform/events/index.ts';

// 02 §11 在本事件之后又加了四个事件（SPEC_REF bafa96ce 起；B2-04wc test-change）：本事件之后只能出现这些名字。
const PLAN_02_AFTER_RETRY_EXHAUSTED = [
  'order.snapshot_created',
  'user.realname_corrected',
  'asset_snapshot.timed_out',
  'union_receivable.exposure_exceeded',
  // 02 §11 收款：支付成功（D10-338，couli #204）
  'pay_order.paid',
  // 02 §11 收款：退款成功（D10-340 / D10-349，couli #208）
  'pay_refund.succeeded',
];

it('[AC-B1-08u#1] 耗尽告警登记一次并位于规划事件清单中的位置（其后只有 02 §11 排在它之后的事件）', () => {
  const names = [...EVENT_NAMES];
  expect(names.filter((name) => name === 'order.snapshot_retry_exhausted')).toHaveLength(1);
  const at = names.indexOf('order.snapshot_retry_exhausted');
  expect(at).toBeGreaterThanOrEqual(0);
  const after = names.slice(at + 1);
  expect(after.every((name) => PLAN_02_AFTER_RETRY_EXHAUSTED.includes(name))).toBe(true);
  // blacklist 尚可待登记；登记后也必须排在本事件之前。
  expect(names.indexOf('order.blacklist_hit_after_credit')).toBeLessThan(at);
});
