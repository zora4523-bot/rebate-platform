// B2-12f skeleton (test phase; NotImplemented only): 08 BR-FUND-12 负余额坏账核销, contracts/openapi.yaml
// adminListBadDebtWriteoffs (GET /admin/v1/bad-debt-writeoffs, fund.writeoff or fund.view, read only)
// and adminApproveBadDebtWriteoff (POST /admin/v1/bad-debt-writeoffs/{id}/approve, fund.writeoff,
// step-up sms, Idempotency-Key), specs/state-machines/bad-debt-writeoff.yaml (BD1–BD3) and the
// BAD_DEBT_WRITEOFF template of specs/ledger-templates.csv.
//
// Conventions the rule tests (test/spec/ledger/bad-debt-writeoffs/) rely on:
// - Generation runs on the worker entry only, through LedgerBadDebtWriteoffModule.forWorker
//   (../bad-debt-writeoff.module.ts), which app.module calls once: a timer whose first tick is at
//   most 15 s after bootstrap and then at most every 60 s (no overlap; stopped on destroy).
// - Every tick lists the apps with ledger accounts; for each app, once the daily ledger check (R3)
//   of the day before the Clock's +08:00 accounting day D is recorded done (app.processed_events,
//   consumer ledger.daily_check_done, event_id dailyCheckDoneEventId(app, D − 1)), it generates the
//   candidates of D: account_balances with available_fen < 0, D − negative_since ≥
//   ledger.bad_debt_days (no row: 90) and |available_fen| ≥ ledger.bad_debt_min_fen (no row: 0),
//   no PENDING candidate of the account, the member not deleting or deleted. A candidate is
//   PENDING with candidate_fen = −available_fen, the balance's negative_since, initiator_id null and
//   created_at the Clock's now; nothing else is written.
// - Approval: one transaction, users row then balance row locked (BR-WDR-07 order), the candidate
//   and the balance read again under the locks; the amount is −available at that moment.
// Ledger imports neither identity nor content: their parts arrive as ports from app.module.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { AuditPort, Clock, Idempotency, RootLogger } from '../../platform/index.ts';
import type { Ledger } from './reverse.ts';

/** bad_debt_writeoffs.status (contracts/enums/fund.yaml bad_debt_writeoff_status). */
export type BadDebtWriteoffStatus = 'PENDING' | 'APPROVED' | 'CANCELLED';

/** ledger.bad_debt_days and ledger.bad_debt_min_fen of one app (no row: 90 and 0). */
export interface BadDebtThresholds {
  readonly days: number;
  readonly minFen: bigint;
}

/** What app.module hands in (identity's and content's parts). */
export interface BadDebtWriteoffPorts {
  /** content: the app's thresholds; a missing row is its default (90 days, 0 fen). */
  readonly thresholds: (db: Kysely<DB>, clock: Clock, appId: string) => Promise<BadDebtThresholds>;
  /** content: ledger.bad_debt_require_no_frozen.enabled, read at approval; a missing row is on. */
  readonly requireNoFrozen: (db: Kysely<DB>, clock: Clock, appId: string) => Promise<boolean>;
  /** identity: of `userIds`, the members whose deletion has started (deleting) or ended (deleted). */
  readonly closingUsers: (
    db: Kysely<DB>,
    input: { readonly appId: string; readonly userIds: readonly string[] },
  ) => Promise<ReadonlySet<string>>;
  /** identity: the users rows FOR UPDATE, before the balance rows (BR-WDR-07). */
  readonly lockUsersForUpdate: (
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly userIds: readonly string[] },
  ) => Promise<unknown>;
}

export interface BadDebtCandidateTickDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly ports: BadDebtWriteoffPorts;
  readonly isStopped: () => boolean;
}

export interface BadDebtCandidateTickResult {
  /** Candidates written by this tick, all apps together. */
  readonly generated: number;
}

/** One tick of the generation over every app (see the conventions above). */
export function tickBadDebtWriteoffCandidates(
  deps: BadDebtCandidateTickDependencies,
): Promise<BadDebtCandidateTickResult> {
  void deps;
  throw new Error('NotImplemented: tickBadDebtWriteoffCandidates');
}

/** One row of the list and of the approval's answer (AdminBadDebtWriteoff). */
export interface AdminBadDebtWriteoffView {
  readonly id: string;
  readonly account_id: string;
  readonly user_id: string;
  readonly negative_since: string;
  readonly negative_days: number;
  readonly candidate_fen: bigint;
  readonly available_fen: bigint;
  readonly frozen_fen: bigint;
  readonly status: BadDebtWriteoffStatus;
  readonly approve_blocked: boolean;
  readonly initiator_id: string | null;
  readonly approver_id: string | null;
  readonly approved_at: Date | null;
  readonly voucher_id: string | null;
  readonly created_at: Date;
}

export interface AdminBadDebtWriteoffPageView {
  readonly items: readonly AdminBadDebtWriteoffView[];
  readonly page: number;
  readonly page_size: number;
  readonly total: number;
}

export interface AdminBadDebtWriteoffListQuery {
  readonly appId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly status: BadDebtWriteoffStatus | null;
  readonly userId: string | null;
}

export interface AdminBadDebtWriteoffReadDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly ports: BadDebtWriteoffPorts;
}

/** GET /admin/v1/bad-debt-writeoffs: created_at then id descending; nothing written. */
export function listAdminBadDebtWriteoffs(
  deps: AdminBadDebtWriteoffReadDeps,
  query: AdminBadDebtWriteoffListQuery,
): Promise<AdminBadDebtWriteoffPageView> {
  void deps;
  void query;
  throw new Error('NotImplemented: listAdminBadDebtWriteoffs');
}

export interface AdminBadDebtWriteoffApproveDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly idempotency: Idempotency;
  /** The ledger with the entry's event bus and payout's recovery hook. */
  readonly ledger: Ledger;
  /** admin's audit writer bound to the approving transaction. */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  readonly ports: BadDebtWriteoffPorts;
}

export interface AdminBadDebtWriteoffApproveInput {
  readonly appId: string;
  readonly adminId: string;
  readonly candidateId: string;
}

export interface AdminBadDebtWriteoffApproval {
  readonly writeoff: AdminBadDebtWriteoffView;
  /** The voucher's amount; 0 when the candidate was cancelled. */
  readonly written_off_fen: bigint;
}

/** The approval's effects in one transaction (BD2 APPROVE, BD3 CANCEL; contract order of checks). */
export function approveAdminBadDebtWriteoff(
  deps: AdminBadDebtWriteoffApproveDeps,
  input: AdminBadDebtWriteoffApproveInput,
): Promise<AdminBadDebtWriteoffApproval> {
  void deps;
  void input;
  throw new Error('NotImplemented: approveAdminBadDebtWriteoff');
}
