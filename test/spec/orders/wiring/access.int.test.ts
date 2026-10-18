import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { REGISTERED_PLATFORMS } from '../../../../apps/api/src/modules/union/index.ts';
import { access, account, at, START } from './db-kit.ts';

// Global setup supplies the migrated template connection. Clone per file, query as couli_app.
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

it('[AC-B1-08n#13] 跨 App 枚举注册平台账号、不按 status 过滤，sync_start_at 为 ISO/null；授权逐次按三键查询', async () => {
  const a = await account(db);
  const b = await account(db, { sync_start_at: null, status: 'inactive', auth_status: 'expired' });
  const c = await account(db, { platform: 'jd' });
  const d = await account(db, { platform: 'taobao' });
  const ignored = await account(db, { platform: 'meituan' });
  const { port } = await access(db);
  expect(REGISTERED_PLATFORMS).not.toContain(ignored.platform);
  const rows = await port.listEnabledAccounts();
  expect(
    rows
      .filter((r) => [a.id, b.id, c.id, d.id, ignored.id].includes(r.union_account_id))
      .sort((x, y) => x.union_account_id.localeCompare(y.union_account_id)),
  ).toEqual(
    [
      { app_id: a.app_id, platform: 'pdd', union_account_id: a.id, sync_start_at: START },
      { app_id: b.app_id, platform: 'pdd', union_account_id: b.id, sync_start_at: null },
      { app_id: c.app_id, platform: 'jd', union_account_id: c.id, sync_start_at: START },
      { app_id: d.app_id, platform: 'taobao', union_account_id: d.id, sync_start_at: START },
    ].sort((x, y) => x.union_account_id.localeCompare(y.union_account_id)),
  );
  const key = { app_id: a.app_id, platform: 'pdd' as const, union_account_id: a.id };
  for (const [auth, expected] of [
    ['active', true],
    ['expiring', true],
    ['expired', false],
    ['active', true],
  ] as const) {
    await db
      .updateTable('union_accounts')
      .set({ auth_status: auth })
      .where('id', '=', a.id)
      .execute();
    expect(await port.siteAuthAvailable(key), auth).toBe(expected);
  }
  for (const wrong of [
    { ...key, app_id: b.app_id },
    { ...key, platform: 'jd' as const },
    { ...key, union_account_id: randomUUID() },
  ]) {
    expect(await port.siteAuthAvailable(wrong)).toBe(false);
  }
  await db
    .updateTable('union_accounts')
    .set({ sync_start_at: at('2026-10-06T06:07:08.000Z') })
    .where('id', '=', a.id)
    .execute();
  expect(
    (await port.listEnabledAccounts()).find((r) => r.union_account_id === a.id)?.sync_start_at,
  ).toBe('2026-10-06T06:07:08.000Z');
});
