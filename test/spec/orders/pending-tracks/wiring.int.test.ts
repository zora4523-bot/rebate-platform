import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixture, expected } from './db-kit.ts';
import { at } from './kit.ts';
import { withHttp } from './http-kit.ts';

// Global setup injects the template factory connection; each file clones it.
// All fixture writes and application queries use the ordinary application role.
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

it('[AC-B1-08m#31] 生产装配接真实查询与 linking 端口，GET/POST 均过契约校验', async () => {
  const f = await fixture(db);
  const a = await f.open(0);
  f.clock.set(at(40));
  await withHttp(
    undefined,
    f.subject,
    async (send, logs) => {
      const response = await send('/v1/orders/pending-tracks');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        code: 0,
        msg: '',
        data: { items: [expected(a, 'jd', true)] },
      });
      const dismissed = await send(`/v1/orders/pending-tracks/${a.link_id}/dismiss`, {
        attempt_id: a.attempt_id,
      });
      expect(dismissed.statusCode).toBe(200);
      expect(dismissed.json()).toMatchObject({ code: 0, msg: '', data: {} });
      expect((await f.saved()).find((r) => r.attempt_id === a.attempt_id)?.dismissed_at).toEqual(
        at(40),
      );
      const after = await send('/v1/orders/pending-tracks');
      expect(after.statusCode).toBe(200);
      expect(after.json()).toMatchObject({ data: { items: [expected(a, 'jd', true, true)] } });
      const records = logs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((row) => row['module'] === 'orders');
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        expect(record).not.toHaveProperty('orders');
        expect(record).not.toHaveProperty('link');
        expect(record).not.toHaveProperty('order_no');
        expect(record).not.toHaveProperty('product_key');
        expect(record).not.toHaveProperty('user');
      }
    },
    { db, dbRead: null, async close() {} },
    f.clock,
  );
}, 30_000);
