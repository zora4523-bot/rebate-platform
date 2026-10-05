// Helpers of the B1-01s day-partition rule tests (contract: section I1 of
// apps/api/src/modules/platform/maintenance/index.ts). Every helper that calls a new function
// reports a rejection as a value (`failed <SQLSTATE>`) instead of throwing, so that a scenario on a
// database without the migration fails on its assertions. Expected values are written out by hand.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

/** 'YYYY-MM-DD' of every calendar day from `first` to `last`, inclusive. */
export function dayRange(first: string, last: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${last}T00:00:00Z`);
  for (let t = Date.parse(`${first}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** The calendar day before 'YYYY-MM-DD'. */
export function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** `<table>_pYYYYMMDD` for each 'YYYY-MM-DD'. */
export function dayNames(table: string, days: readonly string[]): string[] {
  return days.map((d) => `${table}_p${d.replaceAll('-', '')}`);
}

/** The bound text, rendered under TimeZone UTC, of the partition of +08:00 day 'YYYY-MM-DD'. */
export function dayBound(day: string): string {
  return `FOR VALUES FROM ('${dayBefore(day)} 16:00:00+00') TO ('${day} 16:00:00+00')`;
}

/** The error of a rejection as `failed <SQLSTATE>`. */
function failed(error: unknown): string {
  return `failed ${String((error as { code?: unknown }).code ?? error)}`;
}

/** app.ensure_day_partition(table, day) for each day, as `db`; each entry the name or `failed <code>`. */
export async function ensureDays(
  db: Kysely<DB>,
  table: string,
  days: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const day of days) {
    try {
      const result = await sql<{ name: string | null }>`
        SELECT app.ensure_day_partition(${table}::text, ${day}::date) AS name
      `.execute(db);
      out.push(result.rows[0]?.name ?? 'NULL result');
    } catch (error) {
      out.push(failed(error));
    }
  }
  return out;
}

/** app.drop_expired_day_partitions(table, now) as `db` (now as ISO text); `failed <code>` on rejection. */
export async function dropDays(
  db: Kysely<DB>,
  table: string,
  now: string,
): Promise<string[] | string> {
  try {
    const result = await sql<{ names: string[] | null }>`
      SELECT app.drop_expired_day_partitions(${table}::text, ${now}::timestamptz) AS names
    `.execute(db);
    const names = result.rows[0]?.names;
    if (names === undefined) return 'no row';
    if (names === null) return 'NULL result';
    return names;
  } catch (error) {
    return failed(error);
  }
}

let seq = 0;

/** Inserts one link_logs row created at `createdAt` as couli_app; returns its partition or `failed <code>`. */
export async function insertLinkLog(app: Kysely<DB>, createdAt: string): Promise<string> {
  seq += 1;
  try {
    const result = await sql<{ part: string }>`
      INSERT INTO app.link_logs (app_id, event, result_code, raw_item_id, created_at)
      VALUES ('couli', 'convert', 0, ${`item-${String(seq)}`}, ${createdAt}::timestamptz)
      RETURNING tableoid::regclass::text AS part
    `.execute(app);
    return result.rows[0]?.part ?? 'no row';
  } catch (error) {
    return failed(error);
  }
}

/** created_at of every link_logs row with its partition, ordered by created_at. */
export async function linkLogRows(app: Kysely<DB>): Promise<Array<{ part: string; at: string }>> {
  const result = await sql<{ part: string; at: string }>`
    SELECT tableoid::regclass::text AS part,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
    FROM app.link_logs ORDER BY created_at, id
  `.execute(app);
  return result.rows.map((r) => ({ part: r.part, at: r.at }));
}
