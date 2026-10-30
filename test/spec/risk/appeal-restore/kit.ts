// Shared values of the B1-03z rule tests (申诉恢复差错单生产者: 08 BR-FUND-22, BR-CALC-13 细则「申诉恢复」,
// 拍板第二批 FUND-14; BR-ID-36 结案撤销; contracts AdminReconDiff). Every expected value is written
// out by hand from the task brief, the contracts and db/schema.sql, never read from the
// implementation. Nothing here imports the test-database base (`@couli/db/testing`).
import { randomUUID } from 'node:crypto';
import type {
  ReceivedEvent,
  ReceivedJob,
} from '../../../../apps/api/src/modules/platform/index.ts';

/** Consumer of EVENT_SUBSCRIPTIONS (task brief 9.2 ①) and its event queue `evt.<consumer>`. */
export const CONSUMER = 'risk-appeal-restore';
export const QUEUE = 'evt.risk-appeal-restore';

/** The handler's clock: after the appeal was closed. */
export const NOW = '2026-09-25T02:00:00.000Z';

// Timeline of one ban (UTC). The ban's penalty starts at PENALTY_AT, the appeal is filed at
// APPEAL_AT and closed (revoked) at CLOSED_AT; 「本次封禁」 is [PENALTY_AT, CLOSED_AT].
/** Orders and their snapshot (initial active share events). */
export const ORDER_AT = new Date('2026-08-20T00:00:00.000Z');
/** A forfeiture of an earlier ban cycle, before this penalty began. */
export const EARLIER_BAN_AT = new Date('2026-09-01T00:00:00.000Z');
export const PENALTY_AT = new Date('2026-09-10T00:00:00.000Z');
export const IN_BAN_1 = new Date('2026-09-12T00:00:00.000Z');
export const IN_BAN_2 = new Date('2026-09-15T00:00:00.000Z');
export const APPEAL_AT = new Date('2026-09-20T00:00:00.000Z');
export const DEADLINE_AT = new Date('2026-10-20T00:00:00.000Z');
export const CLOSED_AT = new Date('2026-09-25T01:00:00.000Z');
/** A forfeiture of a later ban cycle, after the appeal was closed. */
export const LATER_BAN_AT = new Date('2026-09-28T00:00:00.000Z');

/** recon_diffs_period_check: YYYY-MM or YYYY-MM-DD. */
export const PERIOD = /^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$/;
/** Sources of AdminReconDiff (R1, R2, R3; R4 is payment's). */
export const RESTORE_SOURCES: readonly string[] = ['R1', 'R2', 'R3'];

export type ShareRole = 'self' | 'share' | 'direct' | 'indirect';

/** appeal.resolved data as adminResolveAppeal queues it (04; B1-12p adds need_reauth). */
export type AppealResolvedData = {
  app_id: string;
  appeal_id: string;
  user_id: string | null;
  target_type: 'account' | 'order' | 'blocked_request';
  target_id: string;
  status: 'revoked' | 'upheld';
  need_reauth: boolean;
};

export function resolvedEvent(data: AppealResolvedData, eventId = randomUUID()): ReceivedEvent {
  return {
    eventId,
    appId: data.app_id,
    name: 'appeal.resolved',
    version: 1,
    occurredAt: CLOSED_AT.toISOString(),
    payload: data,
    consumer: CONSUMER,
    attempt: 1,
  };
}

/** The job registerEventConsumer receives for an event (platform/events section 4d). */
export function job(event: ReceivedEvent): ReceivedJob {
  return {
    id: event.eventId,
    queue: QUEUE,
    name: event.name,
    attempt: event.attempt,
    payload: {
      app_id: event.appId,
      v: event.version,
      occurred_at: event.occurredAt,
      data: event.payload,
    },
  };
}
