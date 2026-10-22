// B1-15o §9.2 #1: detach retained login logs, without changing the foreign key.
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  close,
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

it('[AC-B1-15o#1] login user_id is nullable and retains the tenant-qualified NO ACTION foreign key', async () => {
  await ready(h.app, 'login_logs');
  await userForeignKey(h.app, 'login_logs');
});

it('[AC-B1-15o#2] app can detach a log repeatedly while retaining every other field and other users logs', async () => {
  await ready(h.app, 'login_logs');
  const row = await insert(h.app, 'login_logs', await fixture(h.app, 'login_logs'));
  const other = await insert(h.app, 'login_logs', await fixture(h.app, 'login_logs'));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    expect(await sqlState(update(h.app, 'login_logs', row['id'], { user_id: null }))).toBe(
      'no error',
    );
    expect(await read(h.app, 'login_logs', row['id'])).toEqual({ ...row, user_id: null });
    expect(await read(h.app, 'login_logs', other['id'])).toEqual(other);
  }
});

it('[AC-B1-15o#3] null can be inserted but non-null users still require a matching tenant on insert and update', async () => {
  await ready(h.app, 'login_logs');
  const values = await fixture(h.app, 'login_logs');
  const detached = await insert(h.app, 'login_logs', { ...values, user_id: null });
  expect(detached).toMatchObject({ ...values, user_id: null });
  const foreignUser = await fixture(h.app, 'login_logs');
  for (const user_id of [randomUUID(), foreignUser['user_id']]) {
    expect(await sqlState(insert(h.app, 'login_logs', { ...values, user_id }))).toBe('23503');
    expect(await sqlState(update(h.app, 'login_logs', detached['id'], { user_id }))).toBe('23503');
  }
  expect(await read(h.app, 'login_logs', detached['id'])).toEqual(detached);
});
