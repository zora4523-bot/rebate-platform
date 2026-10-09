import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface SessionBinding {
  readonly app_id: string;
  readonly user_id: string;
  readonly device_id: string;
  readonly sid: string;
}

export interface SessionUnbinding {
  readonly app_id: string;
  readonly user_id: string;
  readonly sid: string;
}

/** Called after identity locks the device and writes last_login_sid, in that transaction. */
export async function bindPushTokensForSession(
  transaction: Transaction<DB>,
  session: SessionBinding,
  clock: Clock,
): Promise<void> {
  void transaction;
  void session;
  void clock;
  throw new Error('NotImplemented: bindPushTokensForSession');
}

/** Conditional (app_id, user_id, bound_sid) update; there is no device-only unbind command. */
export async function unbindPushTokensForSession(
  transaction: Transaction<DB>,
  session: SessionUnbinding,
  clock: Clock,
): Promise<void> {
  void transaction;
  void session;
  void clock;
  throw new Error('NotImplemented: unbindPushTokensForSession');
}
