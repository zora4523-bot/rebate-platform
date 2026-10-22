import { describe, expect, it } from 'vitest';
import { InvalidAmount } from './errors.ts';
import { floorToStepFen } from './floor-to-step.ts';

describe('floorToStepFen', () => {
  it('floors to the largest multiple of the step not above the value', () => {
    expect(floorToStepFen(12345n, 100n)).toBe(12300n);
    expect(floorToStepFen(12300n, 100n)).toBe(12300n);
    expect(floorToStepFen(99n, 100n)).toBe(0n);
    expect(floorToStepFen(7n, 1n)).toBe(7n);
    expect(floorToStepFen(0n, 100n)).toBe(0n);
  });

  it('floors a negative value to 0 (nothing withdrawable)', () => {
    expect(floorToStepFen(-1n, 100n)).toBe(0n);
    expect(floorToStepFen(-12345n, 100n)).toBe(0n);
  });

  it('refuses non-bigint operands, out-of-range values and a non-positive step', () => {
    expect(() => floorToStepFen(100 as unknown as bigint, 100n)).toThrow(InvalidAmount);
    expect(() => floorToStepFen(100n, 0n)).toThrow(InvalidAmount);
    expect(() => floorToStepFen(100n, -100n)).toThrow(InvalidAmount);
    expect(() => floorToStepFen(9223372036854775808n, 100n)).toThrow(InvalidAmount);
  });
});
