import { expect, it } from 'vitest';
import { InvalidAmount, InvalidRatio } from './errors.ts';
import { mulBpBpFloor } from './mul-bp-bp.ts';

it('[AC-B2-01c#1] floors once after multiplying both factors', () => {
  // Sequential floors give floor(floor(2 * 0.75) * 0.8) = 0; one final floor gives 1.
  expect(mulBpBpFloor(2n, 7500n, 8000n)).toBe(1n);
  expect(mulBpBpFloor(400n, 7500n, 10000n)).toBe(300n);
  expect(mulBpBpFloor(333n, 7500n, 8000n)).toBe(199n);
});

it('[AC-B2-01c#3] rejects a negative or non-bigint amount', () => {
  expect(() => mulBpBpFloor(-1n, 7500n, 8000n)).toThrow(InvalidAmount);
  expect(() => mulBpBpFloor(1 as unknown as bigint, 7500n, 8000n)).toThrow(InvalidAmount);
});

it('[AC-B2-01c#4] rejects an out-of-range ratio in either position', () => {
  expect(() => mulBpBpFloor(333n, 10001n, 8000n)).toThrow(InvalidRatio);
  expect(() => mulBpBpFloor(333n, 7500n, -1n)).toThrow(InvalidRatio);
  expect(() => mulBpBpFloor(0n, 0n, 75000000n)).toThrow(InvalidRatio);
});
