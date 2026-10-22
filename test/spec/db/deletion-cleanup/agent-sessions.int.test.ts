// B1-15o §9.2 #2: storage of a supplied hash only; hashing/purge belongs to the agent task.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  HASH,
  close,
  columns,
  fixture,
  insert,
  open,
  read,
  ready,
  sqlState,
  update,
  userForeignKey,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = open(await createTestDatabase());
});
afterAll(async () => {
  await close(h);
});

it('[AC-B1-15o#4] user_hash is nullable text without a default or index; the original user column and FK remain', async () => {
  await ready(h.app, 'agent_sessions');
  expect(await columns(h.app, 'agent_sessions')).toEqual(
    expect.arrayContaining([{ name: 'user_id', type: 'uuid', nullable: true, default: null }]),
  );
  await userForeignKey(h.app, 'agent_sessions');
  const indexes = await sql<{ definition: string }>`SELECT indexdef AS definition
    FROM pg_indexes WHERE schemaname = 'app' AND tablename = 'agent_sessions'`.execute(h.app);
  expect(indexes.rows.every((r) => !/\buser_hash\b/i.test(r.definition))).toBe(true);
});

it('[AC-B1-15o#5] existing insert shape defaults hash to null; app writes supplied lowercase hashes without changing ownership', async () => {
  await ready(h.app, 'agent_sessions');
  const row = await insert(h.app, 'agent_sessions', await fixture(h.app, 'agent_sessions'));
  expect(row['user_hash']).toBeNull();
  for (const user_hash of [HASH, 'f'.repeat(64), null]) {
    expect(await sqlState(update(h.app, 'agent_sessions', row['id'], { user_hash }))).toBe(
      'no error',
    );
    expect(await read(h.app, 'agent_sessions', row['id'])).toEqual({ ...row, user_hash });
  }
  const explicit = await insert(h.app, 'agent_sessions', {
    ...(await fixture(h.app, 'agent_sessions')),
    user_hash: HASH,
  });
  expect(explicit['user_hash']).toBe(HASH);
});

it('[AC-B1-15o#6] hash CHECK rejects raw identifiers, wrong length, case and non-hex characters on insert and update', async () => {
  await ready(h.app, 'agent_sessions');
  const values = await fixture(h.app, 'agent_sessions');
  const row = await insert(h.app, 'agent_sessions', { ...values, user_hash: HASH });
  const invalid = [
    '',
    values['user_id'],
    'a'.repeat(63),
    'a'.repeat(65),
    HASH.toUpperCase(),
    'g'.repeat(64),
    `${HASH}\n`,
    ` ${HASH}`,
  ];
  for (const user_hash of invalid) {
    const candidate = await fixture(h.app, 'agent_sessions');
    expect(
      await sqlState(insert(h.app, 'agent_sessions', { ...candidate, user_hash })),
      String(user_hash),
    ).toBe('23514');
    expect(
      await sqlState(update(h.app, 'agent_sessions', row['id'], { user_hash })),
      String(user_hash),
    ).toBe('23514');
    expect(await read(h.app, 'agent_sessions', row['id'])).toEqual(row);
  }
});
