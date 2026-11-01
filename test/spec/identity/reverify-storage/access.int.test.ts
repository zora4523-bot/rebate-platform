// B1-02zo 编排 §9.2 #1 / db/AGENTS.md 迁移规则 4: grants live in the same migration and follow the
// existing users / devices pattern. couli_app (identity) reads and writes the new users columns and
// reads, inserts and deletes reverified_devices (deletion processing removes them, B1-02zr);
// couli_readonly only reads; couli_payout and couli_maint get nothing. Whether couli_app may UPDATE
// reverified_devices is not pinned here. Top-level it() only; each test preflights first.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  DEVICE_COLUMN_NAMES,
  NO_ERROR,
  PERMISSION_DENIED,
  ROLES,
  USER_COLUMN_NAMES,
  close,
  devicesOf,
  expectDeviceTable,
  expectUserColumns,
  hash,
  insertDevice,
  open,
  person,
  sqlState,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = open(await createTestDatabase());
}, 180_000);
afterAll(async () => {
  await close(h);
});

const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
  'MAINTAIN',
] as const;
const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] as const;

async function tablePrivilege(role: string, table: string, privilege: string) {
  const result = await sql<{ allowed: boolean }>`
    SELECT has_table_privilege(${role}, ${table}, ${privilege}) AS allowed`.execute(h.app);
  return result.rows[0]!.allowed;
}

async function columnPrivilege(role: string, table: string, column: string, privilege: string) {
  const result = await sql<{ allowed: boolean }>`
    SELECT has_column_privilege(${role}, ${table}, ${column}, ${privilege}) AS allowed`.execute(
    h.app,
  );
  return result.rows[0]!.allowed;
}

it('[AC-B1-02zo#8] users 新列：couli_app 可读可写，couli_readonly 只读不写，couli_payout / couli_maint 无任何权限；users 原有表级授权不变', async () => {
  await expectUserColumns(h.app);
  const expected: Record<string, Record<string, boolean>> = {
    couli_app: { SELECT: true, INSERT: true, UPDATE: true, REFERENCES: false },
    couli_readonly: { SELECT: true, INSERT: false, UPDATE: false, REFERENCES: false },
    couli_payout: { SELECT: false, INSERT: false, UPDATE: false, REFERENCES: false },
    couli_maint: { SELECT: false, INSERT: false, UPDATE: false, REFERENCES: false },
  };
  for (const role of ROLES) {
    for (const column of USER_COLUMN_NAMES) {
      for (const privilege of COLUMN_PRIVILEGES) {
        expect(
          await columnPrivilege(role, 'app.users', column, privilege),
          `${role}/users.${column}/${privilege}`,
        ).toBe(expected[role]![privilege]);
      }
    }
  }
  // The table-level users grants of 0005 stay as they are.
  const table: Record<string, readonly string[]> = {
    couli_app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    couli_readonly: ['SELECT'],
    couli_payout: [],
    couli_maint: [],
  };
  for (const role of ROLES) {
    for (const privilege of TABLE_PRIVILEGES) {
      expect(await tablePrivilege(role, 'app.users', privilege), `${role}/users/${privilege}`).toBe(
        table[role]!.includes(privilege),
      );
    }
  }

  const owner = await person(h.app);
  const write = (role: keyof Harness['dbs']) =>
    sql`UPDATE app.users SET reverify_fail_count = reverify_fail_count + 1,
        last_login_device_hash = ${hash()}
      WHERE id = ${owner.user_id}`.execute(h.dbs[role]);
  expect(await sqlState(write('couli_app'))).toBe(NO_ERROR);
  for (const role of ['couli_readonly', 'couli_payout', 'couli_maint'] as const) {
    expect(await sqlState(write(role)), role).toBe(PERMISSION_DENIED);
  }
  for (const role of ['couli_payout', 'couli_maint'] as const) {
    const read = sql`SELECT reverify_trusted FROM app.users WHERE id = ${owner.user_id}`;
    expect(await sqlState(read.execute(h.dbs[role])), role).toBe(PERMISSION_DENIED);
  }
  const count = await sql<{ n: number }>`SELECT reverify_fail_count AS n FROM app.users
    WHERE id = ${owner.user_id}`.execute(h.dbs.couli_readonly);
  expect(count.rows).toEqual([{ n: 1 }]);
});

it('[AC-B1-02zo#9] reverified_devices：couli_app 可读、插入、删除，couli_readonly 只读，couli_payout / couli_maint 无任何权限；无人可 TRUNCATE / REFERENCES / TRIGGER / MAINTAIN', async () => {
  await expectDeviceTable(h.app);
  const table = 'app.reverified_devices';
  const required: Record<string, readonly string[]> = {
    couli_app: ['SELECT', 'INSERT', 'DELETE'],
    couli_readonly: ['SELECT'],
    couli_payout: [],
    couli_maint: [],
  };
  for (const role of ROLES) {
    for (const privilege of TABLE_PRIVILEGES) {
      if (role === 'couli_app' && privilege === 'UPDATE') continue;
      expect(await tablePrivilege(role, table, privilege), `${role}/${privilege}`).toBe(
        required[role]!.includes(privilege),
      );
    }
  }
  // Column grants must not reopen what the table grants withhold.
  for (const role of ['couli_readonly', 'couli_payout', 'couli_maint'] as const) {
    for (const column of DEVICE_COLUMN_NAMES) {
      for (const privilege of COLUMN_PRIVILEGES) {
        expect(
          await columnPrivilege(role, table, column, privilege),
          `${role}/${column}/${privilege}`,
        ).toBe(role === 'couli_readonly' && privilege === 'SELECT');
      }
    }
  }
  for (const column of DEVICE_COLUMN_NAMES) {
    expect(
      await columnPrivilege('couli_app', table, column, 'REFERENCES'),
      `couli_app/${column}/REFERENCES`,
    ).toBe(false);
  }

  const owner = await person(h.app);
  const kept = hash();
  for (const role of ['couli_readonly', 'couli_payout', 'couli_maint'] as const) {
    expect(await sqlState(insertDevice(h.dbs[role], owner, hash(), 'self')), role).toBe(
      PERMISSION_DENIED,
    );
  }
  expect(await sqlState(insertDevice(h.app, owner, kept, 'self'))).toBe(NO_ERROR);
  const removed = hash();
  expect(await sqlState(insertDevice(h.app, owner, removed, 'admin'))).toBe(NO_ERROR);
  for (const role of ['couli_readonly', 'couli_payout', 'couli_maint'] as const) {
    const remove = sql`DELETE FROM app.reverified_devices
      WHERE app_id = ${owner.app_id} AND user_id = ${owner.user_id}`;
    expect(await sqlState(remove.execute(h.dbs[role])), role).toBe(PERMISSION_DENIED);
  }
  for (const role of ['couli_payout', 'couli_maint'] as const) {
    expect(await sqlState(devicesOf(h.dbs[role], owner)), role).toBe(PERMISSION_DENIED);
  }
  const ofOwner = await devicesOf(h.dbs.couli_readonly, owner);
  expect(ofOwner).toHaveLength(2);
  expect(ofOwner).toEqual(
    expect.arrayContaining([
      { device_hash: kept, source: 'self' },
      { device_hash: removed, source: 'admin' },
    ]),
  );

  const deleted = await sql`DELETE FROM app.reverified_devices
    WHERE app_id = ${owner.app_id} AND user_id = ${owner.user_id} AND device_hash = ${removed}`.execute(
    h.app,
  );
  expect(deleted.numAffectedRows).toBe(1n);
  expect(await devicesOf(h.app, owner)).toEqual([{ device_hash: kept, source: 'self' }]);
});
