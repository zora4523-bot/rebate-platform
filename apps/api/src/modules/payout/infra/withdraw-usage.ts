import type { WithdrawUsageReader } from '../application/withdraw-rules.ts';

/** Same caller handle; +08:00 half-open day/month ranges, snapshots, excludes REJECTED/FAILED. */
export function createWithdrawUsageReader(): WithdrawUsageReader {
  throw new Error('NotImplemented: createWithdrawUsageReader');
}
