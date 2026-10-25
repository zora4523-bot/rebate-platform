// POST /admin/v1/users/{user_id}/realname-correction (adminCorrectUserRealname, CT-24q; 规划/08 BR-ID-25
// 细则「实名更正」; D10-165, D10-167, D10-181 ②, D10-185, D10-192, D10-246, D10-248, D10-250; task
// B1-27a §9). identity is the only writer of app.realname and app.realname_prior_identities.
//
// After the admin request check, the operation guard (user.realname_fix, totp step-up) and the body
// schema, first hit wins:
//   1. 20001 data.fields=[user_id] — no user of this app with that id.
//   2. 30419 data.reason, no vendor call:
//        realname_not_verified   the realname row is missing or not verified
//        account_deleting        deletion stage cooling / processing (data.stage, as 10007's)
//        account_deleted         deletion stage done (no data.stage)
//        withdrawal_in_progress  any withdrawal outside the BR-WDR-08 terminal set (hasNonTerminal)
//        identity_blacklisted    the current id_no_hmac is on an active id_no blocklist entry
//      (reverify_pending: TODO(规划/11 §2.3) — blocked on the flag's table and task.)
//   3. 20001 data.fields=[id_no] — format (parseResidentIdNo, as realname.ts).
//   4. 44001 — the new number is on an active id_no blocklist entry; no risk_hits, no appeal.
//   5. 30407 — under MIN_REALNAME_AGE at the Clock instant (BR-ID-26).
//   6. 30405 — the new id_no_hmac is verified on another user of this app (the user's own does not
//      count; the other account is never revealed).
//   7. vendor (createRealnameVerifier): mismatch 30406, timeout 50401, anything else 50301; nothing
//      is saved and nothing is counted against the user's daily attempts.
//   8. match → one transaction: lock the user row (as a withdrawal application), judge
//      hasNonTerminal again (30419 withdrawal_in_progress, nothing written); when hasSucceeded,
//      insertPriorIdentity (../infra/realname-prior-identities.ts); overwrite the realname row (same
//      id: name, ID number and birth date ciphertexts, id_no_hmac, provider, verified_at = Clock);
//      every payout account of the user is_current = false (row_version CAS); publish
//      user.realname_corrected (old and new id_no_hmac, no plaintext); the audit row.
// Every submission from 1 on writes one audit row user_realname_correct (admin, reason, result
// code, the new value masked or its id_no_hmac; a success also the masked before and after values);
// a refusal's row is written in a short transaction of its own. No name or ID number in plaintext
// in logs, audits, events or errors.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, FieldCrypto, RootLogger } from '../../platform/index.ts';
import type { RealnameVerifierPort } from '../ports/realname-verifier.ts';

export interface AdminRealnameCorrectionCommand {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
  readonly userId: string;
  /** As submitted; normalised here. */
  readonly name: string;
  /** As submitted; normalised here. */
  readonly idNo: string;
  readonly reason: string;
}

export interface AdminUserRealname {
  readonly user_id: string;
  readonly realname_status: 'verified';
  readonly masked_name: string;
  readonly masked_id_no: string;
  readonly verified_at: string;
}

export type AdminRealnameCorrectionRefusal =
  | {
      readonly reason: 'realname_not_verified' | 'account_deleted';
    }
  | { readonly reason: 'account_deleting'; readonly stage: 'cooling' | 'processing' }
  | { readonly reason: 'withdrawal_in_progress' | 'identity_blacklisted' };

export type AdminRealnameCorrectionResult =
  | { readonly code: 0; readonly data: AdminUserRealname }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | { readonly code: 30419; readonly data: AdminRealnameCorrectionRefusal }
  | { readonly code: 30405 | 30406 | 30407 | 44001 | 50301 | 50401 };

export interface AdminRealnameCorrectionOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly crypto: FieldCrypto;
  /** PRIOR_IDENTITY_FIELD_CRYPTO: the isolated store's own keys. */
  readonly priorCrypto: FieldCrypto;
  /** createRealnameVerifier(appEnv): null when no vendor is assembled (50301). */
  readonly verifier: RealnameVerifierPort | null;
}

export class AdminRealnameCorrection {
  constructor(options: AdminRealnameCorrectionOptions) {
    void options;
    throw new Error('NotImplemented: AdminRealnameCorrection');
  }

  correct(command: AdminRealnameCorrectionCommand): Promise<AdminRealnameCorrectionResult> {
    void command;
    throw new Error('NotImplemented: AdminRealnameCorrection.correct');
  }
}
