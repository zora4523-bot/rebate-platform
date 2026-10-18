import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface PendingAttempt {
  attempt_id: string;
  link_id: string;
  platform: Schema<'PlatformCode'>;
  pid_scene: string | null;
  opened_at: Date;
  jump_reported_at: Date | null;
  dismissed_at: Date | null;
  no_rebate: boolean;
  no_rebate_reason: string | null;
  authorized_after: boolean;
}

export interface PendingAttemptScope {
  app_id: string;
  user_id: string;
}

export interface PendingAttemptStore {
  listForUser(input: PendingAttemptScope & { since: Date }): Promise<PendingAttempt[]>;
  /** False means absent or outside the caller's scope; already dismissed is true. */
  dismiss(
    input: PendingAttemptScope & { link_id: string; attempt_id: string; at: Date },
  ): Promise<boolean>;
}

export function createPendingAttemptStore(db: Kysely<DB>): PendingAttemptStore {
  void db;
  throw new Error('NotImplemented: createPendingAttemptStore');
}
