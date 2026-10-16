import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

export type Favorite = {
  id: string;
  app_id: string;
  user_id: string;
  platform: string;
  product_key: string;
  created_at: Date;
};

export function favorite(): Favorite {
  return {
    id: randomUUID(),
    app_id: `favorites_${randomUUID()}`,
    user_id: randomUUID(),
    platform: 'taobao',
    product_key: 'tb:0001',
    created_at: new Date('2026-10-16T08:00:00.000Z'),
  };
}

// Every test calls this before table access, outside any SQL-error catcher.
// Missing migrations must produce AssertionError, not undefined_table (42P01).
export async function ready(db: Kysely<DB>): Promise<void> {
  const relation = await sql<{ kind: string; partition: boolean }>`
    SELECT c.relkind::text AS kind, c.relispartition AS partition
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relname = 'favorites'
  `.execute(db);
  expect(relation.rows).toEqual([{ kind: 'r', partition: false }]);
  const columns = await sql<{ name: string }>`
    SELECT a.attname::text AS name FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = to_regclass('app.favorites')
      AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attname
  `.execute(db);
  expect(columns.rows.map((column) => column.name)).toEqual([
    'app_id',
    'created_at',
    'id',
    'platform',
    'product_key',
    'user_id',
  ]);
}

export function insert(db: Kysely<DB>, row: Record<string, unknown>) {
  const names = Object.keys(row);
  return sql<Favorite>`INSERT INTO app.favorites
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))})`.execute(db);
}

export async function sqlState(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (typeof error.code === 'string') return error.code;
    }
    throw error;
  }
}

// Include column grants: table ACL checks alone miss UPDATE(id) or SELECT(id).
export async function privileges(db: Kysely<DB>) {
  return sql<{ privilege: string }>`
    SELECT p AS privilege
    FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                     'REFERENCES', 'TRIGGER', 'MAINTAIN']) p
    WHERE has_table_privilege(current_user, 'app.favorites', p)
      OR CASE WHEN p IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
        THEN has_any_column_privilege(current_user, 'app.favorites', p)
        ELSE false END
    ORDER BY p
  `.execute(db);
}
