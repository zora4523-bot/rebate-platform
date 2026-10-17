import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  buildTimeline,
  deriveDisplayStatus,
  maskOrderNo,
  matchesStatusGroup,
  orderReasonActions,
  visibleOrderStart,
  type DisplayStatusInput,
} from './query-rules.ts';

const base: DisplayStatusInput = {
  rebate_status: 'WAITING',
  platform_status: 'PAID',
  hold: false,
  rights_pending: false,
  booked_base_fen: null,
  b_est: null,
  has_clawback: false,
  viewer_share_held: false,
  credit_enabled: true,
  credit_overdue: false,
};

it('[AC-B1-08l#1] 未知基数 null 不当零，WAITING 开关关闭进入 CREDITING', () => {
  expect(deriveDisplayStatus(base)).toBe('WAITING');
  expect(deriveDisplayStatus({ ...base, credit_enabled: false })).toBe('CREDITING');
  expect(deriveDisplayStatus({ ...base, b_est: 0n })).toBe('NO_REBATE');
  expect(deriveDisplayStatus({ ...base, rebate_status: 'UNATTRIBUTED' })).toBeNull();
});

it('[AC-B1-08l#2] all 包含任意状态，分组互斥', () => {
  expect(matchesStatusGroup('CLAWED_BACK', 'all')).toBe(true);
  expect(matchesStatusGroup('CLAWED_BACK', 'no_rebate')).toBe(true);
  expect(matchesStatusGroup('CLAWED_BACK', 'credited')).toBe(false);
});

it('[AC-B1-08l#3] 脱敏长度边界按码点计', () => {
  expect(maskOrderNo('123456789')).toBe('****89');
  expect(maskOrderNo('1234567890')).toBe('1234****90');
  expect(maskOrderNo('')).toBe('****');
});

it('[AC-B1-08l#4] 可查范围跨年回推，非正数与非整数不限制', () => {
  const clock = new FixedClock('2028-02-10T00:00:00.000Z');
  expect(visibleOrderStart(clock, 2)).toBe('2027-12-01');
  expect(visibleOrderStart(clock, 14)).toBe('2026-12-01');
  expect(visibleOrderStart(clock, -1)).toBeNull();
  expect(visibleOrderStart(clock, 1.5)).toBeNull();
});

it('[AC-B1-08l#5] 原因动作返回新数组，不共享常量', () => {
  const first = orderReasonActions('BLACKLIST');
  first.push('X');
  expect(orderReasonActions('BLACKLIST')).toEqual(['APPEAL']);
  expect(orderReasonActions('REFUND')).toEqual([]);
});

it('[AC-B1-08l#9] 非 credit_expected 节点 period 为 null，未知事件不追加', () => {
  const items = buildTimeline({
    is_presale: false,
    platform_status: 'PAID',
    display_status: 'WAITING',
    deposit_paid_at: null,
    paid_at: '2027-12-01T00:00:00.000Z',
    received_at: null,
    credited_at: null,
    expected_credit_period: '2028-01',
    invalid_at: '2027-12-02T00:00:00.000Z',
    clawed_at: null,
    part_clawed_at: null,
  });
  expect(items.map((item) => item.node)).toEqual([
    'paid',
    'received',
    'credit_expected',
    'credited',
  ]);
  expect(items.filter((item) => item.period !== null)).toEqual([
    { node: 'credit_expected', at: null, period: '2028-01' },
  ]);
});
