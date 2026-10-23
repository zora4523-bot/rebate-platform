import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  adminOrderFlags,
  lastManualHold,
  normalizeOrderQuery,
  unmappedPendingOpen,
  type AdminOrderPendingRecord,
} from '../../../../apps/api/src/modules/orders/domain/admin-order-view.ts';

const plain = { locked: false, rights_pending: false, hold: false };

it.each([
  ['UNATTRIBUTED', false],
  ['ESTIMATED', false],
  ['WAITING', false],
  ['CREDITED', true],
  ['VOID', true],
  ['CLAWED_BACK', true],
])('[AC-B1-10i#2] rebate_status=%s 时 status_locked=%s（派生，不入库）', (status, locked) => {
  expect(adminOrderFlags({ ...plain, rebate_status: status })).toEqual({
    locked: false,
    status_locked: locked,
    rights_pending: false,
    hold: false,
  });
});

it.each([
  [{ locked: true, rights_pending: false, hold: false, rebate_status: 'ESTIMATED' }],
  [{ locked: false, rights_pending: true, hold: false, rebate_status: 'WAITING' }],
  [{ locked: false, rights_pending: false, hold: true, rebate_status: 'ESTIMATED' }],
  [{ locked: true, rights_pending: true, hold: true, rebate_status: 'CREDITED' }],
  [{ locked: false, rights_pending: false, hold: false, rebate_status: 'VOID' }],
])('[AC-B1-10i#3] 归属锁、维权、暂停照列取值，与 status_locked 互不影响 %j', (row) => {
  expect(adminOrderFlags(row)).toEqual({
    locked: row.locked,
    status_locked: ['VOID', 'CREDITED', 'CLAWED_BACK'].includes(row.rebate_status),
    rights_pending: row.rights_pending,
    hold: row.hold,
  });
});

it.each([
  ['231006-1234567891', '231006-1234567891'],
  ['  231006-1234567891  ', '231006-1234567891'],
  ['\t231006 - 1234 567891\n', '231006-1234567891'],
  ['x', 'x'],
  ['x'.repeat(64), 'x'.repeat(64)],
  [` ${'y'.repeat(64).split('').join(' ')} `, 'y'.repeat(64)],
])('[AC-B1-10i#4] q %j 去首尾空白与内部空格后为 %j', (raw, normalized) => {
  expect(normalizeOrderQuery(raw)).toBe(normalized);
});

it.each(['', '   ', '\t \n', 'x'.repeat(65), ` ${'z'.repeat(65)} `])(
  '[AC-B1-10i#5] q %j 规范化后不在 1–64 字内即不合法',
  (raw) => {
    expect(normalizeOrderQuery(raw)).toBeNull();
  },
);

const open = { reason: 'UNMAPPED_STATUS', status: 'open' };

it.each<[string, AdminOrderPendingRecord[]]>([
  ['只有一条 open', [open]],
  ['已关闭与 open 并存', [{ ...open, status: 'resolved' }, { ...open, status: 'dismissed' }, open]],
  ['夹着别的原因', [{ reason: 'ILLEGAL_TRANSITION', status: 'open' }, open]],
])('[AC-B1-10i#6] UNMAPPED_STATUS 暂停且待处理记录 open：%s → true', (_label, records) => {
  expect(unmappedPendingOpen('UNMAPPED_STATUS', records)).toBe(true);
});

it.each<[string, string | null, AdminOrderPendingRecord[]]>([
  ['没有待处理记录', 'UNMAPPED_STATUS', []],
  ['记录已 resolved', 'UNMAPPED_STATUS', [{ ...open, status: 'resolved' }]],
  ['记录已 dismissed', 'UNMAPPED_STATUS', [{ ...open, status: 'dismissed' }]],
  ['open 的是别的原因', 'UNMAPPED_STATUS', [{ reason: 'ILLEGAL_TRANSITION', status: 'open' }]],
  ['人工 CS 暂停', 'CS', [open]],
  ['人工 RISK 暂停', 'RISK', [open]],
  ['未暂停', null, [open]],
])('[AC-B1-10i#7] %s → unmapped_pending_open=false', (_label, holdReason, records) => {
  expect(unmappedPendingOpen(holdReason, records)).toBe(false);
});

const ADMIN = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b01';
const AT = '2026-10-08T02:00:00.000Z';
const NOTE = '用户反映订单异常，先暂停核实';
const held = { admin_id: ADMIN, note: NOTE, at: new FixedClock(AT).now() };
const none = {
  last_hold_by: null,
  last_hold_by_name: null,
  last_hold_note: null,
  last_hold_at: null,
};

it.each<[string, string | null]>([
  ['当前人工暂停 CS', 'CS'],
  ['当前人工暂停 RISK', 'RISK'],
  ['已恢复（未暂停）', null],
])('[AC-B1-10i#8] %s：取最近一次人工暂停的审计', (_label, holdReason) => {
  expect(lastManualHold(holdReason, held, '客服小林')).toEqual({
    last_hold_by: ADMIN,
    last_hold_by_name: '客服小林',
    last_hold_note: NOTE,
    last_hold_at: AT,
  });
});

it('[AC-B1-10i#9] 从未人工暂停四项为 null；当前为系统 UNMAPPED_STATUS 暂停时旧审计也不显示', () => {
  for (const reason of ['CS', 'RISK', 'UNMAPPED_STATUS', null]) {
    expect(lastManualHold(reason, null, null)).toEqual(none);
  }
  expect(lastManualHold('UNMAPPED_STATUS', held, '客服小林')).toEqual(none);
});

it('[AC-B1-10i#10] 操作人名字取不到时只有名字为 null，其余三项照审计', () => {
  expect(lastManualHold('CS', held, null)).toEqual({
    last_hold_by: ADMIN,
    last_hold_by_name: null,
    last_hold_note: NOTE,
    last_hold_at: AT,
  });
});
