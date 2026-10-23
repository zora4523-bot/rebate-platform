import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { ChannelRaw, QueryKind, TransferKind } from '../domain/channel-result.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

export interface JudgementLists {
  definiteFailCodes: readonly string[];
  payerSideCodes: readonly string[];
  queryStatusMap: Readonly<Record<string, QueryKind>>;
}

export interface PayoutChannelConfig extends JudgementLists {
  singleCapFen: number;
  dailyCapFen: number;
  watermarkUsableBp: number;
  bizScene: string;
  querySchedule: {
    points_min: readonly number[];
    interval_min: number;
    manual_after_min: number;
  };
}

/** Direct PG port, preserving the caller's appId and handle; invalid values warn and default. */
export function readPayoutChannelConfig(
  appId: string,
  handle: Kysely<DB>,
  config: PayoutConfigPort,
  logger: Pick<Logger, 'warn'>,
): Promise<PayoutChannelConfig> {
  void appId;
  void handle;
  void config;
  void logger;
  throw new Error('NotImplemented: readPayoutChannelConfig');
}

/** Only verified business responses reach this function; transport errors are handled outside. */
export function judgeTransfer(
  raw: ChannelRaw,
  lists: JudgementLists,
): { kind: TransferKind; raw: ChannelRaw; pauseQueue?: boolean } {
  void raw;
  void lists;
  throw new Error('NotImplemented: judgeTransfer');
}

export function judgeQuery(
  raw: ChannelRaw,
  status: string | undefined,
  lists: JudgementLists,
): { kind: QueryKind; raw: ChannelRaw } {
  void raw;
  void status;
  void lists;
  throw new Error('NotImplemented: judgeQuery');
}
