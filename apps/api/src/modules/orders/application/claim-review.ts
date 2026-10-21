// B1-10k test-phase seam. Both HTTP operations remain planned and unmounted (J-1).
// Implement with the existing order lock, generated claim transitions, claim-store, snapshot
// and source-backfill steps. The transaction locks orders first, then all affected claims by id.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { AuditPort, Clock, EventBus } from '../../platform/index.ts';
import type { AdminClaimPorts } from './admin-claims.ts';
import type { CommissionSnapshotPort, SnapshotOutcome } from './commission-snapshot-step.ts';
import type { OrderSourcePorts } from './source-backfill.ts';

export interface ClaimReviewActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface ClaimReviewCommand {
  readonly claimId: string;
  readonly itemId: string;
  readonly expected_row_version: number;
  readonly reason: string;
}

export interface ClaimRejectCommand extends ClaimReviewCommand {
  // Accept runtime input here so system-only / unknown codes can be refused with 20001.
  readonly reject_reason: string;
}

export interface ClaimApprovedInput {
  /** Immutable snapshot from SELECT FOR UPDATE, before orders writes attribution. */
  readonly before: Selectable<DB['orders']>;
  readonly userId: string;
  readonly now: Date;
  readonly snapshot: SnapshotOutcome;
}

export interface ClaimReviewDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly details: AdminClaimPorts;
  readonly events: Pick<EventBus, 'publish'>;
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  // Settlement alone writes locked and rebate_status. No real implementation in this task.
  readonly rebate: {
    onClaimApproved(trx: Transaction<DB>, input: ClaimApprovedInput): Promise<void>;
  };
  readonly snapshots?: CommissionSnapshotPort;
  readonly sources?: OrderSourcePorts;
  readonly pidScene?: (order: Selectable<DB['orders']>) => Promise<string | null>;
}

export type ClaimReviewResult =
  | { readonly code: 0; readonly data: Schema<'AdminClaimDetail'> }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | { readonly code: 20902; readonly data: { readonly resource: 'claim_item' } };

/** Operational failures propagate and roll back, including audit / event / port failures. */
export async function approveClaimItem(
  deps: ClaimReviewDeps,
  actor: ClaimReviewActor,
  command: ClaimReviewCommand,
): Promise<ClaimReviewResult> {
  void deps;
  void actor;
  void command;
  throw new Error('NotImplemented: approveClaimItem');
}

export async function rejectClaimItem(
  deps: ClaimReviewDeps,
  actor: ClaimReviewActor,
  command: ClaimRejectCommand,
): Promise<ClaimReviewResult> {
  void deps;
  void actor;
  void command;
  throw new Error('NotImplemented: rejectClaimItem');
}
