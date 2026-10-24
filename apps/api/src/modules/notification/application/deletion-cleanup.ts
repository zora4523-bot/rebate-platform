// F1-02zzk: notification's share of identity's deletion cleanup (identity
// DeletionCleanupPorts.notification; 08 BR-ID-28 「推送 token」 among the data deleted or
// anonymized, BR-ID-30 「推送令牌：失效即删（…注销时删除）」; brief §9.2, ruling D10-311 ①).
//
// deletePushTokensForUser — the DeletionCleanupStep app.module hands to identity: on the caller's
//   transaction (identity's cleanup transaction, the users row already locked), deletes every
//   push_tokens row of (appId, userId), whatever its state (bound, unbound from a session but still
//   carrying the user, revoked, frozen). Rows of other users of the app, rows without a user and
//   rows of other apps are untouched. Re-entrant: a second call deletes nothing and does not throw.
//   inbox_messages and notify_logs keep their own retention (BR-ID-30) and notification_settings
//   is not touched (D10-311 ①). No log line carries a token value.
//
// The input restates identity's DeletionCleanupInput: notification imports nothing of identity.
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

/** identity's DeletionCleanupInput (at = the cleanup step's Clock reading). */
export interface PushTokenDeletionInput {
  readonly appId: string;
  readonly userId: string;
  readonly at: Date;
}

export interface PushTokenDeletionResult {
  /** push_tokens rows this call deleted (0 on a repeated call). */
  readonly deleted: number;
}

/** Deletes every push_tokens row of (appId, userId) on the caller's transaction. */
export function deletePushTokensForUser(
  trx: Transaction<DB>,
  input: PushTokenDeletionInput,
): Promise<PushTokenDeletionResult> {
  void trx;
  void input;
  throw new Error('NotImplemented: deletePushTokensForUser');
}
