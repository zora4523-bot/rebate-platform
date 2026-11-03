// B2-09j skeleton (BR-WDR-18「W < 1.5P 时告警财务」, D10-592): payout's read-only port behind the
// worker's couli_payout_water_low gauge. Implementation follows the rule tests.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface PayoutWaterLow {
  /**
   * app_id → 1 (W < 1.5P) or 0 (not low), enterprise Alipay channel only. An app_id without a
   * conclusion (no W, or W older than 2 hours) has no key at all.
   */
  readonly waterLow: Readonly<Record<string, number>>;
}

export function readPayoutWaterLow(db: Kysely<DB>, clock: Clock): Promise<PayoutWaterLow> {
  void db;
  void clock;
  throw new Error('NotImplemented: readPayoutWaterLow');
}
