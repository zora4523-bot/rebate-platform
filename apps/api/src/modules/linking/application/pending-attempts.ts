// B1-08m: linking's port over the open attempts (link_open_attempts, BR-ATTR-21 ①) for orders'
// pending-track cards. linking owns link_open_attempts, links, link_logs and union_bindings, so
// orders reads and writes them only through this port (orders/AGENTS.md rule 8).
// - listForUser: the user's own attempts of one app opened at or after `since` (inclusive), each
//   with its link's platform and the facts of the same successful open: the open log of that
//   attempt (same app, link and opener, created_at = opened_at, result_code 0, event open |
//   convert) gives pid_scene, no_rebate and no_rebate_reason. No such log → no_rebate=false,
//   reason null and the link's pid_scene. authorized_after: the user's binding of that platform is
//   active now and was bound at or after the open (Taobao: with a usable relation_id, as the open
//   uses it; Pinduoduo: the active authorization); anything else, other platforms included, is
//   false (the claim entry stays hidden when unsure).
// - dismiss: writes dismissed_at (and updated_at, row_version + 1) once on the attempt that is the
//   caller's, of this app and of this link. Already dismissed within that same scope → true,
//   nothing changed; absent, someone else's, another app's or another link's → false, nothing
//   written. Ids that are not UUIDs are absent (never a PG 22P02).
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export interface PendingAttempt {
  attempt_id: string;
  link_id: string;
  platform: Schema<'PlatformCode'>;
  pid_scene: string | null;
  opened_at: Date;
  jump_reported_at: Date | null;
  dismissed_at: Date | null;
  no_rebate: boolean;
  no_rebate_reason: string | null;
  authorized_after: boolean;
}

export interface PendingAttemptScope {
  app_id: string;
  user_id: string;
}

export interface PendingAttemptStore {
  listForUser(input: PendingAttemptScope & { since: Date }): Promise<PendingAttempt[]>;
  /** False means absent or outside the caller's scope; already dismissed is true. */
  dismiss(
    input: PendingAttemptScope & { link_id: string; attempt_id: string; at: Date },
  ): Promise<boolean>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** contracts BaichuanTaoke.relation_id bound (link-open-taobao.ts RELATION_MAX). */
const RELATION_MAX = 32;

export function createPendingAttemptStore(db: Kysely<DB>): PendingAttemptStore {
  // The handle is touched on first use only: module startup never needs the database.
  const app = () => db.withSchema('app');

  return {
    async listForUser({ app_id, user_id, since }) {
      if (!UUID.test(user_id)) return [];
      const rows = await app()
        .selectFrom('link_open_attempts as a')
        .innerJoin('links as l', (join) =>
          join.onRef('l.app_id', '=', 'a.app_id').onRef('l.link_id', '=', 'a.link_id'),
        )
        .leftJoinLateral(
          (eb) =>
            eb
              .selectFrom('link_logs as g')
              .select(['g.pid_scene', 'g.no_rebate', 'g.no_rebate_reason'])
              .whereRef('g.app_id', '=', 'a.app_id')
              .whereRef('g.link_id', '=', 'a.link_id')
              .whereRef('g.opener_user_id', '=', 'a.user_id')
              .whereRef('g.created_at', '=', 'a.opened_at')
              .where('g.result_code', '=', 0)
              .where('g.event', 'in', ['open', 'convert'])
              .orderBy('g.id', 'desc')
              .limit(1)
              .as('g'),
          (join) => join.onTrue(),
        )
        .select((eb) => [
          'a.attempt_id',
          'a.link_id',
          'l.platform',
          'l.pid_scene as link_pid_scene',
          'g.pid_scene as log_pid_scene',
          'g.no_rebate',
          'g.no_rebate_reason',
          'a.opened_at',
          'a.jump_reported_at',
          'a.dismissed_at',
          eb
            .exists(
              eb
                .selectFrom('union_bindings as b')
                .select(sql<number>`1`.as('one'))
                .whereRef('b.app_id', '=', 'a.app_id')
                .whereRef('b.user_id', '=', 'a.user_id')
                .whereRef('b.platform', '=', 'l.platform')
                .where('b.status', '=', 'active')
                .whereRef('b.bound_at', '>=', 'a.opened_at')
                .where((w) =>
                  w.or([
                    w('b.platform', '=', 'pdd'),
                    w.and([
                      w('b.platform', '=', 'taobao'),
                      w('b.relation_id', 'is not', null),
                      w('b.relation_id', '<>', ''),
                      w(sql<number>`char_length(${sql.ref('b.relation_id')})`, '<=', RELATION_MAX),
                    ]),
                  ]),
                ),
            )
            .as('authorized_after'),
        ])
        .where('a.app_id', '=', app_id)
        .where('a.user_id', '=', user_id)
        .where('a.opened_at', '>=', since)
        .orderBy('a.opened_at', 'asc')
        .orderBy('a.attempt_id', 'asc')
        .execute();
      return rows.map((row) => {
        const logged = row.no_rebate !== null;
        return {
          attempt_id: row.attempt_id,
          link_id: row.link_id,
          platform: row.platform as Schema<'PlatformCode'>,
          pid_scene: row.log_pid_scene ?? row.link_pid_scene,
          opened_at: row.opened_at,
          jump_reported_at: row.jump_reported_at,
          dismissed_at: row.dismissed_at,
          no_rebate: row.no_rebate === true,
          no_rebate_reason: logged ? row.no_rebate_reason : null,
          authorized_after: row.authorized_after === true,
        };
      });
    },

    async dismiss({ app_id, user_id, link_id, attempt_id, at }) {
      if (!UUID.test(attempt_id) || !UUID.test(link_id) || !UUID.test(user_id)) return false;
      const updated = await app()
        .updateTable('link_open_attempts')
        .set({ dismissed_at: at, updated_at: at, row_version: sql<number>`row_version + 1` })
        .where('attempt_id', '=', attempt_id)
        .where('app_id', '=', app_id)
        .where('user_id', '=', user_id)
        .where('link_id', '=', link_id)
        .where('dismissed_at', 'is', null)
        .executeTakeFirst();
      if (updated.numUpdatedRows > 0n) return true;
      // Nothing written: already dismissed within this same scope is the idempotent success.
      const existing = await app()
        .selectFrom('link_open_attempts')
        .select('dismissed_at')
        .where('attempt_id', '=', attempt_id)
        .where('app_id', '=', app_id)
        .where('user_id', '=', user_id)
        .where('link_id', '=', link_id)
        .executeTakeFirst();
      return existing !== undefined && existing.dismissed_at !== null;
    },
  };
}
