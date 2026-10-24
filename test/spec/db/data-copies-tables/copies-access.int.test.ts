// 任务书 §9 ④: couli_app reads and inserts, updates only the lifecycle columns, never deletes.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  COLUMN_PRIVILEGES,
  COPIES,
  COPY_IMMUTABLE_COLUMNS,
  COPY_UPDATE_COLUMNS,
  DELIVERED,
  EXPIRES,
  GENERATED,
  ROLES,
  TABLE_PRIVILEGES,
  close,
  columnAllowed,
  copy,
  insert,
  open,
  ready,
  sqlState,
  stored,
  tableAllowed,
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

it('[AC-B1-27d#15] app inserts, reads and walks a request through every lifecycle column', async () => {
  await ready(h.app, COPIES);
  const row = await copy(h.app);
  expect(await sqlState(insert(h.app, COPIES, row))).toBe('no error');
  expect(await stored(h.app, row['id'])).toEqual([
    expect.objectContaining({ ...row, row_version: 0 }),
  ]);
  const steps = [
    { status: 'running', row_version: 1, updated_at: GENERATED },
    {
      status: 'ready',
      object_key: 'copies/fixture.zip',
      generated_at: GENERATED,
      expires_at: EXPIRES,
      row_version: 2,
      updated_at: GENERATED,
    },
    { status: 'delivered', delivered_at: DELIVERED, row_version: 3, updated_at: DELIVERED },
    { status: 'expired', object_key: null, row_version: 4, updated_at: EXPIRES },
  ];
  let expected = { ...row };
  for (const step of steps) {
    expect(await sqlState(update(h.app, row['id'], step)), step.status).toBe('no error');
    expected = { ...expected, ...step };
    expect(await stored(h.app, row['id'])).toEqual([expect.objectContaining(expected)]);
  }
  const failed = await copy(h.app, { status: 'running' });
  expect(await sqlState(insert(h.app, COPIES, failed))).toBe('no error');
  const failure = { status: 'failed', failure_reason: 'generation failed', row_version: 1 };
  expect(await sqlState(update(h.app, failed['id'], failure))).toBe('no error');
  expect(await stored(h.app, failed['id'])).toEqual([
    expect.objectContaining({ ...failed, ...failure }),
  ]);
});

it('[AC-B1-27d#16] app cannot update identity, delivery, retry_of, due_at or created_at, nor delete', async () => {
  await ready(h.app, COPIES);
  const row = await copy(h.app);
  expect(await sqlState(insert(h.app, COPIES, row))).toBe('no error');
  for (const column of COPY_IMMUTABLE_COLUMNS) {
    // A no-op assignment is otherwise valid, isolating the privilege check from constraints.
    expect(
      await sqlState(
        sql`UPDATE app.personal_data_copies
        SET ${sql.ref(column)} = ${sql.ref(column)} WHERE id = ${row['id']}`.execute(h.app),
      ),
      column,
    ).toBe('42501');
  }
  expect(
    await sqlState(
      sql`DELETE FROM app.personal_data_copies WHERE id = ${row['id']}`.execute(h.app),
    ),
  ).toBe('42501');
  expect(await sqlState(sql`TRUNCATE app.personal_data_copies`.execute(h.app))).toBe('42501');
  expect(await stored(h.app, row['id'])).toEqual([
    expect.objectContaining({ ...row, row_version: 0 }),
  ]);
});

it('[AC-B1-27d#17] couli_app holds exactly SELECT, INSERT and the column UPDATEs; no table-wide UPDATE or DELETE', async () => {
  await ready(h.app, COPIES);
  for (const privilege of TABLE_PRIVILEGES) {
    expect(await tableAllowed(h.app, 'couli_app', COPIES, privilege), privilege).toBe(
      privilege === 'SELECT' || privilege === 'INSERT',
    );
  }
  for (const column of [...COPY_IMMUTABLE_COLUMNS, ...COPY_UPDATE_COLUMNS]) {
    for (const privilege of COLUMN_PRIVILEGES) {
      const allowed =
        privilege === 'SELECT' ||
        privilege === 'INSERT' ||
        (privilege === 'UPDATE' && COPY_UPDATE_COLUMNS.includes(column));
      expect(
        await columnAllowed(h.app, 'couli_app', COPIES, column, privilege),
        `${column}/${privilege}`,
      ).toBe(allowed);
    }
  }
});

it('[AC-B1-27d#18] other runtime roles can neither write nor alter requests', async () => {
  await ready(h.app, COPIES);
  // Read access for couli_readonly is not specified here, so only write privileges are pinned;
  // couli_payout and couli_maint get nothing at all.
  for (const role of ROLES.filter((r) => r !== 'couli_app')) {
    for (const privilege of TABLE_PRIVILEGES) {
      if (role === 'couli_readonly' && privilege === 'SELECT') continue;
      expect(await tableAllowed(h.app, role, COPIES, privilege), `${role}/${privilege}`).toBe(
        false,
      );
    }
    for (const column of [...COPY_IMMUTABLE_COLUMNS, ...COPY_UPDATE_COLUMNS]) {
      for (const privilege of COLUMN_PRIVILEGES) {
        if (role === 'couli_readonly' && privilege === 'SELECT') continue;
        expect(
          await columnAllowed(h.app, role, COPIES, column, privilege),
          `${role}/${column}/${privilege}`,
        ).toBe(false);
      }
    }
  }
  const row = await copy(h.app);
  expect(await sqlState(insert(h.app, COPIES, row))).toBe('no error');
  expect(await sqlState(insert(h.readonly, COPIES, await copy(h.app)))).toBe('42501');
  expect(await sqlState(update(h.readonly, row['id'], { status: 'running' }))).toBe('42501');
  expect(
    await sqlState(
      sql`DELETE FROM app.personal_data_copies WHERE id = ${row['id']}`.execute(h.readonly),
    ),
  ).toBe('42501');
});
