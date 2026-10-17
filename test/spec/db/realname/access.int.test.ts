// B1-13b §9.3 grants: use real business-role connections, never the migration role.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  LATER,
  OTHER_HASH,
  PRIVATE_COLUMNS,
  READ_COLUMNS,
  UPDATE_COLUMNS,
  cleared,
  close,
  columns,
  insert,
  open,
  ready,
  realname,
  sqlState,
  tombstone,
  update,
  verified,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = open(await createTestDatabase());
});
afterAll(async () => {
  await close(h);
});

it('[AC-B1-13b#17] couli_app can insert/read realname but cannot delete or change ownership/identity', async () => {
  await ready(h.app, 'realname');
  const row = await realname(h.app);
  expect(await sqlState(insert(h.app, 'realname', row))).toBe('no error');
  const stored = await sql`SELECT * FROM app.realname WHERE id = ${row['id']}`.execute(h.app);
  expect(stored.rows).toEqual([expect.objectContaining(row)]);
  expect(await sqlState(sql`DELETE FROM app.realname WHERE id = ${row['id']}`.execute(h.app))).toBe(
    '42501',
  );
  for (const field of ['id', 'app_id', 'user_id', 'created_at']) {
    expect(
      await sqlState(
        sql`UPDATE app.realname SET ${sql.ref(field)} = ${sql.ref(field)}
      WHERE id = ${row['id']}`.execute(h.app),
      ),
      field,
    ).toBe('42501');
  }
});

it('[AC-B1-13b#18] couli_app can atomically verify, correct and anonymize the allowed columns', async () => {
  await ready(h.app, 'realname');
  const row = await realname(h.app, cleared());
  expect(await sqlState(insert(h.app, 'realname', row))).toBe('no error');
  const correction = {
    ...verified(),
    id_no_hmac: OTHER_HASH,
    provider: 'corrected-fixture-provider',
    verified_at: LATER,
    row_version: 1,
    updated_at: LATER,
  };
  expect(await sqlState(update(h.app, row['id'], correction))).toBe('no error');
  const stored = await sql`SELECT * FROM app.realname WHERE id = ${row['id']}`.execute(h.app);
  expect(stored.rows).toEqual([expect.objectContaining({ ...row, ...correction })]);
  expect(await sqlState(update(h.app, row['id'], cleared()))).toBe('no error');
  const anonymized = await sql`SELECT * FROM app.realname WHERE id = ${row['id']}`.execute(h.app);
  expect(anonymized.rows).toEqual([expect.objectContaining(cleared())]);
});

it('[AC-B1-13b#19] couli_readonly can read only the public realname columns', async () => {
  await ready(h.app, 'realname');
  const row = await realname(h.app);
  expect(await sqlState(insert(h.app, 'realname', row))).toBe('no error');
  const publicRow = await sql`SELECT ${sql.join(READ_COLUMNS.map((name) => sql.ref(name)))}
    FROM app.realname WHERE id = ${row['id']}`.execute(h.readonly);
  expect(publicRow.rows).toEqual([
    expect.objectContaining({
      id: row['id'],
      app_id: row['app_id'],
      user_id: row['user_id'],
      status: 'verified',
    }),
  ]);
  for (const field of PRIVATE_COLUMNS) {
    expect(
      await sqlState(
        sql`SELECT ${sql.ref(field)} FROM app.realname
      WHERE id = ${row['id']}`.execute(h.readonly),
      ),
      field,
    ).toBe('42501');
  }
  expect(await sqlState(sql`SELECT * FROM app.realname`.execute(h.readonly))).toBe('42501');
  expect(await sqlState(insert(h.readonly, 'realname', await realname(h.app)))).toBe('42501');
  expect(await sqlState(update(h.readonly, row['id'], cleared()))).toBe('42501');
  expect(
    await sqlState(sql`DELETE FROM app.realname WHERE id = ${row['id']}`.execute(h.readonly)),
  ).toBe('42501');
});

it('[AC-B1-13b#20] tombstones allow couli_app insert/read/delete but forbid every update', async () => {
  await ready(h.app, 'deleted_identities');
  const row = tombstone();
  expect(await sqlState(insert(h.app, 'deleted_identities', row))).toBe('no error');
  const stored =
    await sql`SELECT * FROM app.deleted_identities WHERE app_id = ${row['app_id']}`.execute(h.app);
  expect(stored.rows).toEqual([expect.objectContaining(row)]);
  for (const field of [
    'id',
    'app_id',
    'reason',
    'phone_hmac',
    'device_hash',
    'deleted_at',
    'expire_at',
    'created_at',
  ]) {
    expect(
      await sqlState(
        sql`UPDATE app.deleted_identities SET ${sql.ref(field)} = ${sql.ref(field)}
      WHERE app_id = ${row['app_id']}`.execute(h.app),
      ),
      field,
    ).toBe('42501');
  }
  expect(
    await sqlState(
      sql`DELETE FROM app.deleted_identities WHERE app_id = ${row['app_id']}`.execute(h.app),
    ),
  ).toBe('no error');
  const deleted =
    await sql`SELECT * FROM app.deleted_identities WHERE app_id = ${row['app_id']}`.execute(h.app);
  expect(deleted.rows).toEqual([]);
});

it('[AC-B1-13b#21] couli_readonly can read tombstones and cannot insert/update/delete them', async () => {
  await ready(h.app, 'deleted_identities');
  const row = tombstone();
  expect(await sqlState(insert(h.app, 'deleted_identities', row))).toBe('no error');
  const stored =
    await sql`SELECT * FROM app.deleted_identities WHERE app_id = ${row['app_id']}`.execute(
      h.readonly,
    );
  expect(stored.rows).toEqual([expect.objectContaining(row)]);
  expect(await sqlState(insert(h.readonly, 'deleted_identities', tombstone()))).toBe('42501');
  expect(
    await sqlState(
      sql`UPDATE app.deleted_identities SET reason = reason
    WHERE app_id = ${row['app_id']}`.execute(h.readonly),
    ),
  ).toBe('42501');
  expect(
    await sqlState(
      sql`DELETE FROM app.deleted_identities
    WHERE app_id = ${row['app_id']}`.execute(h.readonly),
    ),
  ).toBe('42501');
});

it('[AC-B1-13b#22] effective table and column grants exactly match the two-role matrix', async () => {
  await ready(h.app, 'realname');
  await ready(h.app, 'deleted_identities');
  for (const table of ['realname', 'deleted_identities'] as const) {
    for (const role of ['couli_app', 'couli_readonly']) {
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
          role === 'couli_app'
            ? ['SELECT', 'INSERT'].includes(privilege) ||
              (table === 'deleted_identities' && privilege === 'DELETE')
            : table === 'deleted_identities' && privilege === 'SELECT';
        const result = await sql<{ allowed: boolean }>`SELECT has_table_privilege(
          ${role}, ${`app.${table}`}, ${privilege}) AS allowed`.execute(h.app);
        expect(result.rows, `${role}/${table}/${privilege}`).toEqual([{ allowed }]);
      }
      for (const column of await columns(h.app, table)) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          const allowed =
            role === 'couli_app'
              ? ['SELECT', 'INSERT'].includes(privilege) ||
                (table === 'realname' &&
                  privilege === 'UPDATE' &&
                  UPDATE_COLUMNS.includes(column.name))
              : privilege === 'SELECT' &&
                (table === 'deleted_identities' || READ_COLUMNS.includes(column.name));
          const result = await sql<{ allowed: boolean }>`SELECT has_column_privilege(
            ${role}, ${`app.${table}`}, ${column.name}, ${privilege}) AS allowed`.execute(h.app);
          expect(result.rows, `${role}/${table}/${column.name}/${privilege}`).toEqual([
            { allowed },
          ]);
        }
      }
    }
  }
});
