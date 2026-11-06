// B2-12g: 08 BR-FUND-12「核销时给同实名、同设备、同收款账号的关联账户打风控标记」. Trace only: the marks
// change no withdrawal decision, send no notice and have no console endpoint.
//
// - risk is the only writer of app.risk_linked_marks (append only: couli_app SELECT / INSERT).
// - ledger's bad-debt approval calls mark() on its own transaction, only when it writes the
//   BAD_DEBT_WRITEOFF voucher (not on CANCELLED, not when the frozen check refuses); app.module
//   hands the marker to ledger.
// - Linked accounts, same app, the written-off user excluded, one row per (user, dimension):
//   id_no: a verified realname with the written-off user's (verified) id_no_hmac;
//   device: a session (revoked ones too) on any device of the written-off user's sessions (revoked
//   ones too), never devices.user_id;
//   payout_account: the written-off user's current payout account HMAC (per payout_accounts column).
// - Replays write nothing new (unique (app_id, source_ref, user_id, dimension), ON CONFLICT DO
//   NOTHING); created_at is the injected Clock's now. No plaintext and no HMAC is stored.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

/** risk_linked_marks.dimension. */
export type BadDebtLinkedDimension = 'id_no' | 'device' | 'payout_account';

export interface BadDebtLinkedMarkInput {
  readonly appId: string;
  /** The written-off user (source_user_id). */
  readonly sourceUserId: string;
  /** The write-off candidate's id (source_ref). */
  readonly sourceRef: string;
}

export interface BadDebtLinkedMarker {
  /** Marks the linked accounts on the approving transaction. */
  mark(trx: Transaction<DB>, input: BadDebtLinkedMarkInput): Promise<void>;
}

export interface BadDebtLinkedMarkerOptions {
  readonly clock: Clock;
}

export function createBadDebtLinkedMarker(
  options: BadDebtLinkedMarkerOptions,
): BadDebtLinkedMarker {
  void options;
  throw new Error('NotImplemented: createBadDebtLinkedMarker');
}
