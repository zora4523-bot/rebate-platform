// B1-15a §9.2 #6: identity writes only the six explicitly granted update columns.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AFTER,
  BEFORE,
  DEADLINE,
  IMMUTABLE_COLUMNS,
  UPDATE_COLUMNS,
  close,
  insert,
  open,
  ready,
  request,
  sqlState,
  state,
  update,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = open(await createTestDatabase());
});
afterAll(async () => {
  await close(h);
});

it('[AC-B1-15a#17] app can insert, read, and update exactly the lifecycle fields', async () => {
  await ready(h.app);
  for (const terminal of ['cancelled', 'done']) {
    const row = await request(h.app);
    expect(await sqlState(insert(h.app, row))).toBe('no error');
    const initial = await sql`SELECT * FROM app.deletion_requests WHERE id = ${row['id']}`.execute(
      h.app,
    );
    expect(initial.rows).toEqual([expect.objectContaining({ ...row, row_version: 0 })]);
    if (terminal === 'done') {
      expect(
        await sqlState(
          update(h.app, row['id'], {
            status: 'processing',
            row_version: 1,
            updated_at: DEADLINE,
          }),
        ),
      ).toBe('no error');
    }
    const changes = {
      ...state(terminal),
      row_version: 2,
      updated_at: terminal === 'done' ? AFTER : BEFORE,
    };
    expect(await sqlState(update(h.app, row['id'], changes))).toBe('no error');
    const stored = await sql`SELECT * FROM app.deletion_requests WHERE id = ${row['id']}`.execute(
      h.app,
    );
    expect(stored.rows).toEqual([expect.objectContaining({ ...row, ...changes })]);
  }
});

it('[AC-B1-15a#18] app cannot update immutable columns or delete a request', async () => {
  await ready(h.app);
  const row = await request(h.app);
  expect(await sqlState(insert(h.app, row))).toBe('no error');
  for (const column of IMMUTABLE_COLUMNS) {
    // A no-op value is otherwise valid, isolating the privilege check from constraints.
    expect(
      await sqlState(
        sql`UPDATE app.deletion_requests
        SET ${sql.ref(column)} = ${sql.ref(column)} WHERE id = ${row['id']}`.execute(h.app),
      ),
      column,
    ).toBe('42501');
  }
  expect(
    await sqlState(sql`DELETE FROM app.deletion_requests WHERE id = ${row['id']}`.execute(h.app)),
  ).toBe('42501');
  const stored = await sql`SELECT * FROM app.deletion_requests WHERE id = ${row['id']}`.execute(
    h.app,
  );
  expect(stored.rows).toEqual([expect.objectContaining(row)]);
});

it('[AC-B1-15a#19] readonly can read all columns but cannot insert, update, or delete', async () => {
  await ready(h.app);
  const row = await request(h.app);
  expect(await sqlState(insert(h.app, row))).toBe('no error');
  expect(
    (await sql`SELECT * FROM app.deletion_requests WHERE id = ${row['id']}`.execute(h.readonly))
      .rows,
  ).toEqual([expect.objectContaining(row)]);
  expect(await sqlState(insert(h.readonly, await request(h.app)))).toBe('42501');
  for (const column of [...IMMUTABLE_COLUMNS, ...UPDATE_COLUMNS]) {
    expect(
      await sqlState(
        sql`UPDATE app.deletion_requests
        SET ${sql.ref(column)} = ${sql.ref(column)} WHERE id = ${row['id']}`.execute(h.readonly),
      ),
      column,
    ).toBe('42501');
  }
  expect(
    await sqlState(
      sql`DELETE FROM app.deletion_requests WHERE id = ${row['id']}`.execute(h.readonly),
    ),
  ).toBe('42501');
});

it('[AC-B1-15a#20] grants do not leak table-wide update or privileges to other runtime roles', async () => {
  await ready(h.app);
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
          await sql`SELECT has_table_privilege(
          ${role}, 'app.deletion_requests', ${privilege}) AS allowed`.execute(h.app)
        ).rows,
        `${role}/${privilege}`,
      ).toEqual([{ allowed }]);
    }
    for (const column of [...IMMUTABLE_COLUMNS, ...UPDATE_COLUMNS]) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
        const allowed =
          role === 'couli_app'
            ? ['SELECT', 'INSERT'].includes(privilege) ||
              (privilege === 'UPDATE' && UPDATE_COLUMNS.includes(column))
            : role === 'couli_readonly' && privilege === 'SELECT';
        expect(
          (
            await sql`SELECT has_column_privilege(
            ${role}, 'app.deletion_requests', ${column}, ${privilege}) AS allowed`.execute(h.app)
          ).rows,
          `${role}/${column}/${privilege}`,
        ).toEqual([{ allowed }]);
      }
    }
  }
});

it('[AC-B1-15a#21] permitted updates still enforce enums, field pairing and time boundaries', async () => {
  await ready(h.app);
  const row = await request(h.app);
  expect(await sqlState(insert(h.app, row))).toBe('no error');
  for (const changes of [
    { status: 'COOLING' },
    { status: 'cancelled' },
    { cancel_reason: 'user' },
    { cancelled_at: BEFORE },
    { status: 'done' },
    { processed_at: DEADLINE },
    { ...state('cancelled'), cancel_reason: 'system' },
    { ...state('cancelled'), cancelled_at: DEADLINE },
    { ...state('cancelled'), cancel_reason: 'negative_balance', cancelled_at: BEFORE },
    { ...state('done'), processed_at: BEFORE },
  ]) {
    expect(await sqlState(update(h.app, row['id'], changes)), JSON.stringify(changes)).toBe(
      '23514',
    );
  }
  expect(
    (
      await sql`SELECT status, cancel_reason, cancelled_at, processed_at
      FROM app.deletion_requests WHERE id = ${row['id']}`.execute(h.app)
    ).rows,
  ).toEqual([state('cooling')]);
});
