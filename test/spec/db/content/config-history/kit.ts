// F1-10a §9.2: catalog checks keep the absent migration assertion-red.
// Raw SQL deliberately avoids depending on not-yet-generated DB table types.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { columns } from '../../admin/kit.ts';
import { unique } from '../kit.ts';

export const TABLE = 'config_item_versions';
export const AT = new Date('2026-10-12T03:04:05.678Z');
export const NAMES = [
  'app_id',
  'key',
  'version',
  'value',
  'updated_by',
  'updated_by_admin_id',
  'reason',
  'created_at',
] as const;
export type Row = Record<string, unknown>;

export async function ready(db: Kysely<DB>): Promise<void> {
  const names = (await columns(db, TABLE)).map((c) => c.name);
  for (const name of NAMES) expect(names, `app.${TABLE}.${name}`).toContain(name);
}

export function history(overrides: Row = {}): Row {
  return {
    app_id: unique('history_app_'),
    key: unique('config.history.'),
    version: 1,
    value: '{"enabled":true,"nested":[1,null,"中文"]}',
    updated_by: '原管理员快照',
    updated_by_admin_id: null,
    reason: null,
    created_at: AT,
    ...overrides,
  };
}

export async function insert(db: Kysely<DB>, row: Row): Promise<void> {
  const names = Object.keys(row);
  await sql`
    INSERT INTO app.config_item_versions (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))})
  `.execute(db);
}

export async function read(db: Kysely<DB>, row: Row): Promise<Row[]> {
  const result = await sql<Row>`
    SELECT app_id, key, version, value, updated_by, updated_by_admin_id, reason, created_at
    FROM app.config_item_versions
    WHERE app_id = ${row.app_id} AND key = ${row.key} AND version = ${row.version}
  `.execute(db);
  return result.rows;
}
