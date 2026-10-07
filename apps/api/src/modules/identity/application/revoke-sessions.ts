import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/clock/index.ts';

export type SessionRevokeReason =
  | 'logout'
  | 'refresh_reuse'
  | 'phone_changed'
  | 'merged'
  | 'banned'
  | 'admin_revoked'
  | 'device_revoked';

export type AfterSessionsRevoked = (trx: Transaction<DB>, sids: readonly string[]) => Promise<void>;

/** Caller owns the transaction; the hook joins it (B1-12b). */
export async function revokeSessionsByUser(
  trx: Transaction<DB>,
  input: { app_id: string; user_id: string; reason: SessionRevokeReason },
  clock: Clock,
  afterRevoked?: AfterSessionsRevoked,
): Promise<string[]> {
  void trx;
  void input;
  void clock;
  void afterRevoked;
  throw new Error('NotImplemented: revokeSessionsByUser');
}

export async function revokeSessionsByDevice(
  trx: Transaction<DB>,
  input: { app_id: string; device_id: string; reason: SessionRevokeReason },
  clock: Clock,
  afterRevoked?: AfterSessionsRevoked,
): Promise<string[]> {
  void trx;
  void input;
  void clock;
  void afterRevoked;
  throw new Error('NotImplemented: revokeSessionsByDevice');
}
