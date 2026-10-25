// Storage rules of app.personal_data_copies only; the request workflow belongs to B1-27a/c/h.
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  CLOSED_STATUSES,
  COPIES,
  DELIVERED,
  DELIVERIES,
  DUE,
  EXPIRES,
  GENERATED,
  OPEN_STATUSES,
  STATUSES,
  admin,
  close,
  copy,
  insert,
  open,
  person,
  ready,
  sibling,
  sqlState,
  stored,
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

it('[AC-B1-27d#5] delivery accepts exactly the two contract values', async () => {
  await ready(h.app, COPIES);
  for (const delivery of DELIVERIES) {
    const row = await copy(h.app, { delivery });
    expect(await sqlState(insert(h.app, COPIES, row)), delivery).toBe('no error');
    expect(await stored(h.app, row['id'])).toEqual([
      expect.objectContaining({ ...row, row_version: 0 }),
    ]);
  }
  for (const delivery of ['', 'IN_APP_SMS', 'In_app_sms', 'in-app-sms', 'sms', 'wecom', 'email']) {
    expect(await sqlState(insert(h.app, COPIES, await copy(h.app, { delivery }))), delivery).toBe(
      '23514',
    );
  }
});

it('[AC-B1-27d#6] status accepts exactly the seven contract values', async () => {
  await ready(h.app, COPIES);
  for (const status of STATUSES) {
    const row = await copy(h.app, { status });
    expect(await sqlState(insert(h.app, COPIES, row)), status).toBe('no error');
    expect(await stored(h.app, row['id'])).toEqual([expect.objectContaining({ status })]);
  }
  for (const status of ['', 'PENDING', 'Ready', 'done', 'processing', 'generated', 'canceled']) {
    expect(await sqlState(insert(h.app, COPIES, await copy(h.app, { status }))), status).toBe(
      '23514',
    );
  }
});

it('[AC-B1-27d#7] every column round-trips; optional columns accept null', async () => {
  await ready(h.app, COPIES);
  const minimal = await copy(h.app);
  expect(await sqlState(insert(h.app, COPIES, minimal))).toBe('no error');
  expect(await stored(h.app, minimal['id'])).toEqual([
    expect.objectContaining({ ...minimal, row_version: 0 }),
  ]);
  const failed = await copy(h.app, { status: 'failed', failure_reason: 'generation failed' });
  expect(await sqlState(insert(h.app, COPIES, failed))).toBe('no error');
  const full = sibling(failed, {
    status: 'delivered',
    delivery: 'wecom_session',
    retry_of: failed['id'],
    object_key: `copies/${randomUUID()}.zip`,
    generated_at: GENERATED,
    delivered_at: DELIVERED,
    expires_at: EXPIRES,
    failure_reason: null,
  });
  expect(await sqlState(insert(h.app, COPIES, full))).toBe('no error');
  expect(await stored(h.app, full['id'])).toEqual([
    expect.objectContaining({ ...full, row_version: 0 }),
  ]);
});

it('[AC-B1-27d#8] required columns reject null and have no fallback when omitted', async () => {
  await ready(h.app, COPIES);
  for (const column of [
    'id',
    'app_id',
    'user_id',
    'requested_by',
    'delivery',
    'status',
    'due_at',
    'row_version',
    'created_at',
    'updated_at',
  ]) {
    expect(
      await sqlState(insert(h.app, COPIES, await copy(h.app, { [column]: null }))),
      column,
    ).toBe('23502');
  }
  for (const column of [
    'id',
    'app_id',
    'user_id',
    'requested_by',
    'delivery',
    'status',
    'due_at',
  ]) {
    const row = await copy(h.app);
    delete row[column];
    expect(await sqlState(insert(h.app, COPIES, row)), column).toBe('23502');
  }
});

it('[AC-B1-27d#9] a user has at most one unfinished request across pending, running and ready', async () => {
  await ready(h.app, COPIES);
  for (const status of OPEN_STATUSES) {
    const first = await copy(h.app, { status });
    expect(await sqlState(insert(h.app, COPIES, first))).toBe('no error');
    for (const second of OPEN_STATUSES) {
      expect(
        await sqlState(insert(h.app, COPIES, sibling(first, { status: second }))),
        `${status}/${second}`,
      ).toBe('23505');
    }
    // Both delivery modes share the slot.
    expect(
      await sqlState(
        insert(h.app, COPIES, sibling(first, { status: 'pending', delivery: 'wecom_session' })),
      ),
    ).toBe('23505');
    // Finished history coexists with the open request.
    for (const closed of CLOSED_STATUSES) {
      expect(
        await sqlState(insert(h.app, COPIES, sibling(first, { status: closed }))),
        `${status}/${closed}`,
      ).toBe('no error');
    }
    // Another user of the same app is independent.
    const other = await person(h.app, first['app_id'] as string);
    expect(await sqlState(insert(h.app, COPIES, sibling(first, other)))).toBe('no error');
  }
});

it('[AC-B1-27d#10] finished history repeats, and finishing the open request releases its slot', async () => {
  await ready(h.app, COPIES);
  for (const closed of CLOSED_STATUSES) {
    const row = await copy(h.app, { status: closed });
    expect(await sqlState(insert(h.app, COPIES, row))).toBe('no error');
    expect(await sqlState(insert(h.app, COPIES, sibling(row)))).toBe('no error');
    const current = sibling(row, { status: 'pending' });
    expect(await sqlState(insert(h.app, COPIES, current))).toBe('no error');
    for (const status of ['running', 'ready', closed]) {
      expect(await sqlState(update(h.app, current['id'], { status })), status).toBe('no error');
    }
    expect(await sqlState(insert(h.app, COPIES, sibling(row, { status: 'pending' })))).toBe(
      'no error',
    );
  }
});

it('[AC-B1-27d#11] reopening a finished row cannot create a second unfinished request', async () => {
  await ready(h.app, COPIES);
  const history = await copy(h.app, { status: 'failed' });
  expect(await sqlState(insert(h.app, COPIES, history))).toBe('no error');
  expect(await sqlState(insert(h.app, COPIES, sibling(history, { status: 'pending' })))).toBe(
    'no error',
  );
  for (const status of OPEN_STATUSES) {
    expect(await sqlState(update(h.app, history['id'], { status })), status).toBe('23505');
  }
  expect(await stored(h.app, history['id'])).toEqual([
    expect.objectContaining({ status: 'failed' }),
  ]);
});

it('[AC-B1-27d#12] concurrent registrations yield one committed row and one unique violation', async () => {
  await ready(h.app, COPIES);
  const first = await copy(h.app);
  // Autocommit statements on separate pool connections; no transaction waits on test code.
  const outcomes = await Promise.all([
    sqlState(insert(h.app, COPIES, first)),
    sqlState(insert(h.app, COPIES, sibling(first))),
  ]);
  expect(outcomes.sort()).toEqual(['23505', 'no error']);
  const rows = await sql`SELECT status FROM app.personal_data_copies
    WHERE app_id = ${first['app_id']} AND user_id = ${first['user_id']}`.execute(h.app);
  expect(rows.rows).toEqual([{ status: 'pending' }]);
});

it('[AC-B1-27d#13] user and registrant must exist in the same app; ids are globally unique', async () => {
  await ready(h.app, COPIES);
  const row = await copy(h.app);
  expect(await sqlState(insert(h.app, COPIES, { ...row, user_id: randomUUID() }))).toBe('23503');
  expect(await sqlState(insert(h.app, COPIES, { ...row, requested_by: randomUUID() }))).toBe(
    '23503',
  );
  const foreignApp = `other_${randomUUID()}`;
  const outsider = await admin(h.app, foreignApp);
  expect(await sqlState(insert(h.app, COPIES, { ...row, requested_by: outsider }))).toBe('23503');
  const stranger = await person(h.app, foreignApp);
  expect(await sqlState(insert(h.app, COPIES, { ...row, user_id: stranger.user_id }))).toBe(
    '23503',
  );
  expect(await sqlState(insert(h.app, COPIES, row))).toBe('no error');
  const other = await copy(h.app);
  expect(await sqlState(insert(h.app, COPIES, { ...other, id: row['id'] }))).toBe('23505');
  expect(await sqlState(insert(h.app, COPIES, other))).toBe('no error');
});

it('[AC-B1-27d#14] retry_of points at an existing request of the same app', async () => {
  await ready(h.app, COPIES);
  const failed = await copy(h.app, { status: 'failed', failure_reason: 'generation failed' });
  expect(await sqlState(insert(h.app, COPIES, failed))).toBe('no error');
  expect(await sqlState(insert(h.app, COPIES, sibling(failed, { retry_of: randomUUID() })))).toBe(
    '23503',
  );
  // A request of another app is not a valid predecessor even though its id exists.
  const elsewhere = await copy(h.app, { status: 'failed' });
  expect(await sqlState(insert(h.app, COPIES, elsewhere))).toBe('no error');
  expect(
    await sqlState(insert(h.app, COPIES, sibling(failed, { retry_of: elsewhere['id'] }))),
  ).toBe('23503');
  const retry = sibling(failed, { retry_of: failed['id'], due_at: DUE });
  expect(await sqlState(insert(h.app, COPIES, retry))).toBe('no error');
  expect(await stored(h.app, retry['id'])).toEqual([
    expect.objectContaining({ retry_of: failed['id'], due_at: DUE }),
  ]);
});
