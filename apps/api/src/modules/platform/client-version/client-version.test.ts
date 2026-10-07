import { expect, it } from 'vitest';
import { compareClientVersions, isVersionGatedPlatform } from './index.ts';

it('[BR-ID-01] versions compare numerically per component, whatever their length', () => {
  expect(compareClientVersions('10.0.0', '9.99.99')).toBe(1);
  expect(compareClientVersions('1.0.99999999999999999999', '1.0.100000000000000000000')).toBe(-1);
  expect(compareClientVersions('0.0.0', '0.0.0')).toBe(0);
  expect(compareClientVersions('3.2.1', '3.2.0')).toBe(1);
});

it('[BR-ID-01] a client version that is not MAJOR.MINOR.PATCH without leading zeros is null', () => {
  for (const version of [
    '01.0.0',
    '1.02.0',
    '1.0.0-beta',
    '1.0.0+7',
    ' 1.0.0',
    'v1.0.0',
    '1.0.0.0',
  ]) {
    expect(compareClientVersions(version, '1.0.0')).toBeNull();
  }
});

it('[BR-ID-01] a malformed minimum is a configuration fault and throws', () => {
  for (const minimum of ['', '1.0', '01.0.0', 'latest']) {
    expect(() => compareClientVersions('1.0.0', minimum)).toThrow(TypeError);
  }
});

it('[BR-ID-01] only ios, android and harmony are judged by the minimum supported version', () => {
  expect(['ios', 'android', 'harmony', 'h5', 'admin'].map(isVersionGatedPlatform)).toEqual([
    true,
    true,
    true,
    false,
    false,
  ]);
});
