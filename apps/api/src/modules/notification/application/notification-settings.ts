// B1-12m: the caller's push switches per message category (BR-WATCH-19 ③; contract
// getNotificationSettings / updateNotificationSettings). notification is the only writer of
// app.notification_settings.
//
// - get: one SELECT scoped by app_id and user_id; an account that never saved reads all three as
//   true and nothing is inserted (works on the read-only role too).
// - update: full replacement in one statement, INSERT ... ON CONFLICT (app_id, user_id) DO UPDATE
//   ... RETURNING. A first save inserts (row_version from the table default 0, created_at =
//   updated_at = the injected Clock); a later save replaces the three switches, increments
//   row_version and sets updated_at, created_at stays. Two concurrent first saves never surface a
//   23505: PostgreSQL turns the losing insert into the update. The answer is the row as saved.
// - Switches only affect push (BR-WATCH-15): in-app messages are written regardless; suppression
//   belongs to the sending chain, not to this file.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface NotificationSettingsOwner {
  readonly app_id: string;
  readonly user_id: string;
}

export interface NotificationSettingsService {
  get(owner: NotificationSettingsOwner): Promise<Schema<'NotificationSettings'>>;
  update(
    owner: NotificationSettingsOwner,
    settings: Schema<'NotificationSettings'>,
  ): Promise<Schema<'NotificationSettings'>>;
}

export interface NotificationSettingsOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}

type Settings = Schema<'NotificationSettings'>;

/** Contract: an account that never saved settings gets all three switches on. */
const DEFAULTS: Settings = { service_push: true, subscription_push: true, marketing_push: true };

const COLUMNS = ['service_push', 'subscription_push', 'marketing_push'] as const;

function pick(row: Settings): Settings {
  return {
    service_push: row.service_push,
    subscription_push: row.subscription_push,
    marketing_push: row.marketing_push,
  };
}

export function createNotificationSettings(
  options: NotificationSettingsOptions,
): NotificationSettingsService {
  const db = options.db.withSchema('app');
  const { clock } = options;
  return {
    async get(owner) {
      const row = await db
        .selectFrom('notification_settings')
        .select(COLUMNS)
        .where('app_id', '=', owner.app_id)
        .where('user_id', '=', owner.user_id)
        .executeTakeFirst();
      return row === undefined ? { ...DEFAULTS } : pick(row);
    },

    async update(owner, settings) {
      const switches = pick(settings);
      const now = clock.now();
      const row = await db
        .insertInto('notification_settings')
        .values({
          app_id: owner.app_id,
          user_id: owner.user_id,
          ...switches,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(['app_id', 'user_id']).doUpdateSet({
            ...switches,
            row_version: sql<number>`notification_settings.row_version + 1`,
            updated_at: now,
          }),
        )
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return pick(row);
    },
  };
}
