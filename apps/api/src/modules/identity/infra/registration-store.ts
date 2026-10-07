// app.users and app.device_registrations at account creation, written only by identity (规划/02
// §4.1; 04 §3.2). Every function runs in the caller's transaction; nothing here commits.
//
// Savepoints: PostgreSQL voids the whole transaction on a failed statement (a unique violation
// included), so every write that may fail runs after a savepoint and a failure rolls back to it
// (BR-INV-01 细则). Names are fixed identifiers of this file, never input.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
import type { DeviceRegistrationRecord } from '../domain/registration.ts';

export type Savepoint =
  | 'identity_registration'
  | 'identity_registration_user'
  | 'identity_registration_invite_bind'
  | 'identity_registration_after';

export async function savepoint(trx: Transaction<DB>, name: Savepoint): Promise<void> {
  await sql`SAVEPOINT ${sql.raw(name)}`.execute(trx);
}

export async function releaseSavepoint(trx: Transaction<DB>, name: Savepoint): Promise<void> {
  await sql`RELEASE SAVEPOINT ${sql.raw(name)}`.execute(trx);
}

/** Undoes everything since the savepoint (later savepoints included) and drops it. */
export async function rollbackToSavepoint(trx: Transaction<DB>, name: Savepoint): Promise<void> {
  await sql`ROLLBACK TO SAVEPOINT ${sql.raw(name)}`.execute(trx);
  await sql`RELEASE SAVEPOINT ${sql.raw(name)}`.execute(trx);
}

/**
 * Transaction-level lock of one (app_id, device_hash): the same-device count and the account
 * creation run under it (BR-ID-05 细则「并发」: lock, then count, then create). A transaction-level
 * advisory lock is not tied to the savepoint it was taken after: neither RELEASE nor ROLLBACK TO
 * SAVEPOINT frees it, so it is held until the caller's whole transaction commits or rolls back,
 * also when this service answers 44001, 50001 or phone_taken. Another device is never blocked by
 * it. The key space is the 64-bit hash of a name prefixed by this module.
 */
export async function lockDeviceRegistrations(
  trx: Transaction<DB>,
  appId: string,
  deviceHash: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity.device_registrations:${appId}:${deviceHash}`}, 0))`.execute(
    trx,
  );
}

/**
 * The isolation level of the caller's transaction (PostgreSQL's transaction_isolation setting,
 * e.g. 'read committed'). The count after the device lock is correct only when each statement
 * takes a fresh snapshot (READ COMMITTED); the service refuses the snapshot levels before
 * locking, like the guard of migration 0011.
 */
export async function transactionIsolation(trx: Transaction<DB>): Promise<string> {
  const { rows } = await sql<{
    isolation: string;
  }>`SELECT current_setting('transaction_isolation') AS isolation`.execute(trx);
  const isolation = rows[0]?.isolation;
  if (typeof isolation !== 'string') throw new Error('registration: transaction_isolation unread');
  return isolation;
}

/**
 * Whether an account not deleted already holds this phone blind index in the app (the partial
 * unique index (app_id, phone_hmac) WHERE status <> 'deleted' of app.users).
 */
export async function phoneHeld(
  trx: Transaction<DB>,
  appId: string,
  phoneHmac: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('users')
    .select('id')
    .where('app_id', '=', appId)
    .where('phone_hmac', '=', phoneHmac)
    .where('status', '<>', 'deleted')
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * The device's registration records with created_at in (now − windowMs, ∞): a fresh statement,
 * so under READ COMMITTED it sees every registration committed before the lock was granted.
 */
export async function deviceRegistrationsSince(
  trx: Transaction<DB>,
  appId: string,
  deviceHash: string,
  now: Date,
  windowMs: number,
): Promise<DeviceRegistrationRecord[]> {
  return trx
    .selectFrom('device_registrations')
    .select(['app_id', 'device_hash', 'user_id', 'created_at', 'merged_into_user_id'])
    .where('app_id', '=', appId)
    .where('device_hash', '=', deviceHash)
    .where(
      'created_at',
      '>',
      sql<Date>`${now}::timestamptz - ${windowMs}::float8 * interval '1 millisecond'`,
    )
    .execute();
}

export interface NewUser {
  readonly id: string;
  readonly appId: string;
  /** UTF-8 bytes of the field-encryption ciphertext of the normalised phone (null: no phone). */
  readonly phoneCipher: Buffer | null;
  readonly phoneHmac: string | null;
  readonly nickname: string;
  readonly avatar: string;
  readonly inviteCode: string;
  readonly attrCode: string;
  readonly level: string;
  readonly registerMethod: string;
  readonly registeredChannel: string | null;
  /** From the injected Clock: created_at and updated_at. */
  readonly now: Date;
}

export type InsertUserOutcome =
  'inserted' | 'invite_code_taken' | 'attr_code_taken' | 'phone_taken';

const UNIQUE_VIOLATION = '23505';
/** Unique constraints of app.users (db/schema.sql) and what a violation of each means here. */
const USER_UNIQUE_CONSTRAINTS: ReadonlyMap<
  string,
  Exclude<InsertUserOutcome, 'inserted'>
> = new Map([
  ['users_invite_code_key', 'invite_code_taken'],
  ['users_attr_code_key', 'attr_code_taken'],
  // Partial index (app_id, phone_hmac) WHERE status <> 'deleted'.
  ['users_phone_hmac_key', 'phone_taken'],
]);

function uniqueConstraint(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && typeof constraint === 'string' ? constraint : undefined;
}

/**
 * Inserts the users row in its own savepoint. A violation of the invite-code, attr-code or phone
 * uniqueness rolls back to that savepoint and is answered as such, leaving the transaction usable;
 * any other error rejects as it is (the caller rolls back further).
 */
export async function insertUser(trx: Transaction<DB>, user: NewUser): Promise<InsertUserOutcome> {
  await savepoint(trx, 'identity_registration_user');
  try {
    await trx
      .insertInto('users')
      .values({
        id: user.id,
        app_id: user.appId,
        phone_cipher: user.phoneCipher,
        phone_hmac: user.phoneHmac,
        nickname: user.nickname,
        avatar: user.avatar,
        invite_code: user.inviteCode,
        attr_code: user.attrCode,
        level: user.level,
        register_method: user.registerMethod,
        registered_channel: user.registeredChannel,
        created_at: user.now,
        updated_at: user.now,
      })
      .execute();
  } catch (error) {
    const constraint = uniqueConstraint(error);
    const outcome = constraint === undefined ? undefined : USER_UNIQUE_CONSTRAINTS.get(constraint);
    if (outcome === undefined) throw error;
    await rollbackToSavepoint(trx, 'identity_registration_user');
    return outcome;
  }
  await releaseSavepoint(trx, 'identity_registration_user');
  return 'inserted';
}

/**
 * The registration source record of an account created on a device (BR-ID-05 细则). created_at is
 * the injected Clock's instant of this creation — the same value the same-device window was
 * computed from — so the count and the record share one time base even when the Clock leads the
 * database (staging CLOCK_NOW); couli_app's INSERT grant on created_at comes from migration 0019.
 * merged_into_user_id keeps its database default (NULL; only the merge transaction writes it).
 */
export async function insertDeviceRegistration(
  trx: Transaction<DB>,
  record: {
    readonly appId: string;
    readonly deviceHash: string;
    readonly userId: string;
    readonly registerMethod: string;
    /** The Clock instant this creation was decided at. */
    readonly createdAt: Date;
  },
): Promise<void> {
  await trx
    .insertInto('device_registrations')
    .values({
      app_id: record.appId,
      device_hash: record.deviceHash,
      user_id: record.userId,
      register_method: record.registerMethod,
      created_at: record.createdAt,
    })
    .execute();
}
