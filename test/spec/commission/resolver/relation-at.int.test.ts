// BR-CALC-12；D10-118：关系业务时点由 at 承载，created_at 不参与解析。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { AFTER, BEFORE, PAID, fixture, level, person, user } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

it('[AC-B2-03p#18] BR-CALC-12 解析器只按 at 取关系、与 created_at 无关', async () => {
  const f = fixture(db);
  // 两层分别覆盖业务时点在付款前后；每组仅改变写入时点，预期保持不变。
  for (const directAt of [BEFORE, AFTER]) {
    for (const indirectAt of [BEFORE, AFTER]) {
      for (const createdAt of [BEFORE, AFTER]) {
        await db.transaction().execute(async (trx) => {
          const appId = randomUUID();
          const owner = await user(trx, appId);
          const direct = await user(trx, appId);
          const indirect = await user(trx, appId);
          await level(trx, appId, owner, 'L1');
          await level(trx, appId, direct, 'L2');
          await level(trx, appId, indirect, 'L3');
          await trx
            .withSchema('app')
            .insertInto('relation_change_logs')
            .values([
              {
                app_id: appId,
                user_id: owner,
                from_parent_id: null,
                to_parent_id: direct,
                source: 'admin',
                operator: 'synthetic-test',
                reason: 'synthetic relation business time',
                at: directAt,
                created_at: createdAt,
              },
              {
                app_id: appId,
                user_id: direct,
                from_parent_id: null,
                to_parent_id: indirect,
                source: 'admin',
                operator: 'synthetic-test',
                reason: 'synthetic relation business time',
                at: indirectAt,
                created_at: createdAt,
              },
            ])
            .execute();

          const result = await f.resolver.resolve(trx, {
            appId,
            ownerUserId: owner,
            paidAt: PAID,
          });
          expect(result).toEqual({
            owner: person(owner, 'L1'),
            direct: directAt === BEFORE ? person(direct, 'L2') : null,
            indirect: directAt === BEFORE && indirectAt === BEFORE ? person(indirect, 'L3') : null,
            warnings: [],
          });
        });
      }
    }
  }
});
