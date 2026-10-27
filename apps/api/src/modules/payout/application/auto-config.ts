// B2-11d: the BR-WDR-30 开启前置检查 over the stored configuration: reads the
// payout.auto_enable_check.* keys through the config port (the caller's appId and handle) and
// judges them with checkAutoPayoutEnable; a missing row does not pass.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

import type { AutoPayoutEnableCheck } from '../domain/auto-config.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

export function readAutoPayoutEnableCheck(
  appId: string,
  handle: Kysely<DB>,
  config: PayoutConfigPort,
): Promise<AutoPayoutEnableCheck> {
  void appId;
  void handle;
  void config;
  throw new Error('NotImplemented: readAutoPayoutEnableCheck');
}
