// B1-11a §9.3: explicit log fixtures; the existing filler is used only for users.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { newUser } from '../../identity-sessions/kit.ts';

export const TABLES = ['relation_change_logs', 'level_change_logs'] as const;
export type Table = (typeof TABLES)[number];
export const AT = new Date('2026-10-17T08:00:00.000Z');
export const BEFORE = new Date('2026-10-17T07:59:59.999Z');
export const MIDDLE = new Date('2026-10-17T08:30:00.000Z');
export const LATER = new Date('2026-10-17T09:00:00.000Z');

// Missing migration is an assertion failure, never an undefined_table setup error.
export async function ready(db: Kysely<DB>, table: Table): Promise<void> {
  const result = await sql<{ kind: string }>`SELECT relkind::text AS kind
    FROM pg_class WHERE oid = to_regclass(${`app.${table}`})`.execute(db);
  expect(result.rows, table).toEqual([{ kind: 'r' }]);
}

export async function fixture(table: Table, appId = 'couli'): Promise<Record<string, unknown>> {
  const common = {
    app_id: appId,
    user_id: await newUser({ app_id: appId }),
    source: 'admin',
    operator: 'synthetic:growth-admin',
    reason: '人工调整测试',
  };
  return table === 'relation_change_logs'
    ? { ...common, from_parent_id: null, to_parent_id: await newUser({ app_id: appId }), at: AT }
    : { ...common, from_level: 'L1', to_level: 'L2', effective_at: AT };
}

export function insert(db: Kysely<DB>, table: Table, row: Record<string, unknown>) {
  return sql<Record<string, unknown>>`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(Object.keys(row).map((name) => sql.ref(name)))})
    VALUES (${sql.join(Object.values(row))}) RETURNING *`.execute(db);
}

export async function replay(
  db: Kysely<DB>,
  table: Table,
  appId: string,
  userId: string,
  at: Date,
) {
  const clock = table === 'relation_change_logs' ? 'at' : 'effective_at';
  return (
    await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(`app.${table}`)}
    WHERE app_id = ${appId} AND user_id = ${userId} AND ${sql.ref(clock)} <= ${at}
    ORDER BY ${sql.ref(clock)} DESC, id DESC LIMIT 1`.execute(db)
  ).rows;
}
