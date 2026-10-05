// B1-06b: task excerpt and SPEC_REF docs/changes/20261003-淘宝转链改客户端百川.md §3 #6.
// Naming decision permitted by the brief: use its examples promo_url (text) and
// promo_url_fetched_at (timestamptz), a URL and its acquisition instant, not two URLs.
// Both are nullable and may be filled once; the migration must document these names.
// User/relation/promotion-slot validation and expiry policy belong to linking's API tests.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { connect, newLink, shape, sqlState } from './kit.ts';

const URL_ONE = 'https://promotion.example.test/first';
const URL_TWO = 'https://promotion.example.test/second';
const FETCHED = new Date('2026-10-06T08:00:00Z');
const LATER = new Date('2026-10-06T08:01:00Z');
const GUARD_ERRORS = ['23001', '23514', 'P0001'];
let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  connect(app);
});
afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
});

async function promotionColumns(): Promise<void> {
  await shape('links', 'promo_url', 'text', true);
  await shape('links', 'promo_url_fetched_at', 'timestamptz', true);
}

async function stored(linkId: string) {
  return (
    await sql<{ promo_url: string | null; promo_url_fetched_at: Date | null }>`
    SELECT promo_url, promo_url_fetched_at FROM app.links WHERE link_id = ${linkId}
  `.execute(app)
  ).rows;
}

it('[AC-B1-06b#17] links retain nullable promotion URL and acquisition time, with an enabled UPDATE trigger', async () => {
  await promotionColumns();
  const linkId = await newLink();
  expect(await stored(linkId)).toEqual([{ promo_url: null, promo_url_fetched_at: null }]);
  const triggers = await sql<{ present: boolean }>`
    SELECT EXISTS(SELECT 1 FROM pg_trigger
      WHERE tgrelid = to_regclass('app.links') AND NOT tgisinternal
        AND tgenabled IN ('O', 'A') AND (tgtype & 16) = 16) AS present
  `.execute(app);
  expect(triggers.rows).toEqual([{ present: true }]);
});

it('[AC-B1-06b#18] promotion fields may be filled on an already quoted link and repeated identically', async () => {
  await promotionColumns();
  const linkId = await newLink({ quoted_at: FETCHED, quoted_final_price_fen: 2990 });
  const fill = () =>
    sql`
    UPDATE app.links SET promo_url = ${URL_ONE}, promo_url_fetched_at = ${FETCHED}
    WHERE link_id = ${linkId}
  `.execute(app);
  expect(await sqlState(fill())).toBe('no error');
  expect(await sqlState(fill())).toBe('no error');
  expect(await stored(linkId)).toEqual([{ promo_url: URL_ONE, promo_url_fetched_at: FETCHED }]);
});

it('[AC-B1-06b#19] either promotion field can be filled first without freezing the still-NULL field', async () => {
  await promotionColumns();
  for (const order of [
    ['promo_url', 'promo_url_fetched_at'],
    ['promo_url_fetched_at', 'promo_url'],
  ]) {
    const linkId = await newLink();
    for (const column of order) {
      expect(
        await sqlState(
          sql`
        UPDATE app.links SET ${sql.ref(column)} = ${column === 'promo_url' ? URL_ONE : FETCHED}
        WHERE link_id = ${linkId}
      `.execute(app),
        ),
        order.join(' then '),
      ).toBe('no error');
    }
    expect(await stored(linkId)).toEqual([{ promo_url: URL_ONE, promo_url_fetched_at: FETCHED }]);
  }
});

it('[AC-B1-06b#20] populated promotion fields cannot be overwritten or cleared, whether inserted or filled later', async () => {
  await promotionColumns();
  for (const atInsert of [true, false]) {
    const linkId = await newLink(
      atInsert ? { promo_url: URL_ONE, promo_url_fetched_at: FETCHED } : {},
    );
    if (!atInsert) {
      await sql`UPDATE app.links SET promo_url = ${URL_ONE}, promo_url_fetched_at = ${FETCHED}
        WHERE link_id = ${linkId}`.execute(app);
    }
    for (const change of [
      sql`promo_url = ${URL_TWO}`,
      sql`promo_url = NULL`,
      sql`promo_url_fetched_at = ${LATER}`,
      sql`promo_url_fetched_at = NULL`,
      sql`promo_url = ${URL_TWO}, promo_url_fetched_at = ${LATER}`,
    ]) {
      expect(GUARD_ERRORS).toContain(
        await sqlState(
          sql`
        UPDATE app.links SET ${change} WHERE link_id = ${linkId}
      `.execute(app),
        ),
      );
      expect(await stored(linkId)).toEqual([{ promo_url: URL_ONE, promo_url_fetched_at: FETCHED }]);
    }
    // Reject only promotion rewrites: legitimate cache writes must still work.
    expect(
      await sqlState(
        sql`UPDATE app.links SET cache_hit = true WHERE link_id = ${linkId}`.execute(app),
      ),
    ).toBe('no error');
  }
});

it('[AC-B1-06b#21] concurrent fills cannot overwrite the winner or mix URL/time pairs', async () => {
  await promotionColumns();
  const linkId = await newLink();
  const outcomes = await Promise.all([
    sqlState(
      sql`UPDATE app.links SET promo_url = ${URL_ONE}, promo_url_fetched_at = ${FETCHED}
      WHERE link_id = ${linkId}`.execute(app),
    ),
    sqlState(
      sql`UPDATE app.links SET promo_url = ${URL_TWO}, promo_url_fetched_at = ${LATER}
      WHERE link_id = ${linkId}`.execute(app),
    ),
  ]);
  expect(outcomes.filter((code) => code === 'no error')).toHaveLength(1);
  expect(GUARD_ERRORS).toContain(outcomes.find((code) => code !== 'no error'));
  const winner =
    outcomes[0] === 'no error'
      ? { promo_url: URL_ONE, promo_url_fetched_at: FETCHED }
      : { promo_url: URL_TWO, promo_url_fetched_at: LATER };
  expect(await stored(linkId)).toEqual([winner]);
});

it('[AC-B1-06b#22] promotion columns retain linking writes and read-only reads without delete/reinsert access', async () => {
  await promotionColumns();
  for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
    for (const column of ['promo_url', 'promo_url_fetched_at']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
        const result = await sql<{ allowed: boolean }>`
          SELECT has_column_privilege(${role}, 'app.links', ${column}, ${privilege}) AS allowed
        `.execute(app);
        expect(result.rows[0]?.allowed, `${role} ${column} ${privilege}`).toBe(
          role === 'couli_app' || (role === 'couli_readonly' && privilege === 'SELECT'),
        );
      }
    }
    for (const privilege of ['DELETE', 'TRUNCATE']) {
      const result = await sql<{ allowed: boolean }>`
        SELECT has_table_privilege(${role}, 'app.links', ${privilege}) AS allowed
      `.execute(app);
      expect(result.rows[0]?.allowed, `${role} ${privilege}`).toBe(false);
    }
  }
});
