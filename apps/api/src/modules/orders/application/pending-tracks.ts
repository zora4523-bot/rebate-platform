// B1-08m: the shared pending-track queries behind GET /v1/orders/pending-tracks and POST
// /v1/orders/pending-tracks/{link_id}/dismiss (BR-ATTR-21). The subject is the token principal
// only (BR-AI-03). Open attempts, links and open logs belong to linking and are read and written
// only through its PendingAttemptStore; this module reads its own orders table (app_id, user_id
// of the subject, link_id among the attempts' links) and writes nothing. Every decision is the
// pure selectPendingTracks at the injected Clock's now.
// - list: attempts opened within the last 72 hours (since = now − 72 h, inclusive); the
//   completion tolerance is attr.track_complete_tolerance_sec of the subject's app (a whole number
//   of seconds ≥ 0; absent or anything else → 120).
// - dismiss: the attempt of the body, the link of the path, the subject's app and user; written
//   once at Clock now. Not found in that scope → PendingTrackError(['attempt_id']) (20001, 04 §6.4).
// Without a database the base class fails closed on first use; module startup never touches it.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { PendingAttemptStore } from '../../linking/index.ts';
import type { Clock } from '../../platform/index.ts';
import { PENDING_TRACK_LIFETIME_MS, selectPendingTracks } from '../domain/pending-tracks.ts';
import type { OrderSubject } from './order-queries.ts';

export interface PendingTracksDeps {
  db: Kysely<DB>;
  clock: Clock;
  config: ContentReader;
  attempts: PendingAttemptStore;
}

/** A dismissal outside the caller's attempts (04 §6.4): the HTTP layer answers 20001. */
export class PendingTrackError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(`orders: invalid ${fields.join(', ')}`);
    this.name = 'PendingTrackError';
    this.fields = fields;
  }
}

export const TRACK_COMPLETE_TOLERANCE_KEY = 'attr.track_complete_tolerance_sec';
/** BR-ATTR-21 细则「完成」: the default completion tolerance in seconds. */
export const DEFAULT_TRACK_COMPLETE_TOLERANCE_SEC = 120;

/** The instant `deltaMs` from `from`, derived without reading the system clock. */
function shifted(from: Date, deltaMs: number): Date {
  const date = structuredClone(from);
  date.setTime(from.getTime() + deltaMs);
  return date;
}

/** Class token of the shared provider (HTTP; later the agent tools). */
export class PendingTracks {
  list(subject: OrderSubject): Promise<Schema<'PendingTracksData'>> {
    void subject;
    return Promise.reject(new Error('orders: pending tracks need the database'));
  }

  /** Resolves once the attempt is dismissed (now or before); rejects with PendingTrackError. */
  dismiss(subject: OrderSubject, linkId: string, attemptId: string): Promise<void> {
    void subject;
    void linkId;
    void attemptId;
    return Promise.reject(new Error('orders: pending tracks need the database'));
  }
}

class DbPendingTracks extends PendingTracks {
  readonly #deps: PendingTracksDeps;

  constructor(deps: PendingTracksDeps) {
    super();
    this.#deps = deps;
  }

  override async list(subject: OrderSubject): Promise<Schema<'PendingTracksData'>> {
    const { db, clock, attempts } = this.#deps;
    const now = clock.now();
    const since = shifted(now, -PENDING_TRACK_LIFETIME_MS);
    const rows = await attempts.listForUser({
      app_id: subject.app_id,
      user_id: subject.user_id,
      since,
    });
    if (rows.length === 0) return { items: [] };
    const toleranceSec = await this.#toleranceSec(subject.app_id);
    const linkIds = [...new Set(rows.map((row) => row.link_id))];
    // An order paid before since − tolerance can complete none of these attempts.
    const orders = await db
      .withSchema('app')
      .selectFrom('orders')
      .select(['link_id', 'attr_at', 'source_match'])
      .where('app_id', '=', subject.app_id)
      .where('user_id', '=', subject.user_id)
      .where('link_id', 'in', linkIds)
      .where('source_match', 'is not', null)
      .where('source_match', '<>', 'none')
      .where('attr_at', '>=', shifted(since, -toleranceSec * 1000))
      .execute();
    return { items: selectPendingTracks({ now, toleranceSec, attempts: rows, orders }) };
  }

  override async dismiss(subject: OrderSubject, linkId: string, attemptId: string): Promise<void> {
    const { clock, attempts } = this.#deps;
    const dismissed = await attempts.dismiss({
      app_id: subject.app_id,
      user_id: subject.user_id,
      link_id: linkId,
      attempt_id: attemptId,
      at: clock.now(),
    });
    if (!dismissed) throw new PendingTrackError(['attempt_id']);
  }

  async #toleranceSec(appId: string): Promise<number> {
    const entry = await this.#deps.config.configValue(appId, TRACK_COMPLETE_TOLERANCE_KEY);
    const value = entry?.value;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value
      : DEFAULT_TRACK_COMPLETE_TOLERANCE_SEC;
  }
}

export function createPendingTracks(deps: PendingTracksDeps): PendingTracks {
  return new DbPendingTracks(deps);
}
