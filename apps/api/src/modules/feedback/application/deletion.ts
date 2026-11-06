// B1-28p: feedback's share of identity's deletion cleanup (08 BR-ID-28 删除清单「商品反馈记录」,
// BR-ID-30 细则「商品反馈记录」). Shaped as identity's DeletionCleanupStep: called inside the cleanup
// transaction (users row already locked) on the caller's transaction, never opening or committing
// one; re-entrant. Deletes the rows of app.product_feedbacks carrying the user's user_id in the
// app; guest rows (no user_id) stay. app.module assembles it as deletionCleanupPorts.feedback.
// Rule tests: test/spec/feedback/product-feedback/**.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface FeedbackDeletionInput {
  readonly appId: string;
  readonly userId: string;
  readonly at: Date;
}

/** Deletes every app.product_feedbacks row of the user in the app, on the caller's transaction. */
export async function deleteFeedbackForUser(
  trx: Transaction<DB>,
  input: FeedbackDeletionInput,
): Promise<void> {
  void trx;
  void input;
  throw new Error('NotImplemented: deleteFeedbackForUser');
}
