import { sql } from 'kysely';
import type { Selectable } from 'kysely';
import type { DB } from '@couli/db';
import { dayKeyOf, dayRange } from '../admission/index.ts';
import type { AdmissionLimits } from '../admission/index.ts';
import type { Queries } from './transaction.ts';

export type RunRow = Selectable<DB['agent_runs']>;
export type SessionRow = Selectable<DB['agent_sessions']>;

export async function readRun(q: Queries, id: string, lock = false): Promise<RunRow> {
  const rows = await q.query(sql<RunRow>`SELECT * FROM app.agent_runs WHERE id = ${id}
    ${lock ? sql`FOR UPDATE` : sql``}`);
  if (!rows[0]) throw new Error('Agent run missing');
  return rows[0];
}

export async function lockSession(q: Queries, id: string): Promise<SessionRow | undefined> {
  return (
    await q.query(sql<SessionRow>`SELECT * FROM app.agent_sessions WHERE id = ${id} FOR UPDATE`)
  )[0];
}

export function isRunning(session: SessionRow, runId: string, now: Date): boolean {
  return (
    session.run_lock_run_id === runId &&
    session.run_lock_expires_at !== null &&
    now.getTime() < session.run_lock_expires_at.getTime()
  );
}

/** Take the entire union before counting/refunding. Sort PG's signed bigint hash numerically. */
export async function lockSubjects(
  q: Queries,
  appId: string,
  subjects: readonly string[],
): Promise<void> {
  const hashes = await q.query(sql<{ hash: string }>`SELECT DISTINCT
    hashtextextended('agent.quota:' || ${appId} || ':' || key, 0)::text AS hash
    FROM unnest(${[...new Set(subjects)]}::text[]) AS t(key)`);
  const sorted = hashes
    .map(({ hash }) => BigInt(hash))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const hash of sorted)
    await q.query(sql`SELECT pg_advisory_xact_lock(${hash.toString()}::bigint)`);
}

export function subjectLimits(subjects: readonly string[], limits: AdmissionLimits): number[] {
  // The first component is the fixed member/device tag, not a user-controlled prefix.
  const first: unknown = JSON.parse(subjects[0]!);
  const member = Array.isArray(first) && first[0] === 'member';
  return member ? [limits.memberDaily] : [limits.guestDaily, limits.guestIpDaily];
}

export async function dailyUsage(
  q: Queries,
  appId: string,
  subjects: readonly string[],
  now: Date,
  excludeRun?: string,
): Promise<number[]> {
  const { start, end } = dayRange(dayKeyOf(now));
  const counts: number[] = [];
  for (const [index, subject] of subjects.entries()) {
    const column = index === 0 ? sql`quota_subjects[1]` : sql`quota_subjects[2]`;
    const rows = await q.query(sql<{ count: string }>`SELECT count(*)::text AS count
      FROM app.agent_runs WHERE app_id = ${appId} AND ${column} = ${subject}
      ${index === 1 ? sql`AND cardinality(quota_subjects) = 2` : sql``}
      AND accepted_at >= ${start} AND accepted_at < ${end}
      AND settle_result IS DISTINCT FROM 'refunded'
      ${excludeRun === undefined ? sql`` : sql`AND id <> ${excludeRun}`}`);
    counts.push(Number(rows[0]!.count));
  }
  return counts;
}

export function remaining(
  subjects: readonly string[],
  limits: AdmissionLimits,
  usage: readonly number[],
): number {
  return Math.min(
    ...subjectLimits(subjects, limits).map((limit, i) => Math.max(0, limit - usage[i]!)),
  );
}
