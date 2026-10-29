import { expect, it } from 'vitest';
import type { CreditedDayRow } from '../infra/earnings-summary-store.ts';
import {
  assembleEarningsSummary,
  chinaTimestamp,
  earningsPeriods,
  previousDay,
  previousMonth,
  type EarningsOrderFacts,
} from './earnings-summary.ts';

const NOV_12 = new Date('2026-11-12T02:00:00.000Z'); // 2026-11-12 10:00 +08:00

it('[AC-B2-13a-UNIT#1] 期间按 +08:00 自然日与自然月：今日、昨日、本月、上月与两个窗口', () => {
  expect(earningsPeriods(NOV_12)).toEqual({
    today: '2026-11-12',
    yesterday: '2026-11-11',
    thisMonth: '2026-11',
    lastMonth: '2026-10',
    paidFrom: '2026-10-01T00:00:00+08:00',
    paidTo: '2026-12-01T00:00:00+08:00',
    dateFrom: '2026-10-01',
    dateTo: '2026-12-01',
  });
  // UTC 仍是 10-31，+08:00 已是 11-01。
  expect(earningsPeriods(new Date('2026-10-31T16:00:00.000Z'))).toMatchObject({
    today: '2026-11-01',
    yesterday: '2026-10-31',
    thisMonth: '2026-11',
    lastMonth: '2026-10',
  });
});

it('[AC-B2-13a-UNIT#2] 跨年：2027-01-01 00:00 +08:00 的昨日是 2026-12-31、上月是 2026-12', () => {
  expect(earningsPeriods(new Date('2026-12-31T16:00:00.000Z'))).toEqual({
    today: '2027-01-01',
    yesterday: '2026-12-31',
    thisMonth: '2027-01',
    lastMonth: '2026-12',
    paidFrom: '2026-12-01T00:00:00+08:00',
    paidTo: '2027-02-01T00:00:00+08:00',
    dateFrom: '2026-12-01',
    dateTo: '2027-02-01',
  });
});

it('[AC-B2-13a-UNIT#3] 前一日与前一月：月初、闰年二月、世纪年', () => {
  expect(previousDay('2026-11-12')).toBe('2026-11-11');
  expect(previousDay('2026-05-01')).toBe('2026-04-30');
  expect(previousDay('2026-08-01')).toBe('2026-07-31');
  expect(previousDay('2026-03-01')).toBe('2026-02-28');
  expect(previousDay('2028-03-01')).toBe('2028-02-29');
  expect(previousDay('2100-03-01')).toBe('2100-02-28');
  expect(previousDay('2000-03-01')).toBe('2000-02-29');
  expect(previousDay('2027-01-01')).toBe('2026-12-31');
  expect(previousMonth('2027-01')).toBe('2026-12');
  expect(previousMonth('2026-10')).toBe('2026-09');
  expect(() => previousDay('2026-1-01')).toThrow(RangeError);
  expect(() => previousMonth('2026/01')).toThrow(RangeError);
});

it('[AC-B2-13a-UNIT#4] as_of 是同一时刻的 +08:00 表示', () => {
  expect(chinaTimestamp(NOV_12)).toBe('2026-11-12T10:00:00.000+08:00');
  const late = new Date('2026-10-31T16:30:05.123Z');
  expect(chinaTimestamp(late)).toBe('2026-11-01T00:30:05.123+08:00');
  expect(Date.parse(chinaTimestamp(late))).toBe(late.getTime());
});

const EMPTY_PERIOD = { paid_count: 0, est_fen: 0, credited_fen: 0 };
const EMPTY_COLUMN = {
  today: EMPTY_PERIOD,
  yesterday: EMPTY_PERIOD,
  this_month: EMPTY_PERIOD,
  last_month: EMPTY_PERIOD,
};

it('[AC-B2-13a-UNIT#5] 订单按 paid_at 归期计笔数与预估；分录按会计日取 −Σ amount_fen，只有红冲的期间为负', () => {
  const now = new Date('2026-10-31T16:30:00.000Z'); // 11-01 00:30 +08:00
  const orders: EarningsOrderFacts = {
    own: [
      { buyType: 'self', paidAt: new Date('2026-10-31T16:00:00.000Z'), estFen: 17n }, // 11-01
      { buyType: 'self', paidAt: new Date('2026-10-31T15:59:59.999Z'), estFen: 34n }, // 10-31
      { buyType: 'self', paidAt: new Date('2026-10-10T02:00:00.000Z'), estFen: 0n }, // 10-10 已入账
      { buyType: 'share', paidAt: new Date('2026-10-30T16:00:00.000Z'), estFen: 68n }, // 10-31
    ],
    referral: [
      { paidAt: new Date('2026-10-31T16:10:00.000Z'), estFen: 85n }, // 本月
      { paidAt: new Date('2026-10-31T15:00:00.000Z'), estFen: 9n }, // 上月（昨日也不给）
    ],
  };
  const credited: CreditedDayRow[] = [
    { ledgerType: 'REBATE_CREDIT', day: '2026-11-01', amountFen: -520n },
    { ledgerType: 'REBATE_CREDIT', day: '2026-10-31', amountFen: -180n },
    { ledgerType: 'REBATE_CREDIT', day: '2026-10-01', amountFen: -1000n },
    { ledgerType: 'SHARE_CREDIT', day: '2026-11-01', amountFen: 260n },
    { ledgerType: 'SHARE_CREDIT', day: '2026-10-20', amountFen: -260n },
    { ledgerType: 'REFERRAL_CREDIT', day: '2026-11-01', amountFen: -70n },
    { ledgerType: 'REFERRAL_CREDIT', day: '2026-10-20', amountFen: -15n },
  ];
  const data = assembleEarningsSummary({
    now,
    periods: earningsPeriods(now),
    orders,
    credited,
    referralVisible: true,
  });
  expect(data).toEqual({
    as_of: '2026-11-01T00:30:00.000+08:00',
    self: {
      today: { paid_count: 1, est_fen: 17, credited_fen: 520 },
      yesterday: { paid_count: 1, est_fen: 34, credited_fen: 180 },
      this_month: { paid_count: 1, est_fen: 17, credited_fen: 520 },
      last_month: { paid_count: 2, est_fen: 34, credited_fen: 1180 },
    },
    share: {
      today: { paid_count: 0, est_fen: 0, credited_fen: -260 },
      yesterday: { paid_count: 1, est_fen: 68, credited_fen: 0 },
      this_month: { paid_count: 0, est_fen: 0, credited_fen: -260 },
      last_month: { paid_count: 1, est_fen: 68, credited_fen: 260 },
    },
    referral: {
      this_month: { est_fen: 85, credited_fen: 70 },
      last_month: { est_fen: 9, credited_fen: 15 },
    },
  });
});

it('[AC-B2-13a-UNIT#6] 没有收益时三栏照常为 0；referral_visible 关闭时 referral 为 null', () => {
  const empty = { own: [], referral: [] };
  const shown = assembleEarningsSummary({
    now: NOV_12,
    periods: earningsPeriods(NOV_12),
    orders: empty,
    credited: [],
    referralVisible: true,
  });
  expect(shown).toEqual({
    as_of: '2026-11-12T10:00:00.000+08:00',
    self: EMPTY_COLUMN,
    share: EMPTY_COLUMN,
    referral: {
      this_month: { est_fen: 0, credited_fen: 0 },
      last_month: { est_fen: 0, credited_fen: 0 },
    },
  });
  const hidden = assembleEarningsSummary({
    now: NOV_12,
    periods: earningsPeriods(NOV_12),
    orders: { own: [], referral: [{ paidAt: NOV_12, estFen: 5n }] },
    credited: [{ ledgerType: 'REFERRAL_CREDIT', day: '2026-11-12', amountFen: -5n }],
    referralVisible: false,
  });
  expect(hidden.referral).toBeNull();
  expect(hidden.self).toEqual(EMPTY_COLUMN);
});
