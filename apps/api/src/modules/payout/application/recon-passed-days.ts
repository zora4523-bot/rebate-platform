// B2-07d: the real ReconPassedDaysPort of the BR-WDR-30 开启前置检查 (编排裁定 D10-392, D10-408):
// from app.payout_recon_runs, the consecutive days of the app's Alipay reconciliation that ran
// through (status succeeded; diffs found do not break the run), counted back from the +08:00
// accounting day before the injected Clock's now. partial, failed or a missing day stops the count;
// today's row is neither counted nor a break. Read only, on the caller's handle.
import type { Clock } from '../../platform/index.ts';
import type { ReconPassedDaysPort } from './auto-config.ts';

export interface ReconPassedDaysOptions {
  readonly clock: Clock;
}

export function createReconPassedDays(options: ReconPassedDaysOptions): ReconPassedDaysPort {
  void options;
  throw new Error('NotImplemented: createReconPassedDays');
}
