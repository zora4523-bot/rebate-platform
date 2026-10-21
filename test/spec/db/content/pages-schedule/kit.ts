// F1-09n §9.2–9.3: independent fixtures, adapted from pages/kit.ts.
// Raw SQL deliberately avoids depending on generated types before the migration exists.
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export type Connection = Kysely<DB>;
export type Row = Record<string, unknown>;
export type Table = 'pages' | 'page_versions' | 'admin_users';
export const AT = new Date('2026-10-21T08:00:00.000Z');
export const SLOT_SHAPE = {
  scheduled_version: 'int4',
  scheduled_gray_percent: 'int2',
  scheduled_at: 'timestamptz',
  scheduled_by_admin_id: 'uuid',
};
export const SLOT_COLUMNS = Object.keys(SLOT_SHAPE);
export const EMPTY_SLOT = {
  scheduled_version: null,
  scheduled_gray_percent: null,
  scheduled_at: null,
  scheduled_by_admin_id: null,
};

export async function columns(db: Connection) {
  return (
    await sql<{
      name: string;
      type: string;
      nullable: string;
      defaultValue: string | null;
    }>`SELECT column_name AS name, udt_name AS type, is_nullable AS nullable,
        column_default AS "defaultValue"
      FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'pages'
        AND column_name IN (${sql.join(SLOT_COLUMNS)})
      ORDER BY column_name`.execute(db)
  ).rows;
}

// Each test asserts readiness before issuing any SQL that names a new column.
// Without migration 0068, every test fails an assertion rather than SQL 42703.
export async function ready(db: Connection): Promise<void> {
  expect((await columns(db)).map((c) => c.name), 'app.pages scheduled slot columns').toEqual(
    [...SLOT_COLUMNS].sort(),
  );
}

export async function insert(db: Connection, table: Table, row: Row): Promise<Row> {
  const names = Object.keys(row);
  const result = await sql<Row>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((n) => sql.ref(n)))})
    VALUES (${sql.join(names.map((n) => row[n]))}) RETURNING *`.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

export async function update(db: Connection, key: Row, changes: Row): Promise<Row> {
  const result = await sql<Row>`UPDATE app.pages
    SET ${sql.join(Object.entries(changes).map(([k, v]) => sql`${sql.ref(k)} = ${v}`))}
    WHERE ${sql.join(Object.entries(key).map(([k, v]) => sql`${sql.ref(k)} = ${v}`), sql` AND `)}
    RETURNING *`.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

export async function admin(db: Connection, appId: string): Promise<string> {
  const id = randomUUID();
  await insert(db, 'admin_users', {
    id,
    app_id: appId,
    login_name: `schedule_${id.replaceAll('-', '')}`,
    password_hash: 'synthetic-schedule-fixture',
    is_super: false,
    status: 'active',
    created_at: AT,
    updated_at: AT,
  });
  return id;
}

export async function seeded(db: Connection) {
  await ready(db);
  const appId = `schedule_${randomUUID().replaceAll('-', '')}`;
  const creator = await admin(db, appId);
  // Scheduler is referenced only by the new FK, not by publisher/creator/updated_by.
  const scheduler = await admin(db, appId);
  const page = { app_id: appId, page_key: 'home' };
  const version = {
    ...page,
    version: 1,
    sections: '[]',
    created_by_admin_id: creator,
    created_at: AT,
  };
  for (const number of [1, 2, 3]) {
    await insert(db, 'page_versions', { ...version, version: number });
  }
  const slot = {
    scheduled_version: 3,
    scheduled_gray_percent: 10,
    scheduled_at: AT,
    scheduled_by_admin_id: scheduler,
  };
  return { page, version, slot };
}

export async function rejects(
  run: Promise<unknown>,
  constraint: string,
  code = '23514',
): Promise<void> {
  await expect(run).rejects.toMatchObject({ code, constraint });
}
