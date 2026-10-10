// Risk scans of the worker entry (BR-ID-36; task B1-03j, orchestrator ruling §9.3).
//
// freeze-expiry: every user (all app_id) with state frozen and a frozen_until at or before the
// injected Clock goes back to normal through the risk state service (the single writer of
// user_risk_state), one transaction per user: the row is re-read with FOR UPDATE under the same
// conditions first, so a manual change, an appeal or a ban committed after the candidate read
// is never overwritten, and a change attempted while the scan holds the row waits for its commit.
// The service publishes risk.state_changed in that transaction; the scan sends nothing itself.
// A CAS conflict, a row that no longer qualifies or a failure of one user skips that user (a
// warn line for failures), and the next scan judges it again. appealing (even past
// frozen_until), banned, normal and indefinite freezes are not touched. Candidates are read in
// keyset batches over (app_id, user_id) with a LIMIT, so users released by an earlier batch never
// shift a later one. A candidate read that fails rejects (the queue retries the job).
//
// daily-alerts: indefinite freezes (frozen_until null) unchanged for at least 30×24 hours
// (`risk_freeze_indefinite_overdue`: app_id, user_id, changed_at, days) and processing appeals
// past deadline_at (`risk_appeal_overdue`: app_id, appeal_id, target_type, deadline_at), one warn
// line each, flat fields only (never the reason or the appeal content). Nothing is changed.
//
// Job chain (queue risk-scan, policy exclusive): seed() enqueues the current slot of both jobs;
// handle() runs the job's scan and then enqueues the next slot of the same job (see
// ../domain/risk-scan-slots.ts). A failed scan rejects before enqueuing (the queue retries this
// job, whose key stays reserved); a failed enqueue after a successful scan is logged as warn and
// the job still succeeds.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, JobQueue, ReceivedJob, RootLogger } from '../../platform/index.ts';
import {
  currentRiskScanSlot,
  dateAt,
  nextRiskScanSlot,
  type RiskScanJobName,
} from '../domain/risk-scan-slots.ts';
import { RiskStateConflictError, type RiskStateService } from './risk-state.ts';

export interface RiskScanOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly riskState: RiskStateService;
  readonly queue: JobQueue;
  readonly logger: RootLogger;
}

export interface RiskScan {
  expireFrozen(): Promise<void>;
  dailyAlerts(): Promise<void>;
  /** Current-slot seeds: freeze-expiry:YYYY-MM-DDTHH:mm (UTC), daily-alerts:YYYY-MM-DD (+08). */
  seed(): Promise<void>;
  /** Scan, then enqueue the next slot; its key differs from this still-active job's key. */
  handle(job: ReceivedJob): Promise<void>;
}

/** The queue of the chain (platform/queue/catalog.ts: exclusive, worker only). */
export const RISK_SCAN_QUEUE = 'risk-scan';
/** changed_by of a release by the expiry scan (user_risk_state keeps who changed the row). */
export const FREEZE_EXPIRY_ACTOR = 'system:freeze-expiry';
/** Rows read per candidate query. */
const BATCH_SIZE = 100;
const DAY_MS = 86_400_000;
/** BR-ID-36 / FUND-17: an indefinite freeze without a decision is reported after 30 days. */
const INDEFINITE_OVERDUE_DAYS = 30;

const JOB_NAMES: readonly RiskScanJobName[] = ['freeze-expiry', 'daily-alerts'];

function isJobName(name: string): name is RiskScanJobName {
  return (JOB_NAMES as readonly string[]).includes(name);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

interface UserCursor {
  readonly app_id: string;
  readonly user_id: string;
}

const RISK_SCAN_TOKEN = Symbol('RISK_SCAN');

/** DI token of the worker's assembled scan (null when the entry has no database). */
export function riskScanToken(): symbol {
  return RISK_SCAN_TOKEN;
}

// TODO(规划/11 §3.2): 冻结到期解冻写 audit_logs — blocked on audit_logs 只记后台操作人（规格同步任务）
export function createRiskScan(options: RiskScanOptions): RiskScan {
  const { db, clock, riskState, queue, logger } = options;

  /** Visits what `read` returns, batch by batch, keyed on (app_id, user_id) after the last row. */
  async function eachUserBatch<R extends UserCursor>(
    read: (after: UserCursor | null) => Promise<R[]>,
    visit: (rows: readonly R[]) => Promise<void>,
  ): Promise<void> {
    let after: UserCursor | null = null;
    for (;;) {
      const batch = await read(after);
      await visit(batch);
      if (batch.length < BATCH_SIZE) return;
      const last = batch[batch.length - 1]!;
      after = { app_id: last.app_id, user_id: last.user_id };
    }
  }

  /** Releases one candidate in its own transaction; false when it no longer qualifies. */
  async function release(subject: UserCursor): Promise<boolean> {
    // db.transaction() of the handle as given: no wrapper around the caller's handle.
    return db.transaction().execute(async (trx) => {
      const row = await trx
        .withSchema('app')
        .selectFrom('user_risk_state')
        .select('row_version')
        .where('app_id', '=', subject.app_id)
        .where('user_id', '=', subject.user_id)
        .where('state', '=', 'frozen')
        .where('frozen_until', 'is not', null)
        .where('frozen_until', '<=', clock.now())
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return false;
      await riskState.setRiskState(trx, {
        app_id: subject.app_id,
        user_id: subject.user_id,
        state: 'normal',
        reason: null,
        reason_category: null,
        frozen_until: null,
        changed_by: FREEZE_EXPIRY_ACTOR,
      });
      return true;
    });
  }

  async function expireFrozen(): Promise<void> {
    const now = clock.now();
    await eachUserBatch(
      (after) =>
        db
          .withSchema('app')
          .selectFrom('user_risk_state')
          .select(['app_id', 'user_id'])
          .where('state', '=', 'frozen')
          .where('frozen_until', 'is not', null)
          .where('frozen_until', '<=', now)
          .$if(after !== null, (qb) =>
            qb.where((eb) =>
              eb(eb.refTuple('app_id', 'user_id'), '>', eb.tuple(after!.app_id, after!.user_id)),
            ),
          )
          .orderBy('app_id')
          .orderBy('user_id')
          .limit(BATCH_SIZE)
          .execute(),
      async (rows) => {
        for (const subject of rows) {
          try {
            await release(subject);
          } catch (error) {
            // Skipped (nothing written for this user): the next scan judges it again.
            logger.warn(
              {
                app_id: subject.app_id,
                user_id: subject.user_id,
                cause: error instanceof RiskStateConflictError ? 'conflict' : 'error',
                error_name: errorName(error),
              },
              'risk_freeze_expiry_skipped',
            );
          }
        }
      },
    );
  }

  async function indefiniteOverdue(now: Date): Promise<void> {
    const cutoff = dateAt(now, now.getTime() - INDEFINITE_OVERDUE_DAYS * DAY_MS);
    await eachUserBatch(
      (after) =>
        db
          .withSchema('app')
          .selectFrom('user_risk_state')
          .select(['app_id', 'user_id', 'changed_at'])
          .where('state', '=', 'frozen')
          .where('frozen_until', 'is', null)
          .where('changed_at', '<=', cutoff)
          .$if(after !== null, (qb) =>
            qb.where((eb) =>
              eb(eb.refTuple('app_id', 'user_id'), '>', eb.tuple(after!.app_id, after!.user_id)),
            ),
          )
          .orderBy('app_id')
          .orderBy('user_id')
          .limit(BATCH_SIZE)
          .execute(),
      async (rows) => {
        for (const row of rows) {
          const changedAt = row.changed_at;
          logger.warn(
            {
              app_id: row.app_id,
              user_id: row.user_id,
              changed_at: changedAt.toISOString(),
              days: Math.floor((now.getTime() - changedAt.getTime()) / DAY_MS),
            },
            'risk_freeze_indefinite_overdue',
          );
        }
      },
    );
  }

  async function appealsOverdue(now: Date): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const cursor: string | null = after;
      const batch = await db
        .withSchema('app')
        .selectFrom('appeals')
        .select(['id', 'app_id', 'target_type', 'deadline_at'])
        .where('status', '=', 'processing')
        .where('deadline_at', '<', now)
        .$if(cursor !== null, (qb) => qb.where('id', '>', cursor!))
        .orderBy('id')
        .limit(BATCH_SIZE)
        .execute();
      for (const row of batch) {
        logger.warn(
          {
            app_id: row.app_id,
            appeal_id: row.id,
            target_type: row.target_type,
            deadline_at: row.deadline_at.toISOString(),
          },
          'risk_appeal_overdue',
        );
      }
      if (batch.length < BATCH_SIZE) return;
      after = batch[batch.length - 1]!.id;
    }
  }

  async function dailyAlerts(): Promise<void> {
    const now = clock.now();
    await indefiniteOverdue(now);
    await appealsOverdue(now);
  }

  async function enqueueNext(name: RiskScanJobName): Promise<void> {
    // The slot follows the Clock at completion: a slot that passed during the scan is not sent.
    const slot = nextRiskScanSlot(name, clock.now());
    try {
      await queue.send(RISK_SCAN_QUEUE, name, {}, { trx: null, ...slot });
    } catch (error) {
      logger.warn(
        {
          queue: RISK_SCAN_QUEUE,
          job_name: name,
          singleton_key: slot.singletonKey,
          error_name: errorName(error),
        },
        'risk_scan_enqueue_failed',
      );
    }
  }

  return {
    expireFrozen,
    dailyAlerts,
    async seed() {
      const now = clock.now();
      let failure: { readonly error: unknown } | null = null;
      for (const name of JOB_NAMES) {
        try {
          await queue.send(
            RISK_SCAN_QUEUE,
            name,
            {},
            { trx: null, ...currentRiskScanSlot(name, now) },
          );
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure !== null) throw failure.error;
    },
    async handle(job) {
      if (!isJobName(job.name)) throw new Error(`unknown risk-scan job: ${job.name}`);
      if (job.name === 'freeze-expiry') await expireFrozen();
      else await dailyAlerts();
      await enqueueNext(job.name);
    },
  };
}

/** Whether a resolved provider value is an assembled scan (anything else counts as none). */
function isRiskScan(value: unknown): value is RiskScan {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { seed?: unknown }).seed === 'function'
  );
}

/**
 * Seeds the chain once the worker's queue runtime has started (entry.ts). `resolve` returns the
 * provider of riskScanToken() (null without a database). No scan or a stop already requested:
 * nothing is sent. A failure (resolving or sending) is logged as warn and never fails the
 * worker; the next worker start seeds again.
 */
export async function seedRiskScan(
  resolve: () => unknown,
  logger: RootLogger,
  stopping: () => boolean,
): Promise<void> {
  try {
    if (stopping()) return;
    const scan = resolve();
    if (!isRiskScan(scan)) return;
    await scan.seed();
  } catch (error) {
    logger.warn({ queue: RISK_SCAN_QUEUE, error_name: errorName(error) }, 'risk_scan_seed_failed');
  }
}
