import { expect, it } from 'vitest';
import {
  needsSign,
  resignFromVersion,
} from '../../../../apps/api/src/modules/content/domain/agreements/index.ts';

it.each([
  { signed: null, version: 1, minimum: 1, expected: true },
  { signed: null, version: 3, minimum: 1, expected: true },
  { signed: 1, version: 3, minimum: 1, expected: false },
  { signed: 1, version: 3, minimum: 3, expected: true },
  { signed: 2, version: 3, minimum: 3, expected: true },
  { signed: 3, version: 3, minimum: 3, expected: false },
  { signed: 2, version: 5, minimum: 2, expected: false },
  { signed: 3, version: 5, minimum: 2, expected: false },
  { signed: 1, version: 5, minimum: 2, expected: true },
])(
  '[AC-F1-02m#17] signed $signed vs v$version/min$minimum needs signature: $expected',
  ({ signed, version, minimum, expected }) => {
    expect(needsSign(signed, Object.freeze({ version, min_version: minimum }))).toBe(expected);
  },
);

it.each([
  { version: 1, min_version: 1 },
  { version: 3, min_version: 1 },
  { version: 3, min_version: 3 },
  { version: 5, min_version: 2 },
])(
  '[AC-F1-02m#18] resign start is minimum $min_version, not current version $version',
  (current) => {
    expect(resignFromVersion(Object.freeze(current))).toBe(current.min_version);
  },
);

it('[AC-F1-02m#19] later optional publication preserves the previous mandatory signing threshold', () => {
  const mandatory = { version: 3, min_version: 3 };
  const later = { version: 4, min_version: 3 };
  expect(needsSign(2, mandatory)).toBe(true);
  expect(needsSign(2, later)).toBe(true);
  expect(needsSign(3, later)).toBe(false);
  expect(resignFromVersion(later)).toBe(3);
});
