// app.landing_registrations (migration 0053), written only by identity's landing registration
// (task B1-11h; 08 BR-ID-32 同 IP 注册上限): one row per account the landing page created, in the
// registration's own transaction. Every function runs in the caller's transaction; nothing here
// commits.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';

/** The table as this module reads and writes it (the generated DB type follows the migration). */
interface LandingTables {
  'app.landing_registrations': {
    app_id: string;
    user_id: string;
    ip_hmac: string;
    created_at: Date;
  };
}
const TABLE = 'app.landing_registrations';

/** The count window of BR-ID-32: [now − 3600 s, now], both ends closed. */
export const LANDING_IP_WINDOW_MS = 3_600_000;

function tables(trx: Transaction<DB>): Kysely<LandingTables> {
  // Until db:snapshot regenerates the DB type with 0053, the table is typed here.
  return trx as unknown as Kysely<LandingTables>;
}

/**
 * Transaction-level lock of one (app_id, ip_hmac): the count, the account and its row are made
 * under it (lock, then count, then create), so concurrent landing registrations of one IP never
 * exceed the limit. Released when the caller's transaction ends (neither RELEASE nor ROLLBACK TO
 * SAVEPOINT frees it). The key is the 64-bit hash of a name prefixed by this table, disjoint from
 * every other advisory lock of the process.
 */
export async function lockLandingRegistrations(
  trx: Transaction<DB>,
  appId: string,
  ipHmac: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity.landing_registrations:${appId}:${ipHmac}`}, 0))`.execute(
    trx,
  );
}

/** Rows of (app_id, ip_hmac) with created_at in [now − window, now]; a fresh statement. */
export async function countLandingRegistrations(
  trx: Transaction<DB>,
  appId: string,
  ipHmac: string,
  now: Date,
): Promise<number> {
  const row = await tables(trx)
    .selectFrom(TABLE)
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('app_id', '=', appId)
    .where('ip_hmac', '=', ipHmac)
    .where(
      'created_at',
      '>=',
      sql<Date>`${now}::timestamptz - ${LANDING_IP_WINDOW_MS}::float8 * interval '1 millisecond'`,
    )
    .where('created_at', '<=', now)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** The account's row; created_at is the Clock instant the count was taken at. */
export async function insertLandingRegistration(
  trx: Transaction<DB>,
  row: {
    readonly appId: string;
    readonly userId: string;
    readonly ipHmac: string;
    readonly createdAt: Date;
  },
): Promise<void> {
  await tables(trx)
    .insertInto(TABLE)
    .values({
      app_id: row.appId,
      user_id: row.userId,
      ip_hmac: row.ipHmac,
      created_at: row.createdAt,
    })
    .execute();
}

/** The landing registration's own savepoint: everything after the SMS code check runs after it. */
const SAVEPOINT = 'identity_landing_register';

export async function landingSavepoint(trx: Transaction<DB>): Promise<void> {
  await sql`SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
}

export async function releaseLandingSavepoint(trx: Transaction<DB>): Promise<void> {
  await sql`RELEASE SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
}

/** Undoes everything since the savepoint (later savepoints included) and drops it. */
export async function rollbackLandingSavepoint(trx: Transaction<DB>): Promise<void> {
  await sql`ROLLBACK TO SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
  await sql`RELEASE SAVEPOINT ${sql.raw(SAVEPOINT)}`.execute(trx);
}
