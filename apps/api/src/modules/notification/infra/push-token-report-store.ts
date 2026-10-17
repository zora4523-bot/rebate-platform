import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { newUuidV7 } from '../../platform/index.ts';
import type { PushTokenReport } from '../application/push-token-report-types.ts';

interface Conflict {
  readonly deviceId: string;
  readonly outcome: 'moved' | 'refused' | 'frozen' | 'already_frozen';
}

function uniqueConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    (error.constraint === 'push_tokens_live_token_key' ||
      error.constraint === 'push_tokens_device_provider_key')
  );
}

/** Device lock survives retries; all token locks and changes are inside the savepoint. */
export async function reportInTransaction(
  transaction: Transaction<DB>,
  command: PushTokenReport,
  now: Date,
  windowMs: number,
): Promise<Conflict | undefined> {
  const db = transaction.withSchema('app');
  const device = await db
    .selectFrom('devices')
    .select(['last_login_sid', 'created_at'])
    .where('app_id', '=', command.app_id)
    .where('id', '=', command.device_id)
    .forUpdate()
    .executeTakeFirst();
  if (device === undefined || device.last_login_sid !== command.sid) return;

  // READ COMMITTED gives each retry a fresh view of the winner of the unique constraint race.
  // Roll back revocation as well as acquisition before re-reading, and release token locks so
  // each attempt can acquire the entire new set in id order again. Never swallow other failures.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sql`SAVEPOINT push_report_attempt`.execute(db);
    try {
      const result = await reportLocked(db, command, device.created_at, now, windowMs);
      await sql`RELEASE SAVEPOINT push_report_attempt`.execute(db);
      return result;
    } catch (error) {
      if (!uniqueConflict(error) || attempt === 2) throw error;
      await sql`ROLLBACK TO SAVEPOINT push_report_attempt`.execute(db);
      await sql`RELEASE SAVEPOINT push_report_attempt`.execute(db);
    }
  }
  throw new Error('notification: report attempts exhausted');
}

async function reportLocked(
  db: Kysely<DB>,
  command: PushTokenReport,
  registeredAt: Date,
  now: Date,
  windowMs: number,
): Promise<Conflict | undefined> {
  const rows = await db
    .selectFrom('push_tokens')
    .selectAll()
    .where('app_id', '=', command.app_id)
    .where('provider', '=', command.provider)
    .where((eb) =>
      eb.or([
        eb('device_id', '=', command.device_id),
        eb.and([eb('token', '=', command.token), eb('revoked_at', 'is', null)]),
      ]),
    )
    .orderBy('id', 'asc')
    .forUpdate()
    .execute();
  const own = rows.find((row) => row.device_id === command.device_id);
  const holder = rows.find(
    (row) =>
      row.device_id !== command.device_id && row.token === command.token && row.revoked_at === null,
  );
  if (own?.frozen_until != null && own.frozen_until > now) return;
  if (holder?.frozen_until != null && holder.frozen_until > now) {
    return { deviceId: holder.device_id, outcome: 'already_frozen' };
  }

  if (holder !== undefined) {
    // Only immutable registration metadata is read on the other device: taking its lock here
    // would invert the device-before-token lock order against that device's login/report.
    const other = await db
      .selectFrom('devices')
      .select('created_at')
      .where('app_id', '=', command.app_id)
      .where('id', '=', holder.device_id)
      .executeTakeFirstOrThrow();
    if (registeredAt > other.created_at) {
      if (
        holder.acquired_by_move_at !== null &&
        holder.acquired_by_move_at.getTime() > now.getTime() - windowMs
      ) {
        const until = structuredClone(now);
        until.setTime(now.getTime() + windowMs);
        await db
          .updateTable('push_tokens')
          .set((eb) => ({
            frozen_until: until,
            user_id: null,
            bound_sid: null,
            updated_at: now,
            row_version: eb('row_version', '+', 1),
          }))
          .where('app_id', '=', command.app_id)
          .where('id', '=', holder.id)
          .execute();
        return { deviceId: holder.device_id, outcome: 'frozen' };
      }
    } else {
      // Equal registration instants grant no later-device privilege: require a new login too.
      const session = await db
        .selectFrom('sessions')
        .select('created_at')
        .where('app_id', '=', command.app_id)
        .where('sid', '=', command.sid)
        .where('device_id', '=', command.device_id)
        .where('user_id', '=', command.user_id)
        .executeTakeFirst();
      if (session === undefined || session.created_at <= holder.token_set_at) {
        return { deviceId: holder.device_id, outcome: 'refused' };
      }
    }
    await db
      .updateTable('push_tokens')
      .set((eb) => ({
        revoked_at: now,
        user_id: null,
        bound_sid: null,
        updated_at: now,
        row_version: eb('row_version', '+', 1),
      }))
      .where('app_id', '=', command.app_id)
      .where('id', '=', holder.id)
      .execute();
  }

  const unchanged = holder === undefined && own?.token === command.token && own.revoked_at === null;
  const values = {
    token: command.token,
    user_id: command.user_id,
    bound_sid: command.sid,
    token_set_at: unchanged ? own.token_set_at : now,
    acquired_by_move_at: holder !== undefined ? now : unchanged ? own.acquired_by_move_at : null,
    frozen_until: null,
    revoked_at: null,
    updated_at: now,
  };
  if (own === undefined) {
    await db
      .insertInto('push_tokens')
      .values({
        ...values,
        id: newUuidV7(now),
        app_id: command.app_id,
        device_id: command.device_id,
        provider: command.provider,
        created_at: now,
      })
      .execute();
  } else {
    await db
      .updateTable('push_tokens')
      .set((eb) => ({ ...values, row_version: eb('row_version', '+', 1) }))
      .where('app_id', '=', command.app_id)
      .where('id', '=', own.id)
      .execute();
  }
  return holder === undefined ? undefined : { deviceId: holder.device_id, outcome: 'moved' };
}
