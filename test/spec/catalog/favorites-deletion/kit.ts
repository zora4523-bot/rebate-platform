// B1-28f rule-test helpers: catalog's deletion cleanup port deleteFavoritesForUser (08 BR-ID-28
// 「收藏全部删除」, D10-186 ⑤; orchestrator ruling D10-311 ②; brief B.1–B.5). The port comes from the
// public catalog/index.ts; rows are seeded and read with the B1-28b favorites db-kit as couli_app.
// The database handle is always the *.int.test.ts's: this kit never imports @couli/db/testing.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { FavoritesDeletionInput } from '../../../../apps/api/src/modules/catalog/index.ts';
import type { DeletionCleanupPorts } from '../../../../apps/api/src/modules/identity/ports/deletion-cleanup.ts';
import type { Ports } from '../../identity/deletion-processing/kit.ts';
import { rowsOf, seedMany, seedOne, type FavoriteRow } from '../favorites/db-kit.ts';

/** The cleanup step's `at`: 2026-10-23 12:00 +08:00 (the identity deletion kit's NOW). */
export const CLEANUP_AT = new Date('2026-10-23T04:00:00.000Z');
const MINUTE_MS = 60_000;

export function shift(instant: Date, ms: number): Date {
  return new Date(instant.getTime() + ms);
}

export function newAppId(): string {
  return `fd_${randomBytes(6).toString('hex')}`;
}

export interface Fixture {
  readonly appId: string;
  readonly userId: string;
  /** Another user of the same app, with some of the same products. */
  readonly otherUserId: string;
  /** Another app holding favorites under the same user_id. */
  readonly otherAppId: string;
  /** The port input for the user in appId. */
  readonly input: FavoritesDeletionInput;
  /** How many favorites the user has in appId after seeding. */
  readonly seeded: number;
}

/**
 * The user's favorites in one app: 230 taobao rows (more than a list page and a 100-item batch),
 * one jd, one pdd and one favorited after `at`; plus the bystanders: another user of the same app
 * (3 taobao rows with the same product keys and the same jd product) and the same user_id in
 * another app (2 rows). `owner` puts the user's rows under an existing users row.
 */
export async function fixture(
  db: Kysely<DB>,
  owner?: { readonly appId: string; readonly userId: string },
): Promise<Fixture> {
  const appId = owner?.appId ?? newAppId();
  const userId = owner?.userId ?? randomUUID();
  const otherUserId = randomUUID();
  const otherAppId = newAppId();
  const earlier = shift(CLEANUP_AT, -60 * MINUTE_MS);
  await seedMany(db, appId, userId, 230, earlier);
  await seedOne(db, { appId, userId, platform: 'jd', productKey: 'jd:4001', createdAt: earlier });
  await seedOne(db, { appId, userId, platform: 'pdd', productKey: 'pdd:4002', createdAt: earlier });
  await seedOne(db, {
    appId,
    userId,
    productKey: 'tb:after-at',
    createdAt: shift(CLEANUP_AT, MINUTE_MS),
  });
  await seedMany(db, appId, otherUserId, 3, earlier);
  await seedOne(db, {
    appId,
    userId: otherUserId,
    platform: 'jd',
    productKey: 'jd:4001',
    createdAt: earlier,
  });
  await seedMany(db, otherAppId, userId, 2, earlier);
  return {
    appId,
    userId,
    otherUserId,
    otherAppId,
    input: { appId, userId, at: CLEANUP_AT },
    seeded: 233,
  };
}

/** The rows the port must never touch (another user of the app; the user_id in another app). */
export async function bystanders(
  db: Kysely<DB>,
  f: Fixture,
): Promise<{ sameApp: FavoriteRow[]; otherApp: FavoriteRow[] }> {
  return {
    sameApp: await rowsOf(db, f.appId, f.otherUserId),
    otherApp: await rowsOf(db, f.otherAppId, f.userId),
  };
}

const ROLLBACK = Symbol('rollback');

/**
 * Runs `work` in a transaction that is then rolled back. Only its own sentinel is swallowed:
 * NotImplemented and assertion failures propagate.
 */
export async function rolledBack(
  db: Kysely<DB>,
  work: (trx: Transaction<DB>) => Promise<void>,
): Promise<void> {
  try {
    await db.transaction().execute(async (trx) => {
      await work(trx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

/** Locks the user's users row as identity's cleanup does before calling the ports. */
export async function lockUserRow(
  trx: Transaction<DB>,
  appId: string,
  userId: string,
): Promise<number> {
  const { rows } = await sql<{ id: string }>`SELECT id::text AS id FROM app.users
    WHERE app_id = ${appId} AND id = ${userId}::uuid FOR UPDATE`.execute(trx);
  return rows.length;
}

/** Bounds lock and statement waits of a transaction, so a hanging implementation fails. */
export async function bounded(trx: Transaction<DB>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
  await sql`SET LOCAL statement_timeout = '10s'`.execute(trx);
}

interface CleanupFactory {
  readonly inject?: readonly unknown[];
  readonly useFactory: (...args: unknown[]) => DeletionCleanupPorts;
}

/**
 * The DeletionCleanupPorts app.module's cleanup factory builds (from the worker options it passes
 * to IdentityDeletionExpiryModule.forWorker), with CLOCK and ROOT_LOGGER injected when asked.
 */
export function assembledCleanup(options: unknown, p: Ports): DeletionCleanupPorts {
  const cleanup = (options as { cleanup: CleanupFactory }).cleanup;
  const provided = new Map<unknown, unknown>([
    [p.platform.CLOCK, p.clock],
    [p.platform.ROOT_LOGGER, p.logger],
  ]);
  const args = (cleanup.inject ?? []).map((entry) => {
    const token =
      typeof entry === 'object' && entry !== null && 'token' in entry
        ? (entry as { token: unknown }).token
        : entry;
    return provided.get(token);
  });
  return cleanup.useFactory(...args);
}
