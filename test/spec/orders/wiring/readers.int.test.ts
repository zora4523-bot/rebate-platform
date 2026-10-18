import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createUnionOrderReaders } from '../../../../apps/api/src/modules/union/index.ts';
import { createOrderBindingReader } from '../../../../apps/api/src/modules/linking/index.ts';
import { traceQueries } from '../attribution/kit.ts';
import {
  account,
  at,
  BOUND,
  built,
  COOLDOWN,
  CREATED,
  pid,
  RELEASED,
  START,
  user,
} from './db-kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it('[AC-B1-08n#15] pids 按四键返回原始 scene/status/site；账号 syncStartAt 按 App/账号读真实字段且不缓存', async () => {
  const a = await account(db, { platform: 'taobao' });
  const b = await account(db, { platform: 'taobao' });
  await pid(db, a, { status: 'pending' });
  await pid(db, b, { pid_scene: 'self_buy' });
  const traced = traceQueries(db);
  const readers = await built(() => createUnionOrderReaders(traced.db));
  const key = {
    appId: a.app_id,
    platform: 'taobao' as const,
    unionAccountId: a.id,
    pid: 'slot-ours',
  };
  for (const status of ['pending', 'active', 'retired']) {
    await db
      .updateTable('union_pids')
      .set({ status })
      .where('union_account_id', '=', a.id)
      .execute();
    expect(await readers.pids.find(key)).toEqual([
      { pid_scene: 'share', status, site_id: 'site-ours' },
    ]);
  }
  for (const wrong of [
    { ...key, appId: b.app_id },
    { ...key, unionAccountId: b.id },
    { ...key, pid: 'absent' },
    { ...key, platform: 'pdd' as const },
  ]) {
    expect(await readers.pids.find(wrong)).toEqual([]);
  }
  const accKey = { appId: a.app_id, unionAccountId: a.id };
  expect(await readers.accounts.syncStartAt(accKey)).toEqual(at(START));
  expect(await readers.accounts.syncStartAt({ ...accKey, appId: b.app_id })).toBeNull();
  expect(
    await readers.accounts.syncStartAt({ ...accKey, unionAccountId: randomUUID() }),
  ).toBeNull();
  await db
    .updateTable('union_accounts')
    .set({ sync_start_at: null })
    .where('id', '=', a.id)
    .execute();
  expect(await readers.accounts.syncStartAt(accKey)).toBeNull();
  expect(traced.queries.length).toBeGreaterThan(0);
  expect(traced.queries.every((q) => /^select /i.test(q.sql))).toBe(true);
});

it('[AC-B1-08n#16] attr_code 反查用户按 App 隔离，注销用户仍返回 id，每次重查', async () => {
  const { createOrderUserReader } = (await import(
    new URL('../../../../apps/api/src/modules/identity/index.ts', import.meta.url).href
  )) as {
    createOrderUserReader: typeof import('../../../../apps/api/src/modules/identity/infra/order-user-reader.ts').createOrderUserReader;
  };
  const a = await account(db);
  const b = await account(db);
  const u = await user(db, a.app_id, { status: 'deleted' });
  const other = await user(db, b.app_id);
  const traced = traceQueries(db);
  const reader = await built(() => createOrderUserReader(traced.db));
  expect(await reader.findByAttrCode({ appId: a.app_id, attrCode: 'abcd1234' })).toBe(u.id);
  expect(await reader.findByAttrCode({ appId: b.app_id, attrCode: 'abcd1234' })).toBe(other.id);
  expect(await reader.findByAttrCode({ appId: 'absent', attrCode: 'abcd1234' })).toBeNull();
  expect(await reader.findByAttrCode({ appId: a.app_id, attrCode: 'absent00' })).toBeNull();
  await db.updateTable('users').set({ attr_code: 'efgh5678' }).where('id', '=', u.id).execute();
  expect(await reader.findByAttrCode({ appId: a.app_id, attrCode: 'abcd1234' })).toBeNull();
  expect(await reader.findByAttrCode({ appId: a.app_id, attrCode: 'efgh5678' })).toBe(u.id);
  expect(traced.queries.length).toBeGreaterThan(0);
  expect(traced.queries.every((q) => /^select /i.test(q.sql))).toBe(true);
});

it('[AC-B1-08n#17] 绑定读取不按 status 过滤、不缓存，三键隔离并保留所有不同的时间戳', async () => {
  const a = await account(db, { platform: 'taobao' });
  const b = await account(db, { platform: 'taobao' });
  const u = await user(db, a.app_id);
  const id = randomUUID();
  await db
    .insertInto('union_bindings')
    .values({
      id,
      app_id: a.app_id,
      user_id: u.id,
      platform: 'taobao',
      union_account_id: a.id,
      relation_id: 'synthetic-relation',
      status: 'released',
      bound_at: at(BOUND),
      released_at: at(RELEASED),
      cooldown_until: at(COOLDOWN),
      created_at: at(CREATED),
      updated_at: at(COOLDOWN),
    })
    .execute();
  const traced = traceQueries(db);
  const reader = await built(() => createOrderBindingReader(traced.db));
  const key = { appId: a.app_id, unionAccountId: a.id, relationId: 'synthetic-relation' };
  const expected = {
    user_id: u.id,
    bound_at: at(BOUND),
    released_at: at(RELEASED),
    cooldown_until: at(COOLDOWN),
  };
  for (const status of ['released', 'invalid', 'blocked']) {
    await db.updateTable('union_bindings').set({ status }).where('id', '=', id).execute();
    expect(await reader.findByRelation(key)).toEqual([expected]);
  }
  for (const wrong of [
    { ...key, appId: b.app_id },
    { ...key, unionAccountId: b.id },
    { ...key, relationId: 'absent' },
  ]) {
    expect(await reader.findByRelation(wrong)).toEqual([]);
  }
  await db
    .updateTable('union_bindings')
    .set({ bound_at: null, released_at: null, cooldown_until: null })
    .where('id', '=', id)
    .execute();
  expect(await reader.findByRelation(key)).toEqual([
    { user_id: u.id, bound_at: null, released_at: null, cooldown_until: null },
  ]);
  const historical = await user(db, a.app_id, { attr_code: 'ijkl9012' });
  await db
    .insertInto('union_bindings')
    .values({
      id: randomUUID(),
      app_id: a.app_id,
      user_id: historical.id,
      platform: 'taobao',
      union_account_id: a.id,
      relation_id: key.relationId,
      status: 'released',
      bound_at: at(BOUND),
      released_at: at(RELEASED),
      cooldown_until: at(COOLDOWN),
      created_at: at(CREATED),
      updated_at: at(COOLDOWN),
    })
    .execute();
  expect(
    (await reader.findByRelation(key)).toSorted((x, y) => x.user_id.localeCompare(y.user_id)),
  ).toEqual(
    [
      { user_id: u.id, bound_at: null, released_at: null, cooldown_until: null },
      { ...expected, user_id: historical.id },
    ].sort((x, y) => x.user_id.localeCompare(y.user_id)),
  );
  expect(traced.queries.length).toBeGreaterThan(0);
  expect(traced.queries.every((q) => /^select /i.test(q.sql))).toBe(true);
});
