import { describe, expect, it } from 'vitest';
import { resolveTraceId } from './trace-id.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveTraceId', () => {
  it.each([
    '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b',
    'C56A4180-65aa-42EC-a945-5fd21DEC0538',
    '00000000-0000-0000-0000-000000000000',
    'abcdefABCDEF01234567abcdefABCDEF',
    'A'.repeat(32),
    '1'.repeat(32),
  ])('[AC-B1-01p#1] keeps the well-formed value %s', (value) => {
    expect(resolveTraceId(value)).toBe(value);
  });

  it.each([
    undefined,
    null,
    '',
    'abc',
    'trace-abc_123',
    '13987654321',
    'has space',
    'a/b',
    '{"x":1}',
    'line\nbreak',
    'A'.repeat(31),
    'A'.repeat(33),
    'A'.repeat(64),
    'g'.repeat(32),
    `${'a'.repeat(32)}\n`,
    '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b\n',
    '0199a3b4_5c6d_7e8f_9a0b_1c2d3e4f5a6b',
    ['a', 'b'],
    ['a'.repeat(32)],
    42,
  ])('[AC-B1-01p#2] replaces %j with a random v4 UUID', (value) => {
    const first = resolveTraceId(value);
    expect(first).toMatch(UUID);
    expect(resolveTraceId(value)).not.toBe(first);
  });
});
