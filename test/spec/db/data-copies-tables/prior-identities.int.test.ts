// Isolated store of identities replaced by a real-name correction: 04 §3.2 实名更正旧身份;
// BR-ID-25 旧身份留存, BR-ID-28; 任务书 §9 ⑤⑥. Insert-only for couli_app, unreadable to every
// runtime role (the viewing permission and endpoint are a separate task).
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  COLUMN_PRIVILEGES,
  CORRECTED,
  PRIOR,
  PRIOR_COLUMNS,
  ROLES,
  TABLE_PRIVILEGES,
  close,
  columnAllowed,
  constraints,
  expectedShape,
  insert,
  open,
  person,
  prior,
  ready,
  shape,
  sqlState,
  tableAllowed,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = open(await createTestDatabase());
});
afterAll(async () => {
  await close(h);
});

it('[AC-B1-27d#19] columns are exactly the specified ones, all required, with only created_at defaulted', async () => {
  await ready(h.app, PRIOR);
  expect(await shape(h.app, PRIOR)).toEqual(
    expectedShape([
      ['app_id', 'text', false, null],
      ['user_id', 'uuid', false, null],
      ['name_cipher', 'bytea', false, null],
      ['id_no_cipher', 'bytea', false, null],
      ['id_no_hmac', 'text', false, null],
      ['verified_at', 'timestamptz', false, null],
      ['corrected_at', 'timestamptz', false, null],
      ['created_at', 'timestamptz', false, 'now()'],
    ]),
  );
});

it('[AC-B1-27d#20] the user foreign key is tenant-qualified and never cascades', async () => {
  await ready(h.app, PRIOR);
  const foreign = (await constraints(h.app, PRIOR)).filter((c) => c.kind === 'f');
  expect(foreign).toHaveLength(1);
  expect(foreign[0]).toMatchObject({
    keys: ['app_id', 'user_id'],
    target: 'app.users',
    target_keys: ['app_id', 'id'],
    validated: true,
  });
  expect(['a', 'r']).toContain(foreign[0]?.on_update);
  expect(['a', 'r']).toContain(foreign[0]?.on_delete);
  const row = await prior(h.app);
  expect(await sqlState(insert(h.app, PRIOR, { ...row, user_id: randomUUID() }))).toBe('23503');
  const stranger = await person(h.app);
  expect(await sqlState(insert(h.app, PRIOR, { ...row, user_id: stranger.user_id }))).toBe('23503');
  expect(await sqlState(insert(h.app, PRIOR, row))).toBe('no error');
});

it('[AC-B1-27d#21] every column rejects null; only created_at may be omitted', async () => {
  await ready(h.app, PRIOR);
  for (const column of PRIOR_COLUMNS) {
    expect(
      await sqlState(insert(h.app, PRIOR, await prior(h.app, { [column]: null }))),
      column,
    ).toBe('23502');
  }
  for (const column of PRIOR_COLUMNS.filter((c) => c !== 'created_at')) {
    const row = await prior(h.app);
    delete row[column];
    expect(await sqlState(insert(h.app, PRIOR, row)), column).toBe('23502');
  }
  expect(await sqlState(insert(h.app, PRIOR, await prior(h.app)))).toBe('no error');
});

it('[AC-B1-27d#22] a user may accumulate several prior identities over successive corrections', async () => {
  await ready(h.app, PRIOR);
  const first = await prior(h.app);
  expect(await sqlState(insert(h.app, PRIOR, first))).toBe('no error');
  const later = new Date(CORRECTED.getTime() + 86_400_000);
  expect(await sqlState(insert(h.app, PRIOR, { ...first, corrected_at: later }))).toBe('no error');
});

it('[AC-B1-27d#23] couli_app can only insert: no read-back, update, delete or truncate', async () => {
  await ready(h.app, PRIOR);
  const row = await prior(h.app);
  expect(await sqlState(insert(h.app, PRIOR, row))).toBe('no error');
  const names = Object.keys(row);
  // RETURNING needs SELECT, so even the inserting session cannot read the row back.
  expect(
    await sqlState(
      sql`INSERT INTO app.realname_prior_identities
        (${sql.join(names.map((name) => sql.ref(name)))})
        VALUES (${sql.join(names.map((name) => row[name]))}) RETURNING user_id`.execute(h.app),
    ),
  ).toBe('42501');
  expect(
    await sqlState(sql`SELECT count(*) FROM app.realname_prior_identities`.execute(h.app)),
  ).toBe('42501');
  for (const column of PRIOR_COLUMNS) {
    expect(
      await sqlState(
        sql`UPDATE app.realname_prior_identities
          SET ${sql.ref(column)} = ${row[column] ?? null}`.execute(h.app),
      ),
      column,
    ).toBe('42501');
  }
  expect(await sqlState(sql`DELETE FROM app.realname_prior_identities`.execute(h.app))).toBe(
    '42501',
  );
  expect(await sqlState(sql`TRUNCATE app.realname_prior_identities`.execute(h.app))).toBe('42501');
});

it('[AC-B1-27d#24] privileges: couli_app INSERT only; every other runtime role has nothing', async () => {
  await ready(h.app, PRIOR);
  for (const role of ROLES) {
    for (const privilege of TABLE_PRIVILEGES) {
      expect(await tableAllowed(h.app, role, PRIOR, privilege), `${role}/${privilege}`).toBe(
        role === 'couli_app' && privilege === 'INSERT',
      );
    }
    for (const column of PRIOR_COLUMNS) {
      for (const privilege of COLUMN_PRIVILEGES) {
        expect(
          await columnAllowed(h.app, role, PRIOR, column, privilege),
          `${role}/${column}/${privilege}`,
        ).toBe(role === 'couli_app' && privilege === 'INSERT');
      }
    }
  }
  expect(
    await sqlState(sql`SELECT user_id FROM app.realname_prior_identities`.execute(h.readonly)),
  ).toBe('42501');
  expect(await sqlState(insert(h.readonly, PRIOR, await prior(h.app)))).toBe('42501');
});
