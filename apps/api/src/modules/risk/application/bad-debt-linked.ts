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
import { sql, type Transaction } from 'kysely';
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

/**
 * The linked members of `input.sourceUserId` in its app, one (user, dimension) per row, the
 * written-off member excluded. UNION drops a repeated (user, dimension) within one dimension.
 */
function linkedMembers(input: BadDebtLinkedMarkInput) {
  const { appId, sourceUserId } = input;
  return sql`
    SELECT other.user_id, 'id_no'::text AS dimension
    FROM app.realname mine
    JOIN app.realname other
      ON other.app_id = mine.app_id AND other.id_no_hmac = mine.id_no_hmac
    WHERE mine.app_id = ${appId} AND mine.user_id = ${sourceUserId}::uuid
      AND mine.status = 'verified' AND other.status = 'verified'
      AND other.user_id <> mine.user_id
    UNION
    SELECT other.user_id, 'device'::text AS dimension
    FROM app.sessions mine
    JOIN app.sessions other
      ON other.app_id = mine.app_id AND other.device_id = mine.device_id
    WHERE mine.app_id = ${appId} AND mine.user_id = ${sourceUserId}::uuid
      AND other.user_id <> mine.user_id
    UNION
    SELECT other.user_id, 'payout_account'::text AS dimension
    FROM app.payout_accounts mine
    JOIN app.payout_accounts other
      ON other.app_id = mine.app_id
      AND (other.alipay_hmac = mine.alipay_hmac OR other.bank_card_hmac = mine.bank_card_hmac)
    WHERE mine.app_id = ${appId} AND mine.user_id = ${sourceUserId}::uuid
      AND mine.is_current AND other.is_current
      AND other.user_id <> mine.user_id`;
}

export function createBadDebtLinkedMarker(
  options: BadDebtLinkedMarkerOptions,
): BadDebtLinkedMarker {
  return {
    async mark(trx, input) {
      const at = options.clock.now();
      // One statement on the caller's transaction: reads and the insert see the same snapshot;
      // ordered by (user, dimension) so the identity follows a stable order.
      await sql`
        INSERT INTO app.risk_linked_marks
          (app_id, user_id, source_user_id, source_ref, dimension, created_at)
        SELECT ${input.appId}::text, linked.user_id, ${input.sourceUserId}::uuid,
          ${input.sourceRef}::text, linked.dimension, ${at}::timestamptz
        FROM (${linkedMembers(input)}) AS linked
        ORDER BY linked.user_id, linked.dimension
        ON CONFLICT (app_id, source_ref, user_id, dimension) DO NOTHING`.execute(trx);
    },
  };
}
