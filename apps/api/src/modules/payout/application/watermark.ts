// B2-06c: the reads behind the watermark check of EXECUTE (规划/08 BR-WDR-18, D10-223 水位表), all on
// the caller's transaction, scoped to the app; the decision itself is domain/watermark.ts.
//   latest     W and t_W: the payout_watermarks row of (app_id, channel) with the latest measured_at;
//              null when there is none.
//   forecast   P: withdrawals.amount_fen of the 7 complete natural days (+08:00) before the day of
//              `now`, REJECTED excluded, through forecastWindow / forecastFen.
//   committed  Σ net_fen of status = PAYING, and Σ net_fen of PAID_API / PAID_MANUAL with
//              paid_at after `since` (t_W).
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { WatermarkReading } from '../domain/watermark.ts';

export type PayoutChannelName = 'alipay' | 'bank_card' | 'wechat';

export interface WatermarkCommitted {
  readonly payingNetFen: bigint;
  readonly paidSinceNetFen: bigint;
}

export interface WatermarkReader {
  latest(
    trx: Transaction<DB>,
    input: { appId: string; channel: PayoutChannelName },
  ): Promise<WatermarkReading | null>;
  forecast(
    trx: Transaction<DB>,
    input: { appId: string; channel: PayoutChannelName; now: Date },
  ): Promise<bigint>;
  committed(
    trx: Transaction<DB>,
    input: { appId: string; channel: PayoutChannelName; since: Date },
  ): Promise<WatermarkCommitted>;
}

export function createWatermarkReader(): WatermarkReader {
  throw new Error('NotImplemented: createWatermarkReader');
}
