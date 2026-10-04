import { describe, expect, it } from 'vitest';

import { fenToYuan, yuanToFen } from './amount.ts';

describe('fen and yuan conversion', () => {
  it('formats fen as a two-place decimal without floats', () => {
    expect(fenToYuan(1)).toBe('0.01');
    expect(fenToYuan(10)).toBe('0.10');
    expect(fenToYuan(1234)).toBe('12.34');
    expect(fenToYuan(20000n)).toBe('200.00');
    // 0.1 + 0.2 style float traps do not apply: 30 fen is exactly 0.30
    expect(fenToYuan(10 + 20)).toBe('0.30');
  });

  it('rejects negative and fractional fen', () => {
    expect(() => fenToYuan(-1)).toThrow(RangeError);
    expect(() => fenToYuan(1.5)).toThrow(RangeError);
  });

  it('parses channel amounts back to fen', () => {
    expect(yuanToFen('12.34')).toBe(1234n);
    expect(yuanToFen('12.3')).toBe(1230n);
    expect(yuanToFen('20')).toBe(2000n);
    expect(() => yuanToFen('12.345')).toThrow(RangeError);
    expect(() => yuanToFen('1e2')).toThrow(RangeError);
  });
});
