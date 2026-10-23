// Processing of deletion requests that reached processing: cleanup and done (task B1-15g; 08
// BR-ID-27, BR-ID-28, BR-ID-04, BR-ID-20, BR-AI-22, BR-FUND-24 ⑧; orchestrator brief §9.2,
// rulings D10-137, D10-186).
//
// One round (runOnce), run by the worker's deletion timer before the cooling-period expiry:
// across apps, `status = 'processing'`, keyset batches on id; one request that throws is one warn
// line and the round goes on; a stop request is honoured between requests. Per request, three
// steps, each with its own Clock reading:
//   ① cleanup transaction (cleaned_at still NULL): users row, then the request; sessions revoked
//      (account_deleted), nickname / avatar reset, real name cleared or retained (tax_retained),
//      payout accounts anonymized, login_logs detached, the cross-module ports; cleaned_at = now
//      only when every port is available.
//   ② Apple revocation outside any transaction (cleaned_at set, apple_revoke_result NULL): at most
//      one attempt per round, the third failure is final (failed) and alerts, never blocking done.
//   ③ completion transaction: closing adjustment none_needed / done required; phone_hmac and the
//      device hashes into deleted_identities (180 days), user_oauth deleted, users tombstone
//      (status deleted), the request COMPLETE → done.
// Progress columns (cleaned_at, apple_*) never move row_version / updated_at.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, FieldCrypto, RootLogger } from '../../platform/index.ts';
import type { AppleTokenRevoker } from '../ports/apple-token-revoker.ts';
import type {
  DeletionCleanupPorts,
  DeletionClosingAdjustmentReader,
} from '../ports/deletion-cleanup.ts';
import type { WithdrawalSucceededReader } from '../ports/withdrawal-in-flight.ts';
import type { AfterSessionsRevoked } from './revoke-sessions.ts';

export interface DeletionProcessingOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** Decrypts user_oauth.apple_refresh_token_cipher (APPLE_REFRESH_TOKEN_CONTEXT). */
  readonly crypto: FieldCrypto;
  readonly cleanup: DeletionCleanupPorts;
  readonly funds: DeletionClosingAdjustmentReader;
  /** D10-137 ②: a paid-out withdrawal keeps the real-name ciphertext (tax_retained). */
  readonly withdrawals: WithdrawalSucceededReader;
  readonly apple: AppleTokenRevoker;
  /** The push token unbinding of the revoked sessions, in the cleanup transaction. */
  readonly afterRevoked?: AfterSessionsRevoked;
  readonly batchSize?: number;
}

export interface DeletionProcessing {
  /** The timer passes its stop predicate so shutdown can finish the current request only. */
  runOnce(stopping?: () => boolean): Promise<{ scanned: number }>;
}

export function createDeletionProcessing(options: DeletionProcessingOptions): DeletionProcessing {
  void options;
  throw new Error('NotImplemented: createDeletionProcessing');
}
