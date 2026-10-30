// B2-07e: POST /admin/v1/recon-diffs/{recon_diff_id}/write-off (writeOffAdminReconDiff; 08
// BR-WDR-23 ③, BR-WDR-08 W11; 04 §11.2 payout.execute, step-up tier totp). Only authorisation, the
// parameters and the call into application/admin-recon-diff-write-off.ts live here.
//
// Mounted only by LedgerAdminModule.forAdmin on the admin entry. The AdminOperationGuard re-reads
// the account, checks payout.execute and the totp-tier X-Step-Up-Token (10003 data.tier=totp);
// inside the guard the use case runs under platform idempotency (subject a:<admin_users.id>) and
// returns the exact bytes to send, written raw here as the close controller does. Without the
// database or the idempotency primitive the route still registers and every call fails closed.
import type { Schema } from '@couli/contracts-ts';
import type { AdminOperationGuard, CheckedRequest } from '../../../platform/index.ts';
import type { WriteOffAdminReconDiffDeps } from '../../application/admin-recon-diff-write-off.ts';

export interface AdminReconDiffWriteOffRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** What the handler writes on the Fastify reply (the idempotency module's exact bytes). */
export interface AdminReconDiffWriteOffRawReply {
  code(statusCode: number): AdminReconDiffWriteOffRawReply;
  type(contentType: string): AdminReconDiffWriteOffRawReply;
  send(payload: string): unknown;
}

export class AdminReconDiffWriteOffController {
  constructor(guard: AdminOperationGuard, deps: WriteOffAdminReconDiffDeps | null) {
    void guard;
    void deps;
    throw new Error('NotImplemented: AdminReconDiffWriteOffController');
  }

  writeOff(
    request: AdminReconDiffWriteOffRequest,
    reconDiffId: string,
    body: Schema<'AdminReconDiffWriteOffRequest'>,
    reply: AdminReconDiffWriteOffRawReply,
  ): Promise<void> {
    void request;
    void reconDiffId;
    void body;
    void reply;
    throw new Error('NotImplemented: AdminReconDiffWriteOffController.writeOff');
  }
}
