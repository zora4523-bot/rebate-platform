// B2-02q: the worker entry's daily ledger check (BR-FUND-19): queue ledger-check's handler
// (application/daily-check-schedule.ts createDailyCheckJob) and the chain's seed / heal timer
// (unref, after bootstrap; stopped on destroy). Without a database or queue nothing is registered.
// The two ports of the B2-02p execution step come from app.module (ledger imports neither payout
// nor content): payout's createWithdrawHolds and content's createSystemSwitchWriter.
// B2-02q test phase: NotImplemented skeleton only.
import type { DynamicModule } from '@nestjs/common';
import type { Clock, RootLogger } from '../platform/index.ts';
import type {
  AutoSettlementSwitch,
  LedgerMismatchHolds,
} from './application/daily-check-execute.ts';

/** What app.module hands in on the worker entry. */
export interface LedgerDailyCheckWorkerOptions {
  /** payout's createWithdrawHolds as the hold port (reason ledger_mismatch, created_by system). */
  readonly holds: (clock: Clock, logger: RootLogger) => LedgerMismatchHolds;
  /** content's createSystemSwitchWriter as the settle.auto.enabled port. */
  readonly autoSettlement: (clock: Clock, logger: RootLogger) => AutoSettlementSwitch;
}

export class LedgerDailyCheckModule {
  static forWorker(options: LedgerDailyCheckWorkerOptions): DynamicModule {
    void options;
    throw new Error('NotImplemented: LedgerDailyCheckModule.forWorker');
  }
}
