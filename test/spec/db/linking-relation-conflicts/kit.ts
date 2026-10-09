// B1-06y storage probes only; binding orchestration belongs to B1-06z.
import { randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { columns, newAccount, newUser, requireTable, sqlState } from '../linking-bindings/kit.ts';

export const TABLE = 'union_binding_conflicts';
export const OCCURRED = new Date('2026-10-09T01:00:00.000Z');
export const RESOLVED = new Date('2026-10-09T02:00:00.000Z');
export const LATER = new Date('2026-10-09T03:00:00.000Z');
export const TIMEOUT = 30_000;
export const SHAPE = [
  { name: 'id', type: 'uuid', nullable: false },
  { name: 'app_id', type: 'text', nullable: false },
  { name: 'user_id', type: 'uuid', nullable: false },
  { name: 'platform', type: 'text', nullable: false },
  { name: 'union_account_id', type: 'uuid', nullable: false },
  { name: 'kind', type: 'text', nullable: false },
  { name: 'occurred_at', type: 'timestamptz', nullable: false },
  { name: 'resolved_at', type: 'timestamptz', nullable: true },
  { name: 'resolution', type: 'text', nullable: true },
];

export async function requireShape(): Promise<void> {
  await requireTable(TABLE);
  expect(
    (await columns(TABLE)).map(({ name, type, nullable }) => ({ name, type, nullable })),
  ).toEqual(expect.arrayContaining(SHAPE));
}

export async function fixture(values: Record<string, unknown> = {}) {
  const appId = String(values['app_id'] ?? 'couli');
  const platform = String(values['platform'] ?? 'taobao');
  return {
    id: randomUUID(),
    app_id: appId,
    user_id: await newUser({ app_id: appId }),
    platform,
    union_account_id: await newAccount(appId, platform),
    kind: 'occupied',
    occurred_at: OCCURRED,
    resolved_at: null,
    resolution: null,
    ...values,
  };
}

// All nine task columns are explicit; catalog fillers never mask missing task defaults.
export async function insert(db: Kysely<DB>, row: Record<string, unknown>): Promise<void> {
  await sql`INSERT INTO app.union_binding_conflicts
    (${sql.join(Object.keys(row).map((name) => sql.ref(name)))})
    VALUES (${sql.join(Object.values(row))})`.execute(db);
}

export async function accepted(db: Kysely<DB>, values: Record<string, unknown> = {}) {
  const row = await fixture(values);
  expect(await sqlState(insert(db, row)), 'valid synthetic conflict row').toBe('no error');
  return row;
}

export async function stored(db: Kysely<DB>, id: string) {
  return (
    await sql<
      Record<string, unknown>
    >`SELECT * FROM app.union_binding_conflicts WHERE id = ${id}`.execute(db)
  ).rows;
}
