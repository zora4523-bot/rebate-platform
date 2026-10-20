// Only deletion_requests storage rules; application workflow belongs to B1-15b/c/d.
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AFTER,
  APPLY,
  BEFORE,
  DEADLINE,
  close,
  insert,
  open,
  person,
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

it('[AC-B1-15a#4] accepts exactly the four contract statuses with legal companion fields', async () => {
  await ready(h.app);
  for (const status of ['cooling', 'processing', 'done', 'cancelled']) {
    const row = await request(h.app, state(status));
    expect(await sqlState(insert(h.app, row)), status).toBe('no error');
    const stored = await sql`SELECT * FROM app.deletion_requests WHERE id = ${row['id']}`.execute(
      h.app,
    );
    expect(stored.rows).toEqual([expect.objectContaining({ ...row, row_version: 0 })]);
  }
  for (const status of ['', 'pending', 'COOLING', 'Processing', 'DONE', 'CANCELLED']) {
    expect(await sqlState(insert(h.app, await request(h.app, state(status)))), status).toBe(
      '23514',
    );
  }
});

it('[AC-B1-15a#5] cancellation reasons accept contract values and reject aliases or casing changes', async () => {
  await ready(h.app);
  for (const [cancel_reason, cancelled_at] of [
    ['user', BEFORE],
    ['negative_balance', DEADLINE],
  ] as const) {
    const row = await request(h.app, { ...state('cancelled'), cancel_reason, cancelled_at });
    expect(await sqlState(insert(h.app, row))).toBe('no error');
    expect(
      (
        await sql`SELECT cancel_reason FROM app.deletion_requests WHERE id = ${row['id']}`.execute(
          h.app,
        )
      ).rows,
    ).toEqual([{ cancel_reason }]);
  }
  for (const cancel_reason of ['', 'system', 'USER', 'Negative_balance', 'negative-balance']) {
    expect(
      await sqlState(insert(h.app, await request(h.app, { ...state('cancelled'), cancel_reason }))),
      cancel_reason,
    ).toBe('23514');
  }
});

it('[AC-B1-15a#6] cancellation status requires both reason and timestamp, and other statuses forbid either', async () => {
  await ready(h.app);
  for (const missing of [
    { cancel_reason: null },
    { cancelled_at: null },
    { cancel_reason: null, cancelled_at: null },
  ]) {
    expect(
      await sqlState(insert(h.app, await request(h.app, { ...state('cancelled'), ...missing }))),
    ).toBe('23514');
  }
  for (const status of ['cooling', 'processing', 'done']) {
    for (const extra of [
      { cancel_reason: 'user' },
      { cancelled_at: BEFORE },
      { cancel_reason: 'user', cancelled_at: BEFORE },
    ]) {
      expect(
        await sqlState(insert(h.app, await request(h.app, { ...state(status), ...extra }))),
        `${status}/${Object.keys(extra).join(',')}`,
      ).toBe('23514');
    }
  }
});

it('[AC-B1-15a#7] processed_at denotes done, never entry into processing or cancellation', async () => {
  await ready(h.app);
  expect(
    await sqlState(insert(h.app, await request(h.app, { status: 'done', processed_at: null }))),
  ).toBe('23514');
  for (const status of ['cooling', 'processing', 'cancelled']) {
    expect(
      await sqlState(
        insert(h.app, await request(h.app, { ...state(status), processed_at: DEADLINE })),
      ),
      status,
    ).toBe('23514');
  }
  for (const processed_at of [BEFORE, DEADLINE, AFTER]) {
    expect(
      await sqlState(insert(h.app, await request(h.app, { ...state('done'), processed_at }))),
    ).toBe(processed_at === BEFORE ? '23514' : 'no error');
  }
});

it('[AC-B1-15a#8] cooling deadline must follow application time without hard-coding seven days', async () => {
  await ready(h.app);
  for (const cooling_until of [new Date('2026-09-29T09:59:59.000Z'), APPLY]) {
    expect(await sqlState(insert(h.app, await request(h.app, { cooling_until })))).toBe('23514');
  }
  for (const cooling_until of [
    new Date('2026-09-29T10:00:00.001Z'),
    DEADLINE,
    new Date('2026-10-07T10:00:00.000Z'),
  ]) {
    expect(await sqlState(insert(h.app, await request(h.app, { cooling_until })))).toBe('no error');
  }
});

it('[AC-B1-15a#9] user cancellation is strictly before deadline; negative-balance cancellation starts at deadline', async () => {
  await ready(h.app);
  for (const cancel_reason of ['user', 'negative_balance']) {
    for (const cancelled_at of [BEFORE, DEADLINE, AFTER]) {
      const allowed = cancel_reason === 'user' ? cancelled_at === BEFORE : cancelled_at !== BEFORE;
      expect(
        await sqlState(
          insert(
            h.app,
            await request(h.app, { ...state('cancelled'), cancel_reason, cancelled_at }),
          ),
        ),
        `${cancel_reason}/${cancelled_at.toISOString()}`,
      ).toBe(allowed ? 'no error' : '23514');
    }
  }
});

it('[AC-B1-15a#10] initial balance is nonnegative bigint fen and survives without precision loss', async () => {
  await ready(h.app);
  expect(await sqlState(insert(h.app, await request(h.app, { balance_snapshot_fen: -1n })))).toBe(
    '23514',
  );
  for (const balance_snapshot_fen of [0n, 2147483648n, 9007199254740993n]) {
    const row = await request(h.app, { balance_snapshot_fen });
    expect(await sqlState(insert(h.app, row))).toBe('no error');
    const stored = await sql`SELECT balance_snapshot_fen FROM app.deletion_requests
      WHERE id = ${row['id']}`.execute(h.app);
    expect(stored.rows).toEqual([{ balance_snapshot_fen }]);
  }
});

it('[AC-B1-15a#11] required columns reject null and application-supplied values have no fallback', async () => {
  await ready(h.app);
  for (const column of [
    'id',
    'app_id',
    'user_id',
    'status',
    'apply_at',
    'cooling_until',
    'balance_snapshot_fen',
    'row_version',
    'created_at',
    'updated_at',
  ]) {
    expect(await sqlState(insert(h.app, await request(h.app, { [column]: null }))), column).toBe(
      '23502',
    );
  }
  for (const column of [
    'id',
    'app_id',
    'user_id',
    'status',
    'apply_at',
    'cooling_until',
    'balance_snapshot_fen',
  ]) {
    const row = await request(h.app);
    delete row[column];
    expect(await sqlState(insert(h.app, row)), column).toBe('23502');
  }
});

it('[AC-B1-15a#12] one open request per app/user applies to both cooling and processing', async () => {
  await ready(h.app);
  for (const status of ['cooling', 'processing']) {
    const first = await request(h.app, state(status));
    expect(await sqlState(insert(h.app, first))).toBe('no error');
    for (const secondStatus of ['cooling', 'processing']) {
      expect(
        await sqlState(insert(h.app, { ...first, id: randomUUID(), ...state(secondStatus) })),
      ).toBe('23505');
    }
    // The same app can still have another user's request.
    const otherUser = await person(h.app, first['app_id'] as string);
    expect(await sqlState(insert(h.app, { ...first, id: randomUUID(), ...otherUser }))).toBe(
      'no error',
    );
  }
});

it('[AC-B1-15a#13] terminal history is repeatable and closing an open request releases its unique slot', async () => {
  await ready(h.app);
  for (const status of ['cancelled', 'done']) {
    const row = await request(h.app, state(status));
    for (let i = 0; i < 2; i += 1) {
      expect(await sqlState(insert(h.app, { ...row, id: randomUUID() }))).toBe('no error');
    }
    const current = { ...row, id: randomUUID(), ...state('cooling') };
    expect(await sqlState(insert(h.app, current))).toBe('no error');
    expect(await sqlState(update(h.app, current.id, state(status)))).toBe('no error');
    expect(await sqlState(insert(h.app, { ...current, id: randomUUID() }))).toBe('no error');
  }
});

it('[AC-B1-15a#14] updating historical rows cannot create a second open request', async () => {
  await ready(h.app);
  const history = await request(h.app, state('cancelled'));
  expect(await sqlState(insert(h.app, history))).toBe('no error');
  expect(await sqlState(insert(h.app, { ...history, id: randomUUID(), ...state('cooling') }))).toBe(
    'no error',
  );
  for (const status of ['cooling', 'processing']) {
    expect(await sqlState(update(h.app, history['id'], state(status)))).toBe('23505');
  }
});

it('[AC-B1-15a#15] concurrent applications yield one committed row and one unique violation', async () => {
  await ready(h.app);
  const first = await request(h.app);
  // Autocommit statements use separate pool connections; no transaction waits for test code.
  const outcomes = await Promise.all([
    sqlState(insert(h.app, first)),
    sqlState(insert(h.app, { ...first, id: randomUUID() })),
  ]);
  expect(outcomes.sort()).toEqual(['23505', 'no error']);
  const stored = await sql`SELECT status FROM app.deletion_requests
    WHERE app_id = ${first['app_id']} AND user_id = ${first['user_id']}`.execute(h.app);
  expect(stored.rows).toEqual([{ status: 'cooling' }]);
});

it('[AC-B1-15a#16] user FK rejects absent users and wrong apps; request IDs are globally unique', async () => {
  await ready(h.app);
  const row = await request(h.app);
  expect(await sqlState(insert(h.app, { ...row, user_id: randomUUID() }))).toBe('23503');
  expect(await sqlState(insert(h.app, { ...row, app_id: `other_${randomUUID()}` }))).toBe('23503');
  expect(await sqlState(insert(h.app, row))).toBe('no error');
  const other = await request(h.app);
  expect(await sqlState(insert(h.app, { ...other, id: row['id'] }))).toBe('23505');
  expect(await sqlState(insert(h.app, other))).toBe('no error');
});
