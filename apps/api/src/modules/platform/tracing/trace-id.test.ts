import { describe, expect, it } from 'vitest';
import { resolveTraceId } from './trace-id.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('resolveTraceId', () => {
  it.each(['abc', 'trace-abc_123', '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b', 'A'.repeat(64)])(
    'keeps the well-formed value %s',
    (value) => {
      expect(resolveTraceId(value)).toBe(value);
    },
  );

  it.each([
    undefined,
    '',
    'has space',
    'a/b',
    '{"x":1}',
    'line\nbreak',
    'A'.repeat(65),
    ['a', 'b'],
    42,
  ])('replaces %j with a random UUID', (value) => {
    const first = resolveTraceId(value);
    expect(first).toMatch(UUID);
    expect(resolveTraceId(value)).not.toBe(first);
  });
});
