// B1-06zc: linking's share of identity's deletion cleanup (08 BR-ID-28 细则「注销删除与保留范围」:
// 联盟绑定 blocked（deletion）; BR-ID-20; identity/ports/deletion-cleanup.ts DeletionCleanupStep),
// assembled by app.module in place of linking's unavailable marker.
// - Every union_bindings row of the user (this app only) that can still become blocked (active,
//   invalid, pending_auth) becomes blocked with blocked_reason deletion (row_version + 1,
//   updated_at = at; bound_at, relation_id and the release instants kept).
// - Rows already blocked keep their reason (a banned user's bindings stay ban, admin_disable
//   stays); released and unbound rows are untouched; no row is deleted or inserted; link_logs are
//   kept (BR-ID-30 ②).
// - Runs on identity's cleanup transaction (users row already locked) and is re-entrant: a second
//   call changes nothing. Rule tests: test/spec/linking/deletion-cleanup/**.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface BlockForDeletionInput {
  readonly appId: string;
  readonly userId: string;
  /** The cleanup step's Clock reading. */
  readonly at: Date;
}

/** identity's DeletionCleanupStep for linking, on the caller's transaction. */
export function blockForDeletion(
  trx: Transaction<DB>,
  input: BlockForDeletionInput,
): Promise<void> {
  void trx;
  void input;
  throw new Error('NotImplemented: blockForDeletion');
}
