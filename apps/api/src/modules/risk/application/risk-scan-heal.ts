import type { RootLogger } from '../../platform/index.ts';

/** B1-03u: the assembled RiskScan will expose this additional operation. */
export interface RiskScanHealer {
  heal(): Promise<void>;
}

export interface RiskScanHealControl {
  stop(): void;
}

/** Installs a recurring callback; stop cancels its timer. No immediate invocation. */
export type RiskScanHealSchedule = (
  tick: () => Promise<void>,
  intervalMs: number,
) => RiskScanHealControl;

/** Worker-only lifecycle hook; the default scheduler will use a five-minute interval. */
export function startRiskScanHeal(
  resolve: () => unknown,
  logger: RootLogger,
  stopping: () => boolean,
  schedule?: RiskScanHealSchedule,
): RiskScanHealControl {
  void resolve;
  void logger;
  void stopping;
  void schedule;
  throw new Error('NotImplemented: startRiskScanHeal');
}
