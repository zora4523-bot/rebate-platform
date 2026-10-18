import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  DECISIONS,
  admin,
  claim,
  decided,
  insert,
  item,
  order,
  ready,
  savedClaim,
  sqlState,
  user,
} from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;
let readonly: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  readonly = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
});
afterAll(async () => {
  if (app) await destroyDb(app);
  if (readonly) await destroyDb(readonly);
  if (database) await database.drop();
});
const h = {
  get app() {
    return app;
  },
  get readonly() {
    return readonly;
  },
};

it('[AC-B1-10a#21] order FK rejects missing keys, cross-tenant keys and a different key row order_id', async () => {
  await ready(h.app);
  const parent = await savedClaim(h.app);
  const key = await order(h.app);
  const another = await order(h.app);
  const foreign = await order(h.app, { app_id: 'other-app' });
  const row = await item(h.app, parent, key);
  for (const changes of [
    { sub_order_id: `missing-${randomUUID()}` },
    { order_id: randomUUID() },
    { order_id: another.order_id },
    { sub_order_id: foreign.sub_order_id, order_id: foreign.order_id },
  ]) {
    expect(await sqlState(insert(h.app, 'claim_items', { ...row, ...changes }))).toBe('23503');
  }
  // order_keys alone suffices; fixtures never create a row in partitioned orders.
  expect(await sqlState(insert(h.app, 'claim_items', row))).toBe('no error');
});

it('[AC-B1-10a#22] item applicant, platform and tenant must equal the same parent claim', async () => {
  await ready(h.app);
  const parent = await savedClaim(h.app);
  const row = await item(h.app, parent);
  const applicant = await user(h.app);
  const pdd = await order(h.app, { platform: 'pdd' });
  const otherApp = await order(h.app, { app_id: 'other-app' });
  for (const changes of [
    { claim_id: randomUUID() },
    { applicant_user_id: applicant },
    { platform: 'pdd', sub_order_id: pdd.sub_order_id, order_id: pdd.order_id },
    { app_id: 'other-app', sub_order_id: otherApp.sub_order_id, order_id: otherApp.order_id },
  ]) {
    expect(await sqlState(insert(h.app, 'claim_items', { ...row, ...changes }))).toBe('23503');
  }
  expect(await sqlState(insert(h.app, 'claim_items', row))).toBe('no error');
});

it('[AC-B1-10a#23] claim users and both admin references reject missing or foreign-tenant identities', async () => {
  await ready(h.app);
  const localUser = await user(h.app);
  const foreignUser = await user(h.app, 'other-app');
  const localAdmin = await admin(h.app);
  const foreignAdmin = await admin(h.app, 'other-app');
  for (const user_id of [randomUUID(), foreignUser]) {
    expect(await sqlState(insert(h.app, 'claims', await claim(h.app, { user_id })))).toBe('23503');
  }
  for (const handler_admin_id of [randomUUID(), foreignAdmin]) {
    expect(await sqlState(insert(h.app, 'claims', await claim(h.app, { handler_admin_id })))).toBe(
      '23503',
    );
  }
  const parent = await savedClaim(h.app, { user_id: localUser, handler_admin_id: localAdmin });
  const row = await item(h.app, parent);
  for (const decided_by of [randomUUID(), foreignAdmin]) {
    expect(
      await sqlState(insert(h.app, 'claim_items', { ...row, ...decided('approved'), decided_by })),
    ).toBe('23503');
  }
  expect(
    await sqlState(
      insert(h.app, 'claim_items', { ...row, ...decided('approved'), decided_by: localAdmin }),
    ),
  ).toBe('no error');
});

it('[AC-B1-10a#24] every existing decision blocks a second claim for the same applicant and child order', async () => {
  await ready(h.app);
  for (const existing of [null, ...DECISIONS]) {
    const parent = await savedClaim(h.app);
    const key = await order(h.app);
    const first = await item(h.app, parent, key);
    expect(await sqlState(insert(h.app, 'claim_items', { ...first, ...decided(existing) }))).toBe(
      'no error',
    );
    const secondParent = await savedClaim(h.app, { user_id: parent['user_id'] });
    for (const next of [null, ...DECISIONS]) {
      const second = await item(h.app, secondParent, key);
      expect(
        await sqlState(insert(h.app, 'claim_items', { ...second, ...decided(next) })),
        `${existing}/${next}`,
      ).toBe('23505');
    }
  }
});

it('[AC-B1-10a#25] same number on a different platform and same child for another applicant remain allowed', async () => {
  await ready(h.app);
  const parent = await savedClaim(h.app);
  const key = await order(h.app);
  const first = await item(h.app, parent, key);
  expect(await sqlState(insert(h.app, 'claim_items', first))).toBe('no error');
  const otherApplicant = await savedClaim(h.app);
  expect(await sqlState(insert(h.app, 'claim_items', await item(h.app, otherApplicant, key)))).toBe(
    'no error',
  );
  const pddParent = await savedClaim(h.app, { user_id: parent['user_id'], platform: 'pdd' });
  const pddKey = await order(h.app, { platform: 'pdd', sub_order_id: key.sub_order_id });
  expect(await sqlState(insert(h.app, 'claim_items', await item(h.app, pddParent, pddKey)))).toBe(
    'no error',
  );
  const foreignParent = await savedClaim(h.app, { app_id: 'other-app' });
  expect(await sqlState(insert(h.app, 'claim_items', await item(h.app, foreignParent)))).toBe(
    'no error',
  );
});

it('[AC-B1-10a#26] concurrent duplicate applicants resolve to one insert and one unique violation', async () => {
  await ready(h.app);
  const parent = await savedClaim(h.app);
  const second = await savedClaim(h.app, { user_id: parent['user_id'] });
  const key = await order(h.app);
  const rows = [await item(h.app, parent, key), await item(h.app, second, key)];
  const outcomes = await Promise.all(
    rows.map((row) => sqlState(insert(h.app, 'claim_items', row))),
  );
  expect(outcomes.sort()).toEqual(['23505', 'no error']);
  const count = await sql<{ count: number }>`SELECT count(*)::int AS count FROM app.claim_items
    WHERE app_id = ${parent['app_id']} AND applicant_user_id = ${parent['user_id']}
      AND platform = ${key.platform} AND sub_order_id = ${key.sub_order_id}`.execute(h.app);
  expect(count.rows).toEqual([{ count: 1 }]);
});

it('[AC-B1-10a#27] UUID primary keys reject duplicate ids independently of business unique keys', async () => {
  await ready(h.app);
  const first = await savedClaim(h.app);
  expect(await sqlState(insert(h.app, 'claims', await claim(h.app, { id: first['id'] })))).toBe(
    '23505',
  );
  const child = await item(h.app, first);
  await insert(h.app, 'claim_items', child);
  const other = await item(h.app);
  expect(await sqlState(insert(h.app, 'claim_items', { ...other, id: child['id'] }))).toBe('23505');
});
