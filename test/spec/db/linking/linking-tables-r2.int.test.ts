// Additions after the rule-test review round 2 of B1-06a (Codex, out_of_scope entries that
// belong to this task's tables; 规划/04 §3.2 links, link_open_attempts; BR-PRICE-12). Real
// PostgreSQL as couli_app. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { UNIQUE_VIOLATION, insertRow, newLink, newUser, sqlState, useDb } from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  useDb(app);
});

afterAll(async () => {
  await destroyDb(app);
  await database.drop();
});

it('[AC-B1-06a#14] a written quote snapshot cannot be cleared either (BR-PRICE-12)', async () => {
  const linkId = await newLink({
    quoted_final_price_fen: 2990,
    quoted_coupon_fen: 500,
    quoted_coupon_id: 'coupon-one',
    quoted_at: new Date('2026-10-04T07:59:00Z'),
  });
  for (const column of [
    'quoted_final_price_fen',
    'quoted_coupon_fen',
    'quoted_coupon_id',
    'quoted_at',
  ]) {
    expect(
      await sqlState(
        sql`UPDATE app.links SET ${sql.ref(column)} = NULL WHERE link_id = ${linkId}`.execute(app),
      ),
      column,
    ).not.toBe('no error');
  }
  const stored = await sql<{ intact: boolean }>`
    SELECT quoted_final_price_fen = 2990 AND quoted_coupon_fen = 500
           AND quoted_coupon_id::text = 'coupon-one' AND quoted_at IS NOT NULL AS intact
    FROM app.links WHERE link_id = ${linkId}
  `.execute(app);
  expect(stored.rows).toEqual([{ intact: true }]);
});

it('[AC-B1-06a#15] a link_id is unique across apps, not only within one', async () => {
  const linkId = await newLink();
  expect(await sqlState(newLink({ link_id: linkId, app_id: 'couli_two' }))).toBe(UNIQUE_VIOLATION);
});

it('[AC-B1-06a#16] an attempt id is never rewritten', async () => {
  const attemptId = randomUUID();
  await insertRow('link_open_attempts', {
    attempt_id: attemptId,
    app_id: 'couli',
    link_id: await newLink(),
    user_id: await newUser(),
    opened_at: new Date('2026-10-04T08:00:00Z'),
  });
  expect(
    await sqlState(
      sql`UPDATE app.link_open_attempts SET attempt_id = ${randomUUID()}
          WHERE attempt_id = ${attemptId}`.execute(app),
    ),
  ).not.toBe('no error');
  const left = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM app.link_open_attempts WHERE attempt_id = ${attemptId}
  `.execute(app);
  expect(left.rows).toEqual([{ n: '1' }]);
});
