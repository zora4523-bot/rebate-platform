import { describe, expect, it } from 'vitest';
import {
  decodeOnce,
  hasPersonalPlaceholder,
  isUnionHost,
  normalisedHttpsHost,
} from './external-url.ts';

const TABLE = {
  version: 'u',
  rules: [
    { platform: 'p', category: 'union_host' as const, hosts: ['Union.Test.'], path_patterns: [] },
    { platform: 'p', category: 'product' as const, hosts: ['shop.test'], path_patterns: ['/**'] },
  ],
};

describe('external-url helpers', () => {
  it('[AC-F1-09c] decodeOnce decodes valid escapes once and keeps broken ones', () => {
    expect(decodeOnce('%E4%B8%AD%257B%zz%4')).toBe('中%7B%zz%4');
  });

  it('[AC-F1-09c] normalisedHttpsHost lower-cases, drops trailing dot and port, rejects others', () => {
    expect(normalisedHttpsHost('https://A.Test.:444/x')).toBe('a.test');
    expect(normalisedHttpsHost('http://a.test/')).toBeNull();
    expect(normalisedHttpsHost('https://u@a.test/')).toBeNull();
    expect(normalisedHttpsHost('nope')).toBeNull();
  });

  it('[AC-F1-09c] placeholder detection covers raw, decoded and overlapping percent names', () => {
    expect(hasPersonalPlaceholder('https://a.test/%41%UID%')).toBe(true);
    expect(hasPersonalPlaceholder('https://a.test/%25uid%25')).toBe(true);
    expect(hasPersonalPlaceholder('https://a.test/%7Bx%7D')).toBe(true);
    expect(hasPersonalPlaceholder('https://a.test/?q=%E4%B8%AD%20a')).toBe(false);
  });

  it('[AC-F1-09c] isUnionHost matches registered domain and subdomains of union_host rules only', () => {
    expect(isUnionHost('union.test', TABLE)).toBe(true);
    expect(isUnionHost('m.union.test', TABLE)).toBe(true);
    expect(isUnionHost('xunion.test', TABLE)).toBe(false);
    expect(isUnionHost('union.test.evil.test', TABLE)).toBe(false);
    expect(isUnionHost('shop.test', TABLE)).toBe(false);
  });
});
