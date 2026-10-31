// Identity's port for the DELETION_PROGRESS inbox message (task B1-15i; BR-TEXT-23, BR-ID-27).
// identity never imports notification: app.module assembles this port over notification's
// writeDeletionProgressMessage (through notification/index.ts) and hands it to IdentityModule
// (requested on entering cooling, cancelled on the user's withdrawal) and to
// IdentityDeletionExpiryModule (cancelled_negative when cooling ends with a negative balance).
// Always called on the business transaction, after its write: a failure rolls both back; a
// repeated call for the same request and variant writes nothing (deduplicated by notification).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

interface DeletionProgressNoticeSubject {
  readonly app_id: string;
  readonly user_id: string;
  readonly deletion_request_id: string;
}

export type DeletionProgressNoticeInput =
  | (DeletionProgressNoticeSubject & {
      readonly variant: 'requested';
      /** The request's cooling_until. */
      readonly cancel_deadline: Date;
    })
  | (DeletionProgressNoticeSubject & { readonly variant: 'cancelled' })
  | (DeletionProgressNoticeSubject & {
      readonly variant: 'cancelled_negative';
      /** −available_fen as read in this transaction (positive bigint fen); never reread. */
      readonly amount_fen: bigint;
    });

export interface DeletionProgressNotice {
  write(trx: Transaction<DB>, input: DeletionProgressNoticeInput): Promise<void>;
}
