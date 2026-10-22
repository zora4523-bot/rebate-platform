// B1-15o §13 / D10-153: one-way detachment preserves the existing rewrite guards.
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  HASH,
  close,
  fixture,
  insert,
  open,
  read,
  ready,
  sqlState,
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

it('[AC-B1-15o#14] couli_app detaches a session and writes its valid user hash in one UPDATE', async () => {
  await ready(h.app, 'agent_sessions');
  const row = await insert(h.app, 'agent_sessions', await fixture(h.app, 'agent_sessions'));
  expect(row['user_id']).not.toBeNull();
  expect(row['user_hash']).toBeNull();

  expect(
    await sqlState(update(h.app, 'agent_sessions', row['id'], { user_id: null, user_hash: HASH })),
  ).toBe('no error');
  expect(await read(h.app, 'agent_sessions', row['id'])).toEqual({
    ...row,
    user_id: null,
    user_hash: HASH,
  });
});

it('[AC-B1-15o#15] incomplete detachment, invalid hashes, reassignment, hash rewriting and card_seq rollback are rejected', async () => {
  await ready(h.app, 'agent_sessions');
  const row = await insert(h.app, 'agent_sessions', {
    ...(await fixture(h.app, 'agent_sessions')),
    card_seq: 2,
  });
  // A real second user in the same tenant avoids mistaking an FK error for the owner guard.
  const otherUser = await insert(h.app, 'users', {
    id: randomUUID(),
    app_id: row['app_id'],
    nickname: 'fixture',
    avatar: 'fixture',
    invite_code: randomUUID(),
    attr_code: randomUUID(),
    level: 'L1',
    register_method: 'phone',
  });

  // (a) Clearing the association alone must hit the rewrite guard, not missing grants.
  expect(await sqlState(update(h.app, 'agent_sessions', row['id'], { user_id: null }))).toBe(
    '23001',
  );
  expect(await read(h.app, 'agent_sessions', row['id'])).toEqual(row);

  // (b) Either the BEFORE trigger (restrict_violation) or the hash CHECK may reject it.
  expect(['23001', '23514']).toContain(
    await sqlState(
      update(h.app, 'agent_sessions', row['id'], { user_id: null, user_hash: 'g'.repeat(64) }),
    ),
  );
  expect(await read(h.app, 'agent_sessions', row['id'])).toEqual(row);

  // (c) Supplying a valid hash must not permit reassignment to another non-NULL user.
  expect(
    await sqlState(
      update(h.app, 'agent_sessions', row['id'], { user_id: otherUser['id'], user_hash: HASH }),
    ),
  ).toBe('23001');
  expect(await read(h.app, 'agent_sessions', row['id'])).toEqual(row);

  // (e) card_seq already has UPDATE permission; 2 -> 1 is rejected by the original trigger.
  // The detachment exception must not bypass this guard in the same statement either.
  for (const values of [{ card_seq: 1 }, { card_seq: 1, user_id: null, user_hash: HASH }]) {
    expect(await sqlState(update(h.app, 'agent_sessions', row['id'], values))).toBe('23001');
    expect(await read(h.app, 'agent_sessions', row['id'])).toEqual(row);
  }

  // Reach the detached state through the business role, so a denied setup is an assertion failure.
  expect(
    await sqlState(update(h.app, 'agent_sessions', row['id'], { user_id: null, user_hash: HASH })),
  ).toBe('no error');
  const detached = { ...row, user_id: null, user_hash: HASH };
  expect(await read(h.app, 'agent_sessions', row['id'])).toEqual(detached);

  // (d) Once detached, even another valid hash cannot replace the recorded one.
  expect(
    await sqlState(update(h.app, 'agent_sessions', row['id'], { user_hash: 'f'.repeat(64) })),
  ).toBe('23001');
  expect(await read(h.app, 'agent_sessions', row['id'])).toEqual(detached);
});
