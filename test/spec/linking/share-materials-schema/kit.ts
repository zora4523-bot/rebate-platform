// B1-15v rule tests (规划/08 BR-ATTR-10 细则「分享页与分享赚入口页」「中间页的口令按打开环境区分」;
// 编排裁定 D10-426): storage contract of app.share_materials only, no sharing logic.
//   - One row per share link (pid_scene=share), written once by POST /v1/shares: link_id is the
//     primary key and references app.links; share_url is the sharer's converted short link and
//     never empty; tpwd is the Taobao token, absent (NULL) for platforms without one, never ''.
//   - linking is the only writer and only inserts: couli_app gets SELECT and INSERT, nothing else;
//     couli_readonly reads as for every linking table; couli_payout and couli_maint get nothing.
// Rows go through raw SQL: the generated DB types do not know the table before the snapshot.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export const TIMEOUT = 60_000;
export const TABLE = 'app.share_materials';
export const EXPIRE_AT = new Date('2032-07-01T00:00:00Z');
export const ROLES = ['couli_app', 'couli_payout', 'couli_readonly', 'couli_maint'] as const;
export type Role = (typeof ROLES)[number];
export type Row = Record<string, unknown>;
export type Connection = Kysely<DB>;
interface Database {
  urlFor(role: Role): string;
  drop(): Promise<void>;
}
export interface Harness {
  database: Database;
  app: Connection;
  roles: Record<Role, Connection>;
}

// [Postgres type, nullable, default]. Only created_at takes the SQL clock (db/AGENTS.md rule 6);
// no updated_at: a material is never rewritten.
export const SHAPE: Record<string, readonly [string, boolean, string | null]> = {
  app_id: ['text', false, null],
  link_id: ['uuid', false, null],
  share_url: ['text', false, null],
  tpwd: ['text', true, null],
  created_at: ['timestamptz', false, 'now()'],
};

export async function open(create: () => Promise<Database>): Promise<Harness> {
  const database = await create();
  const roles = Object.fromEntries(
    ROLES.map((role) => [role, createDb({ connectionString: database.urlFor(role), max: 2 })]),
  ) as Record<Role, Connection>;
  return { database, roles, app: roles.couli_app };
}
export async function close(h: Harness | undefined): Promise<void> {
  if (!h) return;
  await Promise.all(Object.values(h.roles).map((db) => destroyDb(db)));
  await h.database.drop();
}
export async function columns(db: Connection) {
  return (
    await sql<{ name: string; type: string; nullable: boolean; default_expr: string | null }>`
      SELECT a.attname::text AS name, t.typname::text AS type, NOT a.attnotnull AS nullable,
        pg_get_expr(d.adbin, d.adrelid) AS default_expr
      FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass(${TABLE}) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`.execute(db)
  ).rows;
}
// Every case calls this first: without the migration the case fails on an assertion, not on SQL
// that references a missing table or column.
export async function ready(db: Connection): Promise<void> {
  const found = await sql<{ name: string | null }>`
    SELECT to_regclass(${TABLE})::text AS name`.execute(db);
  expect(found.rows).toEqual([{ name: TABLE }]);
  expect((await columns(db)).map((c) => c.name)).toEqual(
    expect.arrayContaining(Object.keys(SHAPE)),
  );
}
export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string' || !['23502', '23503', '23505', '23514', '42501'].includes(code))
      throw error;
    return code;
  }
}
export function appId(): string {
  return `b115v-${randomUUID()}`;
}
// A share link as POST /v1/shares registers it (scene and pid_scene share), written by couli_app.
export async function seedLink(
  db: Connection,
  app_id: string,
  platform = 'taobao',
): Promise<string> {
  const link_id = randomUUID();
  await sql`INSERT INTO app.links (link_id, app_id, platform, scene, pid_scene, expire_at)
    VALUES (${link_id}, ${app_id}, ${platform}, 'share', 'share', ${EXPIRE_AT})`.execute(db);
  return link_id;
}
export function material(app_id: string, link_id: string, values: Row = {}): Row {
  return {
    app_id,
    link_id,
    share_url: `https://s.click.taobao.com/${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    tpwd: '￥AbCd1234￥',
    ...values,
  };
}
// A material on a freshly seeded share link of its own App.
export async function fresh(db: Connection, values: Row = {}): Promise<Row> {
  const app_id = appId();
  return material(app_id, await seedLink(db, app_id), values);
}
export async function insert(db: Connection, row: Row): Promise<void> {
  await sql`INSERT INTO app.share_materials
    (${sql.join(Object.keys(row).map((name) => sql.ref(name)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}
export async function stored(db: Connection, link_id: unknown): Promise<Row[]> {
  return (await sql<Row>`SELECT * FROM app.share_materials WHERE link_id = ${link_id}`.execute(db))
    .rows;
}
