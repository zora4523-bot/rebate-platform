// B2-06b: payout channel configuration (规划/04 §10 payout.*) and the result judgement of
// 规划/08 BR-WDR-28 / BR-WDR-14 / BR-WDR-22 ⑤ (conservative defaults until the sandbox run; D10-230):
// only a verified business response with code 10000 and status SUCCESS is a success; any other
// business code is unknown and pauses the queue unless the configured lists say fail or payer-side;
// transport-class failures are judged by the adapter, not here.
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

export const PAYOUT_CHANNEL_CONFIG_KEYS = Object.freeze({
  singleCapFen: 'payout.single_cap_fen',
  dailyCapFen: 'payout.daily_cap_fen',
  watermarkUsableBp: 'payout.watermark_usable_bp',
  bizScene: 'payout.biz_scene',
  querySchedule: 'payout.query_schedule',
  definiteFailCodes: 'payout.definite_fail_codes',
  payerSideCodes: 'payout.payer_side_codes',
  queryStatusMap: 'payout.query_status_map',
} as const);

/** 规划/08 BR-WDR-22 / BR-WDR-18 / BR-WDR-28 defaults until the channel is verified. */
export function defaultPayoutChannelConfig(): PayoutChannelConfig {
  return {
    singleCapFen: 500000,
    dailyCapFen: 5000000,
    watermarkUsableBp: 9000,
    bizScene: '',
    querySchedule: { points_min: [1, 5, 30, 120], interval_min: 120, manual_after_min: 1440 },
    definiteFailCodes: [],
    payerSideCodes: [],
    queryStatusMap: { SUCCESS: 'success' },
  };
}

const QUERY_KINDS: readonly QueryKind[] = ['success', 'fail', 'unknown'];

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStatusMap(value: unknown): Record<string, QueryKind> | null {
  if (!isPlainObject(value)) return null;
  const map: Record<string, QueryKind> = {};
  for (const [status, kind] of Object.entries(value)) {
    if (typeof kind !== 'string' || !QUERY_KINDS.includes(kind as QueryKind)) return null;
    map[status] = kind as QueryKind;
  }
  return map;
}

function parseSchedule(value: unknown): PayoutChannelConfig['querySchedule'] | null {
  if (!isPlainObject(value)) return null;
  const points = value['points_min'];
  if (!Array.isArray(points) || points.length === 0 || !points.every(isPositiveInteger)) return null;
  if (!isPositiveInteger(value['interval_min']) || !isPositiveInteger(value['manual_after_min']))
    return null;
  return {
    points_min: [...points],
    interval_min: value['interval_min'],
    manual_after_min: value['manual_after_min'],
  };
}

/** Direct PG port, preserving the caller's appId and handle; invalid values warn and default. */
export async function readPayoutChannelConfig(
  appId: string,
  handle: Kysely<DB>,
  config: PayoutConfigPort,
  logger: Pick<Logger, 'warn'>,
): Promise<PayoutChannelConfig> {
  const result = defaultPayoutChannelConfig();
  const read = async <K extends keyof PayoutChannelConfig>(
    field: K,
    parse: (value: unknown) => PayoutChannelConfig[K] | null,
  ): Promise<void> => {
    const key = PAYOUT_CHANNEL_CONFIG_KEYS[field];
    const row = await config.configValue(appId, key, handle);
    if (row === null) return;
    const parsed = parse(row.value);
    if (parsed === null) {
      logger.warn({ app_id: appId, config_key: key }, 'payout_config_default');
      return;
    }
    result[field] = parsed;
  };
  await read('singleCapFen', (v) => (isPositiveInteger(v) ? v : null));
  await read('dailyCapFen', (v) => (isPositiveInteger(v) ? v : null));
  await read('watermarkUsableBp', (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10000 ? v : null,
  );
  await read('bizScene', (v) => (typeof v === 'string' ? v : null));
  await read('querySchedule', parseSchedule);
  await read('definiteFailCodes', (v) => (isStringList(v) ? v : null));
  await read('payerSideCodes', (v) => (isStringList(v) ? v : null));
  await read('queryStatusMap', parseStatusMap);
  return result;
}

const SUCCESS_CODE = '10000';

/**
 * Only verified business responses reach this function; transport errors are handled outside.
 * Success needs code 10000 and status SUCCESS; 10000 with another or no status stays unknown.
 */
export function judgeTransfer(
  raw: ChannelRaw,
  status: string | undefined,
  lists: JudgementLists,
): { kind: TransferKind; raw: ChannelRaw; pauseQueue?: boolean } {
  if (raw.code === SUCCESS_CODE) {
    return status === 'SUCCESS' ? { kind: 'success', raw } : { kind: 'unknown', raw };
  }
  const subCode = raw.subCode;
  if (subCode !== undefined && lists.definiteFailCodes.includes(subCode)) return { kind: 'fail', raw };
  if (subCode !== undefined && lists.payerSideCodes.includes(subCode))
    return { kind: 'payer_side', raw, pauseQueue: true };
  // BR-WDR-28: an unrecognised business code is unknown and pauses the queue.
  return { kind: 'unknown', raw, pauseQueue: true };
}

export function judgeQuery(
  raw: ChannelRaw,
  status: string | undefined,
  lists: JudgementLists,
): { kind: QueryKind; raw: ChannelRaw } {
  if (raw.code !== SUCCESS_CODE || status === undefined) return { kind: 'unknown', raw };
  const map = lists.queryStatusMap;
  const kind = Object.hasOwn(map, status) ? map[status]! : 'unknown';
  return { kind, raw };
}
