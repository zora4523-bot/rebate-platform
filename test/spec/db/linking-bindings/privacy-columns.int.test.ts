// B1-06b attempt 2: additive review corrections; existing rule tests stay unchanged.
// Coverage supplement (BR-ID-17, task excerpt 04 §3.2):
// AC#23 / AC#24 | No columns for persisted user tokens, secrets or profile data.
// AC#14        | Storage-capability probe only; NOT coverage of the single-use rule.
// The CAS and expiry predicate in AC#14 belong to the test itself, not the migration.
// TODO(规划/11 §4.3): Verify single use and expiry through the bindings API
// — blocked on the linking bindings interface task.
// Use the review's forbidden-name check rather than a closed column allowlist:
// BR-ID-17 also requires recording client/auth-method metadata, whose column names
// are not prescribed in the task excerpt. Technical columns remain permitted.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { columns, connect, requireTable } from './kit.ts';

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

async function expectNoPrivateColumns(table: string): Promise<void> {
  // Missing tables must fail an assertion, never a relation lookup or DML error.
  await requireTable(table);
  const names = (await columns(table)).map((column) => column.name);
  expect(names, `${table}: column catalog must be visible to couli_app`).toContain('app_id');
  expect(
    names.filter((name) => /token|secret|nick|avatar|account_?name/i.test(name)),
    `${table}: BR-ID-17 forbids persisting Taobao user session tokens and profile data`,
  ).toEqual([]);
}

it('[AC-B1-06b#23] union_bindings has no token, secret, nickname, avatar or account-name columns', async () => {
  await expectNoPrivateColumns('union_bindings');
});

it('[AC-B1-06b#24] union_auth_sessions has no token, secret, nickname, avatar or account-name columns', async () => {
  await expectNoPrivateColumns('union_auth_sessions');
});
