// B2-07d rule-test kit (claude-independent, SPEC_REF 37808a50; 规划/08 BR-WDR-30 细则「开启前置检查」,
// BR-WDR-23; 编排裁定 D10-392, D10-408 ② ③; task brief §9.2): the real ReconPassedDaysPort
// (apps/api/src/modules/payout/application/recon-passed-days.ts createReconPassedDays) over
// app.payout_recon_runs on a real PostgreSQL. Readings fixed here (brief §9.2, written out):
//   - 「昨日」 is the +08:00 accounting day before the one the injected Clock's now is in. Counting
//     starts there and goes back one day at a time: the app's alipay row of that day with status
//     succeeded counts 1; partial, failed or no row stops the count.
//   - diffs > 0 on a succeeded row (差错 found) still counts (D10-408 ②).
//   - Today's row (its bill day is the day of now: no T+1 yet) is neither counted nor a break.
//   - Only the app asked about and the alipay channel (D10-408 ③; the table's CHECK admits no other
//     channel today, so the channel filter is pinned by the query test, not by rows).
//   - The answer is a non-negative integer, 0 without rows; read only, on the handle the caller
//     gives (here couli_readonly, which can neither write nor lock the table), no lock, no write.
// The port factory is called inside each test: red is the skeleton's NotImplemented.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { createReconPassedDays } from '../../../../apps/api/src/modules/payout/application/recon-passed-days.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

export const TIMEOUT = 60_000;
export const CHANNEL = 'alipay';
export type RunStatus = 'succeeded' | 'partial' | 'failed';
export type Connection = Kysely<DB>;

/** 2026-10-29 10:00 +08:00: today is 2026-10-29, 「昨日」 2026-10-28. */
export const NOW = '2026-10-29T02:00:00.000Z';
export const TODAY = '2026-10-29';
export const YESTERDAY = '2026-10-28';

/**
 * `count` +08:00 bill days going back from `from` (inclusive), newest first, as YYYY-MM-DD. Plain
 * calendar arithmetic on the date string (UTC noon of the date), never the code under test.
 */
export function daysBack(from: string, count: number): string[] {
  const base = Date.parse(`${from}T12:00:00.000Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(base - i * 86_400_000).toISOString().slice(0, 10),
  );
}

interface Database {
  urlFor(role: 'couli_app' | 'couli_readonly'): string;
  drop(): Promise<void>;
}

export interface Harness {
  database: Database;
  /** couli_app: seeds the rows (the worker's writer of the table). */
  app: Connection;
  /** couli_readonly: the handle the port reads on. */
  reader: Connection;
}

export async function open(create: () => Promise<Database>): Promise<Harness> {
  const database = await create();
  return {
    database,
    app: createDb({ connectionString: database.urlFor('couli_app'), max: 3 }),
    reader: createDb({ connectionString: database.urlFor('couli_readonly'), max: 3 }),
  };
}

export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await Promise.all([destroyDb(h.app), destroyDb(h.reader)]);
  await h.database.drop();
}

export function appId(): string {
  return `b207d-${randomUUID()}`;
}

export interface RunSeed {
  readonly billDate: string;
  readonly status: RunStatus;
  /** Differences found that day (default 0). */
  readonly diffs?: number;
}

/**
 * One row of app.payout_recon_runs per seed on `db` (couli_app), as the daily job leaves it (run
 * T+1 10:00 +08:00).
 */
export async function seedRuns(
  db: Connection,
  app: string,
  seeds: readonly RunSeed[],
): Promise<void> {
  for (const seed of seeds) {
    const started = new Date(Date.parse(`${seed.billDate}T02:00:00.000Z`) + 86_400_000);
    const finished = new Date(started.getTime() + 5 * 60_000);
    const diffs = seed.diffs ?? 0;
    await sql`INSERT INTO app.payout_recon_runs
        (id, app_id, channel, bill_date, status, started_at, finished_at, bill_rows, matched, diffs)
      VALUES (${randomUUID()}, ${app}, ${CHANNEL}, ${seed.billDate}::date, ${seed.status},
        ${started}, ${finished}, ${20 + diffs}, 20, ${diffs})`.execute(db);
  }
}

/** Succeeded rows for every day of `days`. */
export function succeeded(days: readonly string[], diffs = 0): RunSeed[] {
  return days.map((billDate) => ({ billDate, status: 'succeeded', diffs }));
}

/** A rerun of the day overwrites its row (the worker's column-level UPDATE). */
export async function rerun(
  db: Connection,
  app: string,
  billDate: string,
  status: RunStatus,
): Promise<void> {
  await sql`UPDATE app.payout_recon_runs SET status = ${status}
    WHERE app_id = ${app} AND channel = ${CHANNEL} AND bill_date = ${billDate}::date`.execute(db);
}

/** The port's answer for `app` with the clock at `now`, read on couli_readonly. */
export async function passedDays(h: Harness, app: string, now = NOW): Promise<number> {
  const port = createReconPassedDays({ clock: new FixedClock(now) });
  return port.passedDays(app, h.reader);
}
