import { expect, it } from 'vitest';
import {
  SMS_DEFAULT_BLOCKED_PREFIXES,
  e164,
  isBlockedPrefix,
  naturalWindows,
  parseBlockedPrefixes,
  secondsUntil,
} from './sms-limits.ts';

const at = (text: string): number => new Date(text).getTime();

it('[BR-ID-05] natural hour and day are taken in +08:00, not UTC', () => {
  expect(naturalWindows(at('2026-10-06T10:50:00+08:00'))).toEqual({
    hourStartMs: at('2026-10-06T10:00:00+08:00'),
    nextHourMs: at('2026-10-06T11:00:00+08:00'),
    dayStartMs: at('2026-10-06T00:00:00+08:00'),
    nextDayMs: at('2026-10-07T00:00:00+08:00'),
  });
  // 07:30 +08:00 is 23:30 UTC of the day before: the natural day is still 10-06 in +08:00.
  const early = naturalWindows(at('2026-10-06T07:30:00+08:00'));
  expect(early.dayStartMs).toBe(at('2026-10-06T00:00:00+08:00'));
  // A boundary instant starts its own window.
  const midnight = naturalWindows(at('2026-10-07T00:00:00+08:00'));
  expect(midnight.dayStartMs).toBe(at('2026-10-07T00:00:00+08:00'));
  expect(midnight.hourStartMs).toBe(at('2026-10-07T00:00:00+08:00'));
});

it('[BR-ID-05] Retry-After rounds up to whole seconds and is at least 1', () => {
  expect(secondsUntil(at('2026-10-06T11:00:50+08:00'), at('2026-10-06T10:59:55+08:00'))).toBe(55);
  expect(secondsUntil(1_500, 1_000)).toBe(1);
  expect(secondsUntil(1_000, 1_000)).toBe(1);
  expect(secondsUntil(2_001, 1_000)).toBe(2);
});

it('[BR-ID-05] prefixes match the E.164 form of the normalised number', () => {
  expect(e164('17012345678')).toBe('+8617012345678');
  for (const prefix of ['170', '171', '162', '165', '167']) {
    expect(isBlockedPrefix(`${prefix}12345678`, SMS_DEFAULT_BLOCKED_PREFIXES)).toBe(true);
  }
  expect(isBlockedPrefix('13912345678', SMS_DEFAULT_BLOCKED_PREFIXES)).toBe(false);
  expect(isBlockedPrefix('16612345678', SMS_DEFAULT_BLOCKED_PREFIXES)).toBe(false);
  expect(isBlockedPrefix('13912345678', ['+86139'])).toBe(true);
  expect(isBlockedPrefix('17012345678', [])).toBe(false);
});

it('[BR-ID-05] sms.blocked_prefixes is a JSON array of E.164 prefixes; any other shape is refused', () => {
  expect(parseBlockedPrefixes(['+86139', '+8617'])).toEqual(['+86139', '+8617']);
  expect(parseBlockedPrefixes([])).toEqual([]);
  for (const value of [null, '+86170', 170, {}, ['170'], [''], ['+86 170'], ['+'], [170], [null]]) {
    expect(parseBlockedPrefixes(value)).toBeNull();
  }
});
