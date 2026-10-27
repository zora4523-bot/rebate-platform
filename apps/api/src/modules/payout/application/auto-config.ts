// B2-11d: the BR-WDR-30 开启前置检查 over the stored configuration: reads the four
// payout.auto_enable_check.* keys through the config port (the caller's appId and handle; a
// missing row is unset and does not pass) and the days the daily channel reconciliation
// (BR-WDR-23) has run through from the reconciliation port, then judges them with
// checkAutoPayoutEnable. The days are a fact, never a configuration key (编排裁定 D10-392); until
// the daily reconciliation lands the default port answers 0 (fail-closed).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

import type { AutoPayoutEnableCheck } from '../domain/auto-config.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

/** The daily channel reconciliation's record (BR-WDR-23). */
export interface ReconPassedDaysPort {
  /** Consecutive days, up to the latest one, that the daily reconciliation has run through. */
  passedDays(appId: string, handle: Kysely<DB>): Promise<number>;
}

export interface AutoPayoutEnableOptions {
  readonly config: PayoutConfigPort;
  readonly recon: ReconPassedDaysPort;
}

export function readAutoPayoutEnableCheck(
  appId: string,
  handle: Kysely<DB>,
  options: AutoPayoutEnableOptions,
): Promise<AutoPayoutEnableCheck> {
  void appId;
  void handle;
  void options;
  throw new Error('NotImplemented: readAutoPayoutEnableCheck');
}

/** The port until the daily reconciliation (BR-WDR-23) lands: always 0 days. */
export function createDefaultReconPassedDays(): ReconPassedDaysPort {
  throw new Error('NotImplemented: createDefaultReconPassedDays');
}
