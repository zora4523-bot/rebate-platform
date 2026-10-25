import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { channelEndAt, channelEndAtMs, channelRelationId, checkChannelRow } from './channel-row.ts';

const START = new FixedClock('2026-10-10T07:00:00.000Z').now();
const ms = (iso: string) => Date.parse(iso);

it('[AC-B1-09h#1] relation_id: text trimmed, non-negative safe integers as decimal text', () => {
  expect(channelRelationId(' 2876543210\t')).toBe('2876543210');
  expect(channelRelationId(2_876_543_210)).toBe('2876543210');
  expect(channelRelationId(0)).toBe('0');
});

it('[AC-B1-09h#3] relation_id: empty, blank, fractional, negative, unsafe, boolean, date → null', () => {
  for (const cell of [null, '', '  ', 1.5, -3, Number.NaN, 2 ** 53, true, START]) {
    expect(channelRelationId(cell), String(cell)).toBeNull();
  }
});

it('[AC-B1-09h#1] end_at text: without an offset at +08:00, with Z or an offset as given', () => {
  expect(channelEndAtMs('2026-10-31')).toBe(ms('2026-10-30T16:00:00Z'));
  expect(channelEndAtMs('2026-10-31 00:00')).toBe(ms('2026-10-30T16:00:00Z'));
  expect(channelEndAtMs('2026-10-31T09:30:15.5')).toBe(ms('2026-10-31T01:30:15.500Z'));
  expect(channelEndAtMs('2026-10-31T00:00:00Z')).toBe(ms('2026-10-31T00:00:00Z'));
  expect(channelEndAtMs('2026-10-31T09:00:00+0900')).toBe(ms('2026-10-31T00:00:00Z'));
  expect(channelEndAtMs('2026-10-31T00:00:00-05')).toBe(ms('2026-10-31T05:00:00Z'));
});

it('[AC-B1-09h#3] end_at text: impossible dates and times, other shapes → null', () => {
  for (const text of [
    'not-a-time',
    '2026-02-29',
    '2026-13-01',
    '2026-10-31T24:00:00',
    '2026-10-31T10:60',
    '2026-10-31T00:00:00+25:00',
    '2026/10/31',
    '2026-10-31Z',
  ]) {
    expect(channelEndAtMs(text), text).toBeNull();
  }
  expect(channelEndAtMs('2028-02-29')).toBe(ms('2028-02-28T16:00:00Z'));
});

it('[AC-B1-09h#3] end_at cell: empty is null, numbers and booleans are unreadable', () => {
  expect(channelEndAt(null, START)).toEqual({ ok: true, end_at: null });
  expect(channelEndAt('  ', START)).toEqual({ ok: true, end_at: null });
  expect(channelEndAt(46326, START)).toEqual({ ok: false });
  expect(channelEndAt(false, START)).toEqual({ ok: false });
});

it('[AC-B1-09h#3] the row: end_at must be later than start_at', () => {
  const later = new FixedClock('2026-10-10T07:00:01.000Z').now();
  expect(checkChannelRow({ relation_id: 'R8', end_at: START }, START)).toEqual({ ok: false });
  expect(checkChannelRow({ relation_id: 'R8', end_at: '2026-10-10 15:00:00' }, START)).toEqual({
    ok: false,
  });
  expect(checkChannelRow({ relation_id: 'R8', end_at: later }, START)).toEqual({
    ok: true,
    relation_id: 'R8',
    end_at: later,
  });
  expect(checkChannelRow({ relation_id: null, end_at: null }, START)).toEqual({ ok: false });
  expect(checkChannelRow({}, START)).toEqual({ ok: false });
});
