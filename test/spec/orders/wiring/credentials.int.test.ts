import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { access, account } from './db-kit.ts';

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

it('[AC-B1-08n#14] live 全库零/一/两账号，每次重查；不确定账号每平台只报一次，demo/replay 永不查询订单', async () => {
  const { port, logger } = await access(db, 'live');
  expect(typeof port.queryableAccount).toBe('function');
  expect(await port.queryableAccount('pdd')).toBeNull();
  expect(logger.error).toHaveBeenCalledTimes(1);
  expect(await port.queryableAccount('pdd')).toBeNull();
  expect(logger.error).toHaveBeenCalledTimes(1);
  const a = await account(db);
  // Other platforms do not make the PDD credential ambiguous.
  await account(db, { platform: 'jd' });
  expect(await port.queryableAccount('pdd')).toBe(a.id);
  for (const mode of ['demo', 'replay'] as const) {
    const f = await access(db, mode);
    expect(await f.port.queryableAccount('pdd')).toBeNull();
    expect(f.logger.error).not.toHaveBeenCalled();
  }
  const b = await account(db, { status: 'inactive', auth_status: 'expired', sync_start_at: null });
  expect(a.app_id).not.toBe(b.app_id);
  expect(await port.queryableAccount('pdd')).toBeNull();
  expect(await port.queryableAccount('pdd')).toBeNull();
  expect(logger.error).toHaveBeenCalledTimes(1);
  for (const mode of ['demo', 'replay'] as const) {
    const f = await access(db, mode);
    expect(await f.port.queryableAccount('pdd')).toBeNull();
    expect(f.logger.error).not.toHaveBeenCalled();
  }
});
