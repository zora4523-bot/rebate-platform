// B2-06f (D10-398 ①): what the payout process's transfer job (couli_payout) and the worker's review
// job (couli_app) share for BR-WDR-13 ③: the payout.* switches read from PG through content's
// configuration reader on the caller's transaction (no cache), and W9 of a PAYING withdrawal by
// CAS on (status, row_version) through the generated transitionWithdrawal().
import type { DB } from '@couli/db';
import { transitionWithdrawal, type WithdrawalState } from '@couli/domain';
import type { Transaction } from 'kysely';
import type { EventBus } from '../../platform/index.ts';
import type { PayoutChannelName } from '../infra/channels/payout-channel.ts';
import type { WithdrawalHoldReason } from './payout-review.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

/** Switch defaults when a key is absent or unreadable (content's switch registry, BR-WDR-32 / 33). */
export const SWITCH_DEFAULTS = {
  enabled: true,
  queuePaused: false,
  channelEnabled: { alipay: true, bank_card: false, wechat: false } as const,
  channelPaused: false,
} as const;

const CHANNELS: ReadonlySet<string> = new Set(['alipay', 'bank_card', 'wechat']);
const PAYING: WithdrawalState = 'PAYING';

export interface GateLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

type Parsed<T> = { ok: true; value: T } | { ok: false };

function parseSwitch(value: unknown): Parsed<boolean> {
  if (typeof value === 'boolean') return { ok: true, value };
  if (value === 'on' || value === 'true') return { ok: true, value: true };
  if (value === 'off' || value === 'false') return { ok: true, value: false };
  return { ok: false };
}

export function isChannel(value: string): value is PayoutChannelName {
  return CHANNELS.has(value);
}

/** One payout.* switch of the app, read from PG on `trx`; the default when absent or unreadable. */
export async function readSwitch(
  config: PayoutConfigPort,
  logger: GateLogger,
  trx: Transaction<DB>,
  appId: string,
  key: string,
  fallback: boolean,
): Promise<boolean> {
  const row = await config.configValue(appId, key, trx);
  if (row === null) return fallback;
  const parsed = parseSwitch(row.value);
  if (parsed.ok) return parsed.value;
  logger.warn({ app_id: appId, config_key: key }, 'payout_config_default');
  return fallback;
}

/** payout.channel_enabled.<channel> on and payout.channel_paused.<channel> off. */
export async function channelSwitchesOpen(
  config: PayoutConfigPort,
  logger: GateLogger,
  trx: Transaction<DB>,
  appId: string,
  channel: PayoutChannelName,
): Promise<boolean> {
  return (
    (await readSwitch(
      config,
      logger,
      trx,
      appId,
      `payout.channel_enabled.${channel}`,
      SWITCH_DEFAULTS.channelEnabled[channel],
    )) &&
    !(await readSwitch(
      config,
      logger,
      trx,
      appId,
      `payout.channel_paused.${channel}`,
      SWITCH_DEFAULTS.channelPaused,
    ))
  );
}

/** The withdrawal columns W9 needs. */
export interface HoldTarget {
  readonly id: string;
  readonly app_id: string;
  readonly user_id: string;
  readonly row_version: number;
  readonly out_biz_no: string;
}

/**
 * W9 PAYING → APPROVED with hold_reason, hold_at = now, executor_id / executed_at cleared (batch_id
 * and execute_seq kept), wallet.withdrawal_changed on `trx`. false when the row moved meanwhile
 * (CAS miss: a warn, nothing written).
 */
export async function holdWithdrawal(
  trx: Transaction<DB>,
  ports: { readonly eventBus: EventBus; readonly logger: GateLogger },
  row: HoldTarget,
  reason: WithdrawalHoldReason,
  now: Date,
): Promise<boolean> {
  const transition = transitionWithdrawal(PAYING, 'HOLD');
  if (!transition.ok || transition.noop) return false;
  const result = await trx
    .withSchema('app')
    .updateTable('withdrawals')
    .set({
      status: transition.to,
      hold_reason: reason,
      hold_at: now,
      executor_id: null,
      executed_at: null,
      row_version: row.row_version + 1,
      updated_at: now,
    })
    .where('app_id', '=', row.app_id)
    .where('id', '=', row.id)
    .where('status', '=', PAYING)
    .where('row_version', '=', row.row_version)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) {
    ports.logger.warn(
      { withdrawal_id: row.id, out_biz_no: row.out_biz_no, hold_reason: reason },
      'payout_transfer_cas_conflict',
    );
    return false;
  }
  await ports.eventBus.publish(trx, {
    appId: row.app_id,
    name: 'wallet.withdrawal_changed',
    payload: { withdrawal_id: row.id, user_id: row.user_id, status: transition.to },
  });
  return true;
}
