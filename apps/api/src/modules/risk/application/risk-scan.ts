import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, JobQueue, ReceivedJob, RootLogger } from '../../platform/index.ts';
import type { RiskStateService } from './risk-state.ts';

export interface RiskScanOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly riskState: RiskStateService;
  readonly queue: JobQueue;
  readonly logger: RootLogger;
}

export interface RiskScan {
  expireFrozen(): Promise<void>;
  dailyAlerts(): Promise<void>;
  /** Current-slot seeds: freeze-expiry:YYYY-MM-DDTHH:mm (UTC), daily-alerts:YYYY-MM-DD (+08). */
  seed(): Promise<void>;
  /** Scan, then enqueue the next slot; its key differs from this still-active job's key. */
  handle(job: ReceivedJob): Promise<void>;
}

// TODO(规划/11 §3.2): 冻结到期解冻写 audit_logs — blocked on audit_logs 只记后台操作人（规格同步任务）
export function createRiskScan(options: RiskScanOptions): RiskScan {
  void options;
  throw new Error('NotImplemented: createRiskScan');
}
