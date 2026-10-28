// B2-11d: the BR-WDR-30 开启前置检查 over the stored configuration: reads the four
// payout.auto_enable_check.* keys through the config port (the caller's appId and handle; a
// missing row is unset and does not pass) and the days the daily channel reconciliation
// (BR-WDR-23) has run through from the reconciliation port, then judges them with
// checkAutoPayoutEnable. The days are a fact, never a configuration key (编排裁定 D10-392); until
// the daily reconciliation lands the default port answers 0 (fail-closed).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

import {
  checkAutoPayoutEnable,
  type AutoPayoutEnableCheck,
  type AutoPayoutEnableKey,
} from '../domain/auto-config.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

/** The daily channel reconciliation's record (BR-WDR-23). */
export interface ReconPassedDaysPort {
  /** Consecutive days, up to the latest one, that the daily reconciliation has run through. */
  passedDays(appId: string, handle: Kysely<DB>): Promise<number>;
}

const AUTO_PAYOUT_ENABLE_KEYS: readonly AutoPayoutEnableKey[] = [
  'payout.auto_enable_check.limits_supported',
  'payout.auto_enable_check.status_codes_supported',
  'payout.auto_enable_check.bill_out_biz_no_supported',
  'payout.auto_enable_check.recon_required_days',
];

export interface AutoPayoutEnableOptions {
  readonly config: PayoutConfigPort;
  readonly recon: ReconPassedDaysPort;
}

export async function readAutoPayoutEnableCheck(
  appId: string,
  handle: Kysely<DB>,
  options: AutoPayoutEnableOptions,
): Promise<AutoPayoutEnableCheck> {
  const values = new Map<string, unknown>();
  for (const key of AUTO_PAYOUT_ENABLE_KEYS) {
    const row = await options.config.configValue(appId, key, handle);
    if (row !== null) values.set(key, row.value);
  }
  return checkAutoPayoutEnable(values, await options.recon.passedDays(appId, handle));
}

/** The port until the daily reconciliation (BR-WDR-23) lands: always 0 days. */
export function createDefaultReconPassedDays(): ReconPassedDaysPort {
  return { passedDays: () => Promise.resolve(0) };
}
