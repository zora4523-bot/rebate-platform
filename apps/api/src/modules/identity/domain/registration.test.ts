import { expect, it } from 'vitest';
import {
  DEVICE_REGISTER_WINDOW_MS,
  countDeviceRegistrations,
  createSensitiveWordMatcher,
  defaultNickname,
  isAttrCode,
  isInviteCode,
  parseDefaultLevel,
  parseDeviceRegisterLimit,
  parseMergeTombstoneDedupe,
  parseSensitiveWordList,
  type DeviceRegistrationRecord,
} from './registration.ts';

const scope = { app_id: 'couli', device_hash: 'a'.repeat(64) };
const nowMs = 1_790_000_000_000;

function record(
  userId: string,
  ageMs: number,
  mergedInto: string | null = null,
): DeviceRegistrationRecord {
  return {
    ...scope,
    user_id: userId,
    created_at: new Date(nowMs - ageMs),
    merged_into_user_id: mergedInto,
  };
}

it('[BR-ID-05] a record leaves the window exactly when it is 30×24 hours old; newer records count', () => {
  const now = new Date(nowMs);
  expect(
    countDeviceRegistrations([record('edge', DEVICE_REGISTER_WINDOW_MS)], scope, now, true),
  ).toBe(0);
  expect(
    countDeviceRegistrations([record('inside', DEVICE_REGISTER_WINDOW_MS - 1)], scope, now, true),
  ).toBe(1);
  expect(countDeviceRegistrations([record('future', -60_000)], scope, now, true)).toBe(1);
});

it('[BR-ID-05] a source merged into itself is not taken for a pair', () => {
  const now = new Date(nowMs);
  expect(countDeviceRegistrations([record('A', 1_000, 'A')], scope, now, true)).toBe(1);
});

it('[BR-ID-04] the default nickname takes the last four characters of the lower-case id', () => {
  expect(defaultNickname('0192F3A4-0000-7000-8000-00000000ABCD')).toBe('用户abcd');
});

it('[BR-INV-01][BR-ATTR-06] code formats', () => {
  expect(isInviteCode('23456Z')).toBe(true);
  for (const bad of ['23456', '234567A', '0BCDEF', 'OBCDEF', '1BCDEF', 'IBCDEF', 'abcdef', 7]) {
    expect(isInviteCode(bad)).toBe(false);
  }
  expect(isAttrCode('0a1b2c3d')).toBe(true);
  for (const bad of ['0a1b2c3', '0a1b2c3d4', '0A1B2C3D', '0a1b-c3d', null]) {
    expect(isAttrCode(bad)).toBe(false);
  }
});

it('[BR-ID-05][BR-INV-14] configuration values: only the documented shape is accepted', () => {
  expect(parseMergeTombstoneDedupe(true)).toBe(true);
  expect(parseMergeTombstoneDedupe(false)).toBe(false);
  for (const bad of ['true', 1, null, undefined]) expect(parseMergeTombstoneDedupe(bad)).toBeNull();
  expect(parseDeviceRegisterLimit(3)).toBe(3);
  expect(parseDeviceRegisterLimit(1)).toBe(1);
  for (const bad of [0, -1, 2.5, '3', Number.NaN, Number.MAX_SAFE_INTEGER + 2, null]) {
    expect(parseDeviceRegisterLimit(bad)).toBeNull();
  }
  for (const level of ['L1', 'L2', 'L3']) expect(parseDefaultLevel(level)).toBe(level);
  for (const bad of ['l1', 'L4', 1, null]) expect(parseDefaultLevel(bad)).toBeNull();
});

it('[BR-INV-01] word list parsing and case-insensitive substring matching', () => {
  const words = parseSensitiveWordList('# header\r\n\r\n  ab  \n#cd\nXy\n');
  expect(words).toEqual(['ab', 'Xy']);
  const matches = createSensitiveWordMatcher(words);
  expect(matches('2AB345')).toBe(true);
  expect(matches('23xY45')).toBe(true);
  expect(matches('2CD345')).toBe(false);
  expect(matches('')).toBe(false);
  expect(createSensitiveWordMatcher(['', '  '.trim()])('ANY')).toBe(false);
});
