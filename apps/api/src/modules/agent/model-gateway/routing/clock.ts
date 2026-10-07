import type { RunModelClock } from './types.ts';

/** 只累计实际等待模型的时间，工具执行与两次 complete 之间的时间不扣除。 */
export function createRunModelClock(totalMs: number): RunModelClock {
  if (!Number.isFinite(totalMs) || totalMs < 0) {
    throw new RangeError('Model time budget must be finite and non-negative');
  }
  let remaining = totalMs;
  return {
    remainingMs: () => remaining,
    charge(ms) {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError('Model elapsed time must be finite and non-negative');
      }
      remaining = Math.max(0, remaining - ms);
    },
  };
}
