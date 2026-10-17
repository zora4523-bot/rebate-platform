import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  TABLES,
  ROLES,
  TIMEOUT,
  close,
  columns,
  fixture,
  insert,
  open,
  ready,
  row,
  sqlState,
  stored,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

for (const table of TABLES) {
  it(`[AC-B2-01g#18] ${table} app 只读与追加，readonly 只读，payout / maint 无权限`, async () => {
    await ready(h.app);
    const f = await fixture(h.app);
    const valid = row(table, f);
    expect(await sqlState(insert(h.app, table, valid))).toBe('ok');
    const before = await stored(h.app, table, f.orderId);
    expect(before).toHaveLength(1);
    for (const role of ROLES) {
      const db = h.connections[role];
      if (role === 'couli_app' || role === 'couli_readonly') {
        expect(await stored(db, table, f.orderId)).toEqual(before);
      } else {
        expect(await sqlState(stored(db, table, f.orderId))).toBe('42501');
      }
      if (role !== 'couli_app') {
        expect(await sqlState(insert(db, table, valid))).toBe('42501');
      }
      expect(
        await sqlState(
          sql`UPDATE ${sql.table(`app.${table}`)} SET created_at = created_at
        WHERE order_id = ${f.orderId}`.execute(db),
        ),
        `${role} UPDATE`,
      ).toBe('42501');
      expect(
        await sqlState(
          sql`DELETE FROM ${sql.table(`app.${table}`)}
        WHERE order_id = ${f.orderId}`.execute(db),
        ),
        `${role} DELETE`,
      ).toBe('42501');
    }
    expect(await stored(h.app, table, f.orderId)).toEqual(before);
  });

  it(`[AC-B2-01g#19] ${table} 没有额外表级或列级权限可绕过只追加约束`, async () => {
    await ready(h.app);
    for (const role of ROLES) {
      for (const privilege of [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
      ]) {
        const allowed =
          (role === 'couli_app' && ['SELECT', 'INSERT'].includes(privilege)) ||
          (role === 'couli_readonly' && privilege === 'SELECT');
        const result = await sql<{ allowed: boolean }>`SELECT has_table_privilege(
          ${role}, ${`app.${table}`}, ${privilege}) AS allowed`.execute(h.app);
        expect(result.rows, `${role}/${table}/${privilege}`).toEqual([{ allowed }]);
      }
      for (const { name } of await columns(h.app, table)) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          const allowed =
            (role === 'couli_app' && ['SELECT', 'INSERT'].includes(privilege)) ||
            (role === 'couli_readonly' && privilege === 'SELECT');
          const result = await sql<{ allowed: boolean }>`SELECT has_column_privilege(
            ${role}, ${`app.${table}`}, ${name}, ${privilege}) AS allowed`.execute(h.app);
          expect(result.rows, `${role}/${table}/${name}/${privilege}`).toEqual([{ allowed }]);
        }
      }
    }
  });
}
