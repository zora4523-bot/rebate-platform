// B1-28b: database helpers of the favorites rule tests (app.favorites from migration 0031, read
// and seeded as couli_app, which holds SELECT, INSERT and DELETE on it).
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export interface FavoriteRow {
  id: string;
  app_id: string;
  user_id: string;
  platform: string;
  product_key: string;
  created_at: Date;
}

/** Every row of one user in one app, newest first (created_at DESC, id DESC). */
export async function rowsOf(
  db: Kysely<DB>,
  appId: string,
  userId: string,
): Promise<FavoriteRow[]> {
  const result = await sql<FavoriteRow>`
    SELECT id::text AS id, app_id, user_id::text AS user_id, platform, product_key, created_at
    FROM app.favorites WHERE app_id = ${appId} AND user_id = ${userId}::uuid
    ORDER BY created_at DESC, id DESC
  `.execute(db);
  return result.rows;
}

export async function countOf(db: Kysely<DB>, appId: string, userId: string): Promise<number> {
  const result = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.favorites
    WHERE app_id = ${appId} AND user_id = ${userId}::uuid
  `.execute(db);
  return Number(result.rows[0]?.n ?? '-1');
}

/** One fixture row; returns its id. */
export async function seedOne(
  db: Kysely<DB>,
  row: { appId: string; userId: string; platform?: string; productKey: string; createdAt: Date },
  id: string = randomUUID(),
): Promise<string> {
  await sql`
    INSERT INTO app.favorites (id, app_id, user_id, platform, product_key, created_at)
    VALUES (${id}::uuid, ${row.appId}, ${row.userId}::uuid, ${row.platform ?? 'taobao'},
      ${row.productKey}, ${row.createdAt})
  `.execute(db);
  return id;
}

/**
 * `n` fixture rows tb:seed-1 … tb:seed-n of one user, row i favorited i seconds before `newest`
 * (so tb:seed-1 is the newest).
 */
export async function seedMany(
  db: Kysely<DB>,
  appId: string,
  userId: string,
  n: number,
  newest: Date,
): Promise<void> {
  await sql`
    INSERT INTO app.favorites (id, app_id, user_id, platform, product_key, created_at)
    SELECT gen_random_uuid(), ${appId}, ${userId}::uuid, 'taobao', 'tb:seed-' || i,
      ${newest}::timestamptz - make_interval(secs => i)
    FROM generate_series(1, ${n}::int) AS i
  `.execute(db);
}

export function newUserId(): string {
  return randomUUID();
}
