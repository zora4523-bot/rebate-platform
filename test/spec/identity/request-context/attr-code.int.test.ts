import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createIdentityAttrCodeReader } from '../../../../apps/api/src/modules/identity/ports/request-context.ts';
import { seedUser } from './db-kit.ts';

let database: Awaited<ReturnType<(typeof import('@couli/db/testing'))['createTestDatabase']>>;
let db: Kysely<DB>;
beforeAll(async () => {
  const { createTestDatabase } = await import('@couli/db/testing');
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
}, 180_000);
afterAll(async () => {
  try {
    if (db !== undefined) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

it('[AC-B1-02m#5] 按 app_id 和用户 id 读取真实 attr_code；跨 App 和不存在的用户均不可用', async () => {
  const first = await seedUser(db);
  const second = await seedUser(db, 'couli_other');
  const reader = createIdentityAttrCodeReader(db);
  expect(await reader.attrCode(first.appId, first.id)).toBe(first.attrCode);
  expect(await reader.attrCode(second.appId, second.id)).toBe(second.attrCode);
  expect(first.attrCode).not.toBe(first.id);
  for (const [appId, userId] of [
    [second.appId, first.id],
    [first.appId, second.id],
    [first.appId, randomUUID()],
  ] as const) {
    const result = await reader.attrCode(appId, userId);
    expect(result).toBeNull();
    expect(result).not.toBe(userId);
  }
});

it('[AC-B1-02m#6] 已注销用户即使仍有 attr_code 也不可用于联盟归因', async () => {
  const user = await seedUser(db, 'couli', { status: 'deleted' });
  const result = await createIdentityAttrCodeReader(db).attrCode(user.appId, user.id);
  expect(result).toBeNull();
  expect(result).not.toBe(user.id);
  expect(result).not.toBe(user.attrCode);
});

it('[AC-B1-02m#7] 空 attr_code 返回不可用，绝不回退成 user_id', async () => {
  // schema.sql forbids SQL NULL; the representable empty-column case is the empty string.
  const user = await seedUser(db, 'couli', { attrCode: '' });
  const result = await createIdentityAttrCodeReader(db).attrCode(user.appId, user.id);
  expect(result).toBeNull();
  expect(result).not.toBe(user.id);
});

it('[AC-B1-02m#8] 同一 reader 在注销之后重新读取时不得沿用原归因码', async () => {
  const user = await seedUser(db);
  const reader = createIdentityAttrCodeReader(db);
  expect(await reader.attrCode(user.appId, user.id)).toBe(user.attrCode);
  await db
    .withSchema('app')
    .updateTable('users')
    .set({ status: 'deleted' })
    .where('app_id', '=', user.appId)
    .where('id', '=', user.id)
    .execute();
  expect(await reader.attrCode(user.appId, user.id)).toBeNull();
});

it('[AC-B1-02m#9] 连接获取失败必须抛错，不能吞错返回 null 或 user_id', async () => {
  const failure = new Error('synthetic connection acquisition failure');
  const broken = createDb({
    poolFactory: () => ({
      options: {},
      connect: async () => {
        throw failure;
      },
      end: async () => undefined,
    }),
  });
  try {
    const reader = createIdentityAttrCodeReader(broken);
    await expect(reader.attrCode('couli', randomUUID())).rejects.toBe(failure);
  } finally {
    await destroyDb(broken);
  }
});
