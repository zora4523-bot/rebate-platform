import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface PushSessionQuery {
  readonly app_id: string;
  readonly user_id: string;
  readonly sids: readonly string[];
}

/** Read only: requested recipient sessions with an unrotated refresh row expiring after now. */
export type PushSessionValidity = (
  executor: Kysely<DB> | Transaction<DB>,
  query: PushSessionQuery,
) => Promise<ReadonlySet<string>>;

/** All joins are app-scoped; revoked, absent and expired sessions are excluded. */
export function createPushSessionValidity(clock: Clock): PushSessionValidity {
  void clock;
  throw new Error('NotImplemented: createPushSessionValidity');
}
