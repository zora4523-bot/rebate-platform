import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createPendingAttemptStore } from './pending-attempts.ts';

const ID = '0199a3b4-5c6d-7000-8000-0000000000d1';

function untouchedDb() {
  const withSchema = vi.fn(() => {
    throw new Error('the database must not be reached');
  });
  return { db: { withSchema } as unknown as Kysely<DB>, withSchema };
}

it('[AC-B1-08m#34] 创建端口不触碰数据库句柄', () => {
  const { db, withSchema } = untouchedDb();
  createPendingAttemptStore(db);
  expect(withSchema).not.toHaveBeenCalled();
});

it.each([
  { attempt_id: 'not-a-uuid', link_id: ID, user_id: ID },
  { attempt_id: ID, link_id: 'pending-link', user_id: ID },
  { attempt_id: ID, link_id: ID, user_id: 'someone' },
])('[AC-B1-08m#24] 非 UUID 的编号按不存在处理，不发出查询 %o', async (ids) => {
  const { db, withSchema } = untouchedDb();
  const store = createPendingAttemptStore(db);
  const result = await store.dismiss({
    app_id: 'pending_app',
    ...ids,
    at: new FixedClock('2028-01-15T00:00:00.000Z').now(),
  });
  expect(result).toBe(false);
  expect(withSchema).not.toHaveBeenCalled();
});

it('[AC-B1-08m#14] 非 UUID 的用户没有尝试，不发出查询', async () => {
  const { db, withSchema } = untouchedDb();
  const rows = await createPendingAttemptStore(db).listForUser({
    app_id: 'pending_app',
    user_id: 'guest',
    since: new FixedClock('2028-01-15T00:00:00.000Z').now(),
  });
  expect(rows).toEqual([]);
  expect(withSchema).not.toHaveBeenCalled();
});
