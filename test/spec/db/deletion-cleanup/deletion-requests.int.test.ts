// B1-15o §9.2 #3: cleanup progress storage, not the Apple API retry workflow.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  CLEANED,
  DEADLINE,
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

it('[AC-B1-15o#7] cleanup columns have specified types and defaults; old insert shape remains valid', async () => {
  await ready(h.app, 'deletion_requests');
  const row = await insert(h.app, 'deletion_requests', await fixture(h.app, 'deletion_requests'));
  expect(row).toMatchObject({
    cleaned_at: null,
    apple_revoke_attempts: 0,
    apple_revoke_result: null,
  });
});

it('[AC-B1-15o#8] app stores all attempt boundaries and result values without implicitly finishing cleanup', async () => {
  await ready(h.app, 'deletion_requests');
  const values = await fixture(h.app, 'deletion_requests');
  const row = await insert(h.app, 'deletion_requests', values);
  for (const apple_revoke_attempts of [0, 1, 2, 3]) {
    for (const apple_revoke_result of [null, 'revoked', 'failed', 'not_applicable']) {
      const changes = { apple_revoke_attempts, apple_revoke_result };
      expect(await sqlState(update(h.app, 'deletion_requests', row['id'], changes))).toBe(
        'no error',
      );
      expect(await read(h.app, 'deletion_requests', row['id'])).toEqual({ ...row, ...changes });
      const inserted = await insert(h.app, 'deletion_requests', {
        ...(await fixture(h.app, 'deletion_requests')),
        ...changes,
      });
      expect(inserted).toMatchObject({ ...changes, cleaned_at: null });
    }
  }
});

it('[AC-B1-15o#9] CHECK and NOT NULL reject invalid attempt counts and result values on insert and update', async () => {
  await ready(h.app, 'deletion_requests');
  const row = await insert(h.app, 'deletion_requests', await fixture(h.app, 'deletion_requests'));
  const invalid: [Record<string, unknown>, string][] = [
    ...[-32768, -1, 4, 32767].map((apple_revoke_attempts): [Record<string, unknown>, string] => [
      { apple_revoke_attempts },
      '23514',
    ]),
    [{ apple_revoke_attempts: null }, '23502'],
    ...['', 'pending', 'success', 'REVOKED', 'Failed', 'not-applicable', 'failed '].map(
      (apple_revoke_result): [Record<string, unknown>, string] => [
        { apple_revoke_result },
        '23514',
      ],
    ),
  ];
  for (const [changes, code] of invalid) {
    expect(
      await sqlState(
        insert(h.app, 'deletion_requests', {
          ...(await fixture(h.app, 'deletion_requests')),
          ...changes,
        }),
      ),
      JSON.stringify(changes),
    ).toBe(code);
    expect(
      await sqlState(update(h.app, 'deletion_requests', row['id'], changes)),
      JSON.stringify(changes),
    ).toBe(code);
    expect(await read(h.app, 'deletion_requests', row['id'])).toEqual(row);
  }
});

it('[AC-B1-15o#10] cleanup timestamp round-trips independently of processed_at; failed Apple revocation can coexist with done', async () => {
  await ready(h.app, 'deletion_requests');
  const row = await insert(h.app, 'deletion_requests', await fixture(h.app, 'deletion_requests'));
  const progress = { cleaned_at: CLEANED, apple_revoke_attempts: 3, apple_revoke_result: 'failed' };
  expect(await sqlState(update(h.app, 'deletion_requests', row['id'], progress))).toBe('no error');
  expect(await read(h.app, 'deletion_requests', row['id'])).toEqual({ ...row, ...progress });
  const finished = { status: 'done', processed_at: DEADLINE, row_version: 1, updated_at: CLEANED };
  expect(await sqlState(update(h.app, 'deletion_requests', row['id'], finished))).toBe('no error');
  expect(await read(h.app, 'deletion_requests', row['id'])).toEqual({
    ...row,
    ...progress,
    ...finished,
  });
});
