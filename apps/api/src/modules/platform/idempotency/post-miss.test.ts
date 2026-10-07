import { expect, it } from 'vitest';
import type { Idempotency } from './index.ts';
import { registerIdempotencyPostMissCheck } from './post-miss.ts';

it('[BR-ID-01] registration refuses an object that createIdempotency did not build', () => {
  expect(() => registerIdempotencyPostMissCheck({} as Idempotency, async () => undefined)).toThrow(
    TypeError,
  );
});
