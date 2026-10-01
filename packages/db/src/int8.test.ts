import { expect, it } from 'vitest';

import { parseInt8, parseInt8Array } from './int8.ts';

it('parseInt8 keeps values beyond 2^53 exact', () => {
  expect(parseInt8('9223372036854775807')).toBe(9223372036854775807n);
  expect(parseInt8('-9223372036854775808')).toBe(-9223372036854775808n);
  expect(parseInt8('0')).toBe(0n);
});

it('parseInt8Array parses flat arrays, NULLs and the empty array', () => {
  expect(parseInt8Array('{}')).toEqual([]);
  expect(parseInt8Array('{1,-2,NULL,9007199254740993}')).toEqual([
    1n,
    -2n,
    null,
    9007199254740993n,
  ]);
});

it('parseInt8Array parses nested arrays and ignores explicit bounds', () => {
  expect(parseInt8Array('{{1,2},{3,4}}')).toEqual([
    [1n, 2n],
    [3n, 4n],
  ]);
  expect(parseInt8Array('[0:2]={7,8,9}')).toEqual([7n, 8n, 9n]);
});

it('parseInt8Array rejects anything that is not an integer array literal', () => {
  expect(() => parseInt8Array('{"a","b"}')).toThrow(TypeError);
  expect(() => parseInt8Array('1,2')).toThrow(TypeError);
  expect(() => parseInt8Array('{1.5}')).toThrow(TypeError);
});
