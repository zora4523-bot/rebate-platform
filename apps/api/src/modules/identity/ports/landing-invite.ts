// The ports of identity's landing registration (task B1-11h; POST /v1/invites/landing-register),
// assembled by app.module so identity imports neither growth nor content:
// - LandingInvitePort: growth's landing channel (its createLandingInviteBinder is structurally this
//   shape) — the precheck before the SMS code (switch 30408, the phone / IP 30401 counts 42901, the
//   code and the inviter 30401) and the binding inside the registration transaction (relation
//   write lock, the inviter judged again, the conditional update and its relation log);
// - LandingRegisterConfigReader: business configuration read on the caller's handle (content's
//   reader bound to it, uncached), as the labor agreement's port (B1-13h).
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';

export interface LandingInvitePrecheckInput {
  readonly app_id: string;
  /** users.phone_hmac of the normalised phone. */
  readonly phone_hmac: string;
  readonly client_ip: string;
  /** As sent by the page (growth normalises it, BR-INV-02). */
  readonly invite_code: string;
  /** The request's Idempotency-Key. */
  readonly attempt_key: string;
}

export type LandingInvitePrecheck =
  | { readonly ok: true; readonly inviter_id: string }
  | {
      readonly ok: false;
      readonly code: 30401 | 30408 | 42901 | 50001;
      readonly retry_after_seconds?: number;
    };

export interface LandingInviteBindInput {
  readonly app_id: string;
  readonly user_id: string;
  readonly inviter_id: string;
  readonly phone_hmac: string;
  readonly client_ip: string;
  readonly attempt_key: string;
}

export type LandingInviteBind =
  | { readonly result: 'bound'; readonly parent_id: string; readonly bound_at: Date }
  | { readonly result: 'failed'; readonly code: 30401 | 50001 };

export interface LandingInvitePort {
  precheck(trx: Transaction<DB>, input: LandingInvitePrecheckInput): Promise<LandingInvitePrecheck>;
  bind(trx: Transaction<DB>, input: LandingInviteBindInput): Promise<LandingInviteBind>;
}

/** Configuration by app and key on the caller's handle: no cache, no second pooled connection. */
export interface LandingRegisterConfigReader {
  configValue(
    appId: string,
    key: string,
    handle: Kysely<DB>,
  ): Promise<{ readonly value: unknown; readonly version: number } | null>;
}
