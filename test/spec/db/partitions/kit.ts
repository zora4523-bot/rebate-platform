// Shared helpers of the B1-01j partition-maintenance rule tests (contract: the header of
// apps/api/src/modules/platform/maintenance/index.ts, section A). Every connection is a business
// role of the test database (couli_maint, couli_app, couli_payout, couli_readonly), never a
// superuser (ADR-0001 §4.2 #9). Expected values are written out by hand from the contract.
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

/** The part of `TestDatabase` (@couli/db/testing) these helpers use. */
export interface Database {
  urlFor(role: 'couli_app' | 'couli_payout' | 'couli_readonly' | 'couli_maint'): string;
  drop(): Promise<void>;
}

export const PERMISSION_DENIED = '42501';

/** How a statement ended: `ok`, or `<SQLSTATE> <message>` of the database error. */
export async function outcome(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code !== 'string') return `not a database error: ${String(error)}`;
    return `${code} ${String(message)}`;
  }
}

/** The SQLSTATE of the rejection, or 'ok'. */
export async function sqlState(run: Promise<unknown>): Promise<string> {
  return (await outcome(run)).split(' ')[0] ?? '';
}

/** Connections of the four business roles on one database. */
export interface Roles {
  readonly maint: Kysely<DB>;
  readonly app: Kysely<DB>;
  readonly payout: Kysely<DB>;
  readonly readonly: Kysely<DB>;
}

export function connect(database: Database): Roles {
  return {
    maint: createDb({ connectionString: database.urlFor('couli_maint'), max: 2 }),
    app: createDb({ connectionString: database.urlFor('couli_app'), max: 2 }),
    payout: createDb({ connectionString: database.urlFor('couli_payout'), max: 1 }),
    readonly: createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 }),
  };
}

export async function disconnect(roles: Roles): Promise<void> {
  await Promise.all(
    [roles.maint, roles.app, roles.payout, roles.readonly].map((db) =>
      destroyDb(db).catch(() => undefined),
    ),
  );
}

/** app.ensure_month_partition for each 'YYYY-MM' of `months`, as `db` (couli_maint). */
export async function ensureMonths(
  db: Kysely<DB>,
  table: string,
  months: readonly string[],
): Promise<string[]> {
  const names: string[] = [];
  for (const month of months) {
    const result = await sql<{ name: string }>`
      SELECT app.ensure_month_partition(${table}, ${`${month}-01`}::date) AS name
    `.execute(db);
    names.push(result.rows[0]?.name ?? '');
  }
  return names;
}

/** 'YYYY-MM' of every month from `first` to `last`, inclusive. */
export function monthRange(first: string, last: string): string[] {
  const out: string[] = [];
  let year = Number(first.slice(0, 4));
  let month = Number(first.slice(5, 7));
  const end = Number(last.slice(0, 4)) * 12 + Number(last.slice(5, 7));
  while (year * 12 + month <= end) {
    out.push(`${String(year)}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/** app.drop_expired_month_partitions(p_table, p_now) as `db`; p_now is passed as ISO text. */
export async function dropExpired(
  db: Kysely<DB>,
  table: string | null,
  now: string | null,
): Promise<string[]> {
  const result = await sql<{ names: string[] | null }>`
    SELECT app.drop_expired_month_partitions(${table}::text, ${now}::timestamptz) AS names
  `.execute(db);
  const names = result.rows[0]?.names;
  if (names === undefined) throw new Error('no row');
  if (names === null) throw new Error('NULL result');
  return names;
}

/** dropExpired, or `failed <SQLSTATE>` when the call is rejected (so a scenario fails on its assertion). */
export async function dropped(
  db: Kysely<DB>,
  table: string,
  now: string,
): Promise<string[] | string> {
  try {
    return await dropExpired(db, table, now);
  } catch (error) {
    return `failed ${String((error as { code?: unknown }).code ?? error)}`;
  }
}

/**
 * Children of app.<table> with their bounds, ordered by name. The bounds are rendered under TIME
 * ZONE 'UTC' in the same transaction, so the text does not depend on the database default.
 */
export async function partitionsOf(
  db: Kysely<DB>,
  table: string,
): Promise<Array<{ name: string; bound: string }>> {
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL TIME ZONE 'UTC'`.execute(trx);
    const rows = await sql<{ name: string; bound: string }>`
      SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
      FROM pg_inherits i
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = 'app' AND p.relname = ${table}
      ORDER BY c.relname COLLATE "C"
    `.execute(trx);
    return rows.rows.map((row) => ({ name: row.name, bound: row.bound }));
  });
}

/** Names of the children of app.<table>, ordered. */
export async function partitionNames(db: Kysely<DB>, table: string): Promise<string[]> {
  return (await partitionsOf(db, table)).map((p) => p.name);
}

/** The bound text of the month partition of 'YYYY-MM' (UTC month boundaries). */
export function monthBound(month: string): string {
  const [next] = monthRange(month, '9999-12').slice(1, 2);
  return `FOR VALUES FROM ('${month}-01 00:00:00+00') TO ('${next ?? ''}-01 00:00:00+00')`;
}

/** `<table>_pYYYYMM` for each 'YYYY-MM'. */
export function names(table: string, months: readonly string[]): string[] {
  return months.map((m) => `${table}_p${m.slice(0, 4)}${m.slice(5, 7)}`);
}

let seq = 0;

/** Inserts `count` event_log rows as couli_app; returns the partitions they landed in. */
export async function insertEvents(
  app: Kysely<DB>,
  occurredAt: string,
  count: number,
  payload: Record<string, unknown> = { order_id: 'x' },
): Promise<string[]> {
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    seq += 1;
    const id = `00000000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
    const result = await sql<{ part: string }>`
      INSERT INTO app.event_log (app_id, event_id, name, payload, occurred_at)
      VALUES ('couli', ${id}::uuid, 'order.created', ${JSON.stringify(payload)}::jsonb,
              ${occurredAt}::timestamptz)
      RETURNING tableoid::regclass::text AS part
    `.execute(app);
    parts.push(result.rows[0]?.part ?? '');
  }
  return parts;
}
