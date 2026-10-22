// B1-15o §9.2 #1–3, #5: column grants extend the baseline, never table-wide UPDATE.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  close,
  columns,
  fixture,
  insert,
  open,
  read,
  ready,
  sqlState,
  type Harness,
  type Table,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = open(await createTestDatabase());
});
afterAll(async () => {
  await close(h);
});

const writable: Record<Table, string[]> = {
  login_logs: ['user_id'],
  agent_sessions: [
    'last_active_at',
    'expired_at',
    'card_seq',
    'row_version',
    'updated_at',
    'run_lock_run_id',
    'run_lock_expires_at',
    'user_id',
    'user_hash',
  ],
  deletion_requests: [
    'status',
    'cancelled_at',
    'cancel_reason',
    'processed_at',
    'row_version',
    'updated_at',
    'cleaned_at',
    'apple_revoke_attempts',
    'apple_revoke_result',
  ],
};

for (const [index, table] of (
  ['login_logs', 'agent_sessions', 'deletion_requests'] as const
).entries()) {
  it(`[AC-B1-15o#${11 + index}] ${table} permits exactly the original update columns plus cleanup columns; other roles gain no writes`, async () => {
    await ready(h.app, table);
    const names = (await columns(h.app, table)).map((c) => c.name);
    const row = await insert(h.app, table, await fixture(h.app, table));
    for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
      for (const privilege of [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
        'MAINTAIN',
      ]) {
        const allowed =
          role === 'couli_app'
            ? ['SELECT', 'INSERT'].includes(privilege)
            : role === 'couli_readonly' && privilege === 'SELECT';
        expect(
          (
            await sql`SELECT has_table_privilege(${role}, ${`app.${table}`}, ${privilege}) AS allowed`.execute(
              h.app,
            )
          ).rows,
          `${role}/${table}/${privilege}`,
        ).toEqual([{ allowed }]);
      }
      for (const name of names) {
        const allowed = role === 'couli_app' && writable[table].includes(name);
        expect(
          (
            await sql`SELECT has_column_privilege(${role}, ${`app.${table}`}, ${name}, 'UPDATE') AS allowed`.execute(
              h.app,
            )
          ).rows,
          `${role}/${table}/${name}`,
        ).toEqual([{ allowed }]);
      }
    }
    const identityColumns = (
      await sql<{ name: string }>`SELECT column_name AS name
        FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = ${table}
          AND is_identity = 'YES'`.execute(h.app)
    ).rows.map((column) => column.name);
    for (const name of names) {
      // Identity assignments fail with 428C9 before privilege checks; covered above
      // by has_column_privilege for every role instead.
      if (identityColumns.includes(name)) continue;
      // No-op values isolate permissions from CHECKs and immutable-owner triggers.
      const statement = sql`UPDATE ${sql.table(`app.${table}`)} SET ${sql.ref(name)} = ${sql.ref(name)} WHERE id = ${row['id']}`;
      expect(await sqlState(statement.execute(h.app)), `${table}/${name}`).toBe(
        writable[table].includes(name) ? 'no error' : '42501',
      );
      expect(await sqlState(statement.execute(h.readonly)), `readonly/${table}/${name}`).toBe(
        '42501',
      );
    }
    for (const db of [h.app, h.readonly]) {
      expect(
        await sqlState(
          sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE id = ${row['id']}`.execute(db),
        ),
      ).toBe('42501');
      expect(await read(db, table, row['id'])).toEqual(row);
    }
  });
}
