import { expect, it } from 'vitest';
import {
  deriveDisplayStatus,
  matchesStatusGroup,
  type DisplayStatus,
  type DisplayStatusInput,
} from '../../../../apps/api/src/modules/orders/domain/query-rules.ts';

const base: DisplayStatusInput = {
  rebate_status: 'ESTIMATED',
  platform_status: 'PAID',
  hold: false,
  rights_pending: false,
  booked_base_fen: null,
  b_est: 100n,
  has_clawback: false,
  viewer_share_held: false,
  credit_enabled: true,
  credit_overdue: false,
};
const cases: [string, Partial<DisplayStatusInput>, DisplayStatus | null][] = [
  ['0 未归因优先于所有其他条件', { rebate_status: 'UNATTRIBUTED', hold: true, b_est: 0n }, null],
  ['1 VOID 优先于暂缓', { rebate_status: 'VOID', hold: true }, 'INVALID'],
  ['2 已扣回优先于暂缓', { rebate_status: 'CLAWED_BACK', hold: true }, 'CLAWED_BACK'],
  [
    '3 入账基数零优先于扣回及本人暂缓',
    { rebate_status: 'CREDITED', booked_base_fen: 0n, has_clawback: true, viewer_share_held: true },
    'NO_REBATE',
  ],
  [
    '4 有部分扣回',
    { rebate_status: 'CREDITED', booked_base_fen: 99n, has_clawback: true },
    'CREDITED_PART_CLAWED',
  ],
  ['5 已入账', { rebate_status: 'CREDITED', booked_base_fen: 99n, hold: true }, 'CREDITED'],
  [
    '6 定金优先于零基数及暂缓',
    { platform_status: 'DEPOSIT_PAID', hold: true, b_est: 0n },
    'DEPOSIT_PAID',
  ],
  ['7 ESTIMATED 零基数优先于暂缓', { b_est: 0n, hold: true }, 'NO_REBATE'],
  [
    '7 WAITING 零基数优先于维权',
    { rebate_status: 'WAITING', b_est: 0n, rights_pending: true },
    'NO_REBATE',
  ],
  ['8 暂缓优先于维权', { hold: true, rights_pending: true }, 'REVIEWING'],
  [
    '9 维权优先于关开关',
    { rebate_status: 'WAITING', rights_pending: true, credit_enabled: false },
    'RIGHTS_PENDING',
  ],
  ['10 WAITING 关闭入账开关', { rebate_status: 'WAITING', credit_enabled: false }, 'CREDITING'],
  ['12 WAITING 超期', { rebate_status: 'WAITING', credit_overdue: true }, 'CREDITING'],
  ['13 WAITING 未超期', { rebate_status: 'WAITING' }, 'WAITING'],
  ['14 ESTIMATED', {}, 'PAID'],
  ['未知基数不是零', { b_est: null }, 'PAID'],
  ['WAITING 未知基数不是零', { rebate_status: 'WAITING', b_est: null }, 'WAITING'],
  [
    '已入账本人份额暂缓',
    { rebate_status: 'CREDITED', booked_base_fen: 99n, viewer_share_held: true },
    'REVIEWING',
  ],
  [
    '部分扣回本人份额暂缓',
    {
      rebate_status: 'CREDITED',
      booked_base_fen: 99n,
      has_clawback: true,
      viewer_share_held: true,
    },
    'REVIEWING',
  ],
  ['开关和超期不覆盖 ESTIMATED', { credit_enabled: false, credit_overdue: true }, 'PAID'],
  [
    'WAITING 不误套定金第六行',
    { rebate_status: 'WAITING', platform_status: 'DEPOSIT_PAID' },
    'WAITING',
  ],
];
it.each(cases)('[AC-B1-08l#1] BR-FUND-17 %s', (_label, patch, expected) => {
  expect(deriveDisplayStatus({ ...base, ...patch })).toBe(expected);
});

const groups = {
  estimating: ['DEPOSIT_PAID', 'PAID', 'WAITING', 'CREDITING', 'RIGHTS_PENDING', 'REVIEWING'],
  credited: ['CREDITED', 'CREDITED_PART_CLAWED'],
  no_rebate: ['NO_REBATE', 'INVALID', 'CLAWED_BACK'],
} satisfies Record<string, DisplayStatus[]>;
const statuses = Object.values(groups).flat();
it.each(statuses)('[AC-B1-08l#2] %s 只在指定分组与 all 中', (status) => {
  expect(matchesStatusGroup(status, 'all')).toBe(true);
  for (const group of ['estimating', 'credited', 'no_rebate'] as const) {
    expect(matchesStatusGroup(status, group)).toBe((groups[group] as string[]).includes(status));
  }
});
