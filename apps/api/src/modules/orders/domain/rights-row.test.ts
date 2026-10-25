import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { checkRightsRow, rightsAmountFen, rightsOccurredAt } from './rights-row.ts';

const LIKE = new FixedClock('2026-10-22T02:00:00.000Z').now();
const ms = (iso: string) => Date.parse(iso);

const ROW = {
  sub_order_id: ' 8812 ',
  parent_order_id: null,
  platform: 'taobao',
  rights_no: 'R-1',
  status: 'PROCESSING',
  amount: '12.30',
  deduction_commission: 1.23,
  occurred_at: '2026-10-18 10:30:00',
};

it('[AC-B1-09k#1] amounts: yuan text or number with at most two decimals, exact in fen', () => {
  expect(['0.29', '1.15', '19.99', ' 5 ', 0.29, 0.07, 19.99, 12.5, 3].map(rightsAmountFen)).toEqual(
    [29n, 115n, 1999n, 500n, 29n, 7n, 1999n, 1250n, 300n],
  );
  expect(rightsAmountFen('90071992547409.93')).toBe(9007199254740993n);
  expect([null, '', '  '].map(rightsAmountFen)).toEqual([null, null, null]);
});

it('[AC-B1-09k#3] amounts: negative, more than two decimals, separators, non-finite → unreadable', () => {
  const bad = ['-1', '1.234', '1,5', 'abc', '1e3', -3, 1.234, Number.NaN, Infinity, true];
  expect(bad.map(rightsAmountFen)).toEqual(bad.map(() => undefined));
  expect(rightsAmountFen('99999999999999999999')).toBeUndefined();
});

it('[AC-B1-09k#1] occurred_at: Date cells as is, texts at +08:00 unless they carry an offset', () => {
  const date = new FixedClock('2026-10-19T01:02:03.000Z').now();
  expect(rightsOccurredAt(date, LIKE)?.getTime()).toBe(date.getTime());
  expect(rightsOccurredAt('2026-10-18', LIKE)?.getTime()).toBe(ms('2026-10-17T16:00:00Z'));
  expect(rightsOccurredAt('2026-10-18T02:30:00Z', LIKE)?.getTime()).toBe(
    ms('2026-10-18T02:30:00Z'),
  );
  expect([null, 46313.4375, 'x', '2026-02-30'].map((c) => rightsOccurredAt(c, LIKE))).toEqual([
    null,
    null,
    null,
    null,
  ]);
});

it('[AC-B1-09k#1] a full rights row is read; punish rows ignore the status column', () => {
  const rights = checkRightsRow('rights', ROW, LIKE);
  expect(rights).toEqual({
    ok: true,
    row: {
      sub_order_id: '8812',
      platform: 'taobao',
      rights_no: 'R-1',
      status: 'PROCESSING',
      amount_fen: 1230n,
      deduction_commission_fen: 123n,
      occurred_at: new FixedClock('2026-10-18T02:30:00.000Z').now(),
    },
  });
  const punish = checkRightsRow('punish', { ...ROW, status: 'whatever' }, LIKE);
  expect(punish.ok && punish.row.status).toBe('SUCCEEDED');
});

it('[AC-B1-09k#3] only a parent number → sub_order_id null; neither number, bad status, bad platform → invalid', () => {
  const parentOnly = checkRightsRow(
    'rights',
    { ...ROW, sub_order_id: '', parent_order_id: 'P' },
    LIKE,
  );
  expect(parentOnly.ok && parentOnly.row.sub_order_id).toBeNull();
  for (const patch of [
    { sub_order_id: null },
    { sub_order_id: true },
    { status: 'WAIT_COMMISSION' },
    { status: null },
    { platform: 7 },
    { occurred_at: null },
  ]) {
    expect(checkRightsRow('rights', { ...ROW, ...patch }, LIKE)).toEqual({ ok: false });
  }
  const noPlatform = checkRightsRow('rights', { ...ROW, platform: ' ' }, LIKE);
  expect(noPlatform.ok && noPlatform.row.platform).toBeNull();
});
