// B1-13b §9.3: schema constraints, not the later verification/deletion service workflows.
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  HASH,
  LATER,
  OTHER_HASH,
  PRIVATE_COLUMNS,
  cleared,
  close,
  insert,
  open,
  person,
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

it('[AC-B1-13b#5] realname accepts exactly none, verified and failed with legal shapes', async () => {
  await ready(h.app, 'realname');
  for (const status of ['none', 'verified', 'failed']) {
    const row = await realname(
      h.app,
      status === 'verified' ? {} : { ...cleared(), status, provider: null, verified_at: null },
    );
    expect(await sqlState(insert(h.app, 'realname', row)), status).toBe('no error');
    const stored = await sql`SELECT * FROM app.realname WHERE id = ${row['id']}`.execute(h.app);
    expect(stored.rows).toEqual([expect.objectContaining({ ...row, row_version: 0 })]);
  }
  for (const status of ['', 'pending', 'VERIFIED']) {
    expect(
      await sqlState(
        insert(
          h.app,
          'realname',
          await realname(h.app, {
            ...cleared(),
            status,
          }),
        ),
      ),
    ).toBe('23514');
  }
});

it('[AC-B1-13b#6] verified requires every cipher, HMAC, provider and verification time', async () => {
  await ready(h.app, 'realname');
  for (const field of [...PRIVATE_COLUMNS, 'provider', 'verified_at']) {
    expect(
      await sqlState(
        insert(
          h.app,
          'realname',
          await realname(h.app, {
            [field]: null,
          }),
        ),
      ),
      field,
    ).toBe('23514');
  }
});

it('[AC-B1-13b#7] none and failed cannot retain any name, ID, birth cipher or ID HMAC', async () => {
  await ready(h.app, 'realname');
  for (const status of ['none', 'failed']) {
    for (const field of PRIVATE_COLUMNS) {
      expect(
        await sqlState(
          insert(
            h.app,
            'realname',
            await realname(h.app, {
              ...cleared(),
              status,
              [field]: verified()[field],
            }),
          ),
        ),
        `${status}/${field}`,
      ).toBe('23514');
    }
  }
});

it('[AC-B1-13b#8] ID HMAC is lowercase hex64 and a supplied provider cannot be blank', async () => {
  await ready(h.app, 'realname');
  for (const id_no_hmac of ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'A'.repeat(64)]) {
    expect(await sqlState(insert(h.app, 'realname', await realname(h.app, { id_no_hmac })))).toBe(
      '23514',
    );
  }
  for (const provider of ['', '   ', '\t\n']) {
    for (const state of [verified(), cleared()]) {
      expect(
        await sqlState(
          insert(
            h.app,
            'realname',
            await realname(h.app, {
              ...state,
              provider,
            }),
          ),
        ),
      ).toBe('23514');
    }
  }
});

it('[AC-B1-13b#9] one realname per app/user, and globally unique record ID', async () => {
  await ready(h.app, 'realname');
  const first = await realname(h.app);
  expect(await sqlState(insert(h.app, 'realname', first))).toBe('no error');
  expect(
    await sqlState(
      insert(h.app, 'realname', {
        ...first,
        id: randomUUID(),
        ...cleared(),
      }),
    ),
  ).toBe('23505');
  expect(
    await sqlState(
      insert(h.app, 'realname', {
        ...(await realname(h.app)),
        id: first['id'],
      }),
    ),
  ).toBe('23505');
});

it('[AC-B1-13b#10] verified HMAC uniqueness is scoped to app and released by anonymization', async () => {
  await ready(h.app, 'realname');
  const owner = await person(h.app);
  const other = await person(h.app, owner.app_id);
  const first = { id: randomUUID(), ...owner, ...verified() };
  const second = { id: randomUUID(), ...other, ...cleared(), status: 'failed' };
  expect(await sqlState(insert(h.app, 'realname', first))).toBe('no error');
  expect(await sqlState(insert(h.app, 'realname', { ...second, ...verified() }))).toBe('23505');
  expect(await sqlState(insert(h.app, 'realname', second))).toBe('no error');
  expect(await sqlState(update(h.app, second.id, verified()))).toBe('23505');
  expect(await sqlState(insert(h.app, 'realname', await realname(h.app)))).toBe('no error');
  expect(await sqlState(update(h.app, first.id, cleared()))).toBe('no error');
  expect(await sqlState(update(h.app, second.id, verified()))).toBe('no error');
  const stored = await sql`SELECT user_id, status, id_no_hmac FROM app.realname
    WHERE app_id = ${owner.app_id} ORDER BY status`.execute(h.app);
  expect(stored.rows).toEqual([
    { user_id: owner.user_id, status: 'none', id_no_hmac: null },
    { user_id: other.user_id, status: 'verified', id_no_hmac: HASH },
  ]);
});

it('[AC-B1-13b#11] realname rejects missing users and a user belonging to another app', async () => {
  await ready(h.app, 'realname');
  const row = await realname(h.app);
  expect(await sqlState(insert(h.app, 'realname', { ...row, user_id: randomUUID() }))).toBe(
    '23503',
  );
  expect(
    await sqlState(insert(h.app, 'realname', { ...row, app_id: `foreign_${randomUUID()}` })),
  ).toBe('23503');
});

it('[AC-B1-13b#12] required realname columns reject null and status has no implicit value', async () => {
  await ready(h.app, 'realname');
  for (const field of [
    'id',
    'app_id',
    'user_id',
    'status',
    'row_version',
    'created_at',
    'updated_at',
  ]) {
    expect(
      await sqlState(
        insert(
          h.app,
          'realname',
          await realname(h.app, {
            [field]: null,
          }),
        ),
      ),
      field,
    ).toBe('23502');
  }
  const row = await realname(h.app, cleared());
  delete row['status'];
  expect(await sqlState(insert(h.app, 'realname', row))).toBe('23502');
});

it('[AC-B1-13b#13] deleted identities support phone, device, both, and repeated phone changes', async () => {
  await ready(h.app, 'deleted_identities');
  const appId = `deleted_${randomUUID()}`;
  const rows = [
    tombstone({ app_id: appId }),
    tombstone({ app_id: appId, phone_hmac: null, device_hash: OTHER_HASH }),
    tombstone({ app_id: appId, device_hash: OTHER_HASH }),
    tombstone({ app_id: appId, reason: 'phone_changed' }),
    tombstone({ app_id: appId, reason: 'phone_changed' }),
  ];
  for (const row of rows)
    expect(await sqlState(insert(h.app, 'deleted_identities', row))).toBe('no error');
  const stored = await sql<{ id: bigint }>`SELECT * FROM app.deleted_identities
    WHERE app_id = ${appId} ORDER BY id`.execute(h.app);
  expect(stored.rows).toHaveLength(5);
  expect(new Set(stored.rows.map((row) => row.id)).size).toBe(5);
  for (const row of stored.rows) expect(typeof row.id).toBe('bigint');
  expect(stored.rows).toEqual(rows.map((row) => expect.objectContaining(row)));
});

it('[AC-B1-13b#14] tombstones require an identifier and phone_changed permits only a phone', async () => {
  await ready(h.app, 'deleted_identities');
  for (const values of [
    { phone_hmac: null, device_hash: null },
    { reason: 'phone_changed', device_hash: OTHER_HASH },
    { reason: 'phone_changed', phone_hmac: null, device_hash: OTHER_HASH },
    { reason: 'phone_changed', phone_hmac: null, device_hash: null },
  ])
    expect(await sqlState(insert(h.app, 'deleted_identities', tombstone(values)))).toBe('23514');
});

it('[AC-B1-13b#15] tombstone reasons and both hash formats are constrained', async () => {
  await ready(h.app, 'deleted_identities');
  for (const reason of ['', 'deleted', 'ACCOUNT_DELETED']) {
    expect(await sqlState(insert(h.app, 'deleted_identities', tombstone({ reason })))).toBe(
      '23514',
    );
  }
  for (const field of ['phone_hmac', 'device_hash']) {
    for (const value of ['', 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64), 'A'.repeat(64)]) {
      expect(
        await sqlState(insert(h.app, 'deleted_identities', tombstone({ [field]: value }))),
      ).toBe('23514');
    }
  }
});

it('[AC-B1-13b#16] expiry must follow deletion; the database does not hard-code 180 days', async () => {
  await ready(h.app, 'deleted_identities');
  for (const expire_at of [AT, new Date('2026-10-16T00:00:00.000Z')]) {
    expect(await sqlState(insert(h.app, 'deleted_identities', tombstone({ expire_at })))).toBe(
      '23514',
    );
  }
  for (const expire_at of [
    new Date('2026-10-17T00:00:00.001Z'),
    LATER,
    new Date('2027-10-17T00:00:00.000Z'),
  ]) {
    expect(await sqlState(insert(h.app, 'deleted_identities', tombstone({ expire_at })))).toBe(
      'no error',
    );
  }
  for (const field of ['app_id', 'reason', 'deleted_at', 'expire_at', 'created_at']) {
    expect(await sqlState(insert(h.app, 'deleted_identities', tombstone({ [field]: null })))).toBe(
      '23502',
    );
  }
  for (const field of ['deleted_at', 'expire_at']) {
    const row = tombstone();
    delete row[field];
    expect(await sqlState(insert(h.app, 'deleted_identities', row))).toBe('23502');
  }
});
