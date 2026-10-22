// Due job of a scheduled page publish (F1-09p; 编排者裁定 9.2 #5 / #6, Y8 / Y11): queue
// page-schedule, job content.page_schedule_due, payload {app_id, page_key}, sent by the admin
// publish in its own transaction. Delivered at least once: in one transaction the page row is
// locked FOR UPDATE, then
// - a slot due at the injected Clock takes effect (applyDueSchedule: the same write every page
//   write makes before its CAS; no audit row);
// - a slot not yet due (the job ran early: clock skew, or the slot was cancelled and re-made later)
//   sends the job again for the remaining time, in this transaction;
// - no slot (cancelled, or already applied by an earlier delivery or a page write): nothing.
// So a repeated or stale delivery never publishes twice or early. A slot whose version is no longer
// a draft throws (a bug): the transaction rolls back and the queue retries / dead-letters it.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { AuditPort, Clock, JobQueue, ReceivedJob, RootLogger } from '../../platform/index.ts';
import { applyDueSchedule } from '../application/page-config-admin.ts';
import { isSlotDue, slotDelaySeconds } from '../domain/pages/schedule.ts';
import {
  PAGE_SCHEDULE_JOB,
  PAGE_SCHEDULE_QUEUE,
  createKyselyPageConfigStore,
} from '../infra/kysely-page-config-store.ts';

export interface PageScheduleJobDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly logger: RootLogger;
}

export interface PageScheduleJob {
  handle(job: ReceivedJob): Promise<void>;
}

/** Applying a slot writes no audit row (Y9). */
const NO_AUDIT: AuditPort = {
  append: () =>
    Promise.reject(new Error('content: a scheduled publish taking effect is not audited')),
};

function target(payload: unknown): { appId: string; key: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { app_id: appId, page_key: key } = payload as Record<string, unknown>;
  return typeof appId === 'string' && typeof key === 'string' ? { appId, key } : null;
}

/** F1-09p: 到期后在页行锁内物化；提前收到时同事务重新入队。 */
export function createPageScheduleJob(deps: PageScheduleJobDeps): PageScheduleJob {
  const store = createKyselyPageConfigStore(deps.db, () => NO_AUDIT, deps.clock, deps.queue);
  return {
    async handle(job) {
      const page = target(job.payload);
      if (page === null) {
        // Not retryable: a malformed payload never becomes valid.
        deps.logger.warn(
          { event: 'page_schedule_invalid_payload', queue: PAGE_SCHEDULE_QUEUE, job_id: job.id },
          'page schedule job without app_id / page_key; skipped',
        );
        return;
      }
      const outcome = await store.transaction(async (tx) => {
        const row = await tx.lock(page.appId, page.key);
        if (row === undefined || row.slot === null) return 'none' as const;
        const now = deps.clock.now();
        if (!isSlotDue(row.slot, now)) {
          await tx.enqueueScheduleDue(page.appId, page.key, slotDelaySeconds(row.slot.at, now));
          return 'requeued' as const;
        }
        await applyDueSchedule(tx, page.appId, page.key, row, now);
        return 'applied' as const;
      });
      if (outcome !== 'none') {
        deps.logger.info(
          {
            event: 'page_schedule_due',
            queue: PAGE_SCHEDULE_QUEUE,
            job: PAGE_SCHEDULE_JOB,
            app_id: page.appId,
            page_key: page.key,
            outcome,
          },
          'page schedule job handled',
        );
      }
    },
  };
}
