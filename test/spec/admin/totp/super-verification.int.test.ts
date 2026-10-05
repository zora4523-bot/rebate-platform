import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Insertable, Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createSuperVerifier } from '../../../../apps/api/src/modules/admin/application/verify-super.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { cryptoFixture, replayFixture } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
// A fixture value, NOT a new status enum: 0016 intentionally leaves status as open text.
const ACTIVE = 'f1-06b-fixture-enabled';

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app') });
});

afterAll(async () => {
  if (db !== undefined) await destroyDb(db);
  if (database !== undefined) await database.drop();
});

async function setup(patch: Partial<Insertable<DB['admin_users']>> = {}) {
  const fields = await cryptoFixture();
  const replay = replayFixture();
  const clock = new FixedClock('1970-01-01T00:00:59Z');
  const account = { appId: 'couli', adminId: randomUUID() };
  await db
    .insertInto('admin_users')
    .values({
      id: account.adminId,
      app_id: account.appId,
      login_name: `super-rule-${account.adminId}`,
      password_hash: 'fixture-unused-hash',
      is_super: true,
      status: ACTIVE,
      totp_secret_cipher: fields.encryptFor(account),
      totp_bound_at: '1970-01-01T00:00:00Z',
      ...patch,
    })
    .execute();
  const deps = { db, clock, crypto: fields.crypto, replay: replay.replay, activeStatus: ACTIVE };
  // This factory intentionally throws NotImplemented in the red phase, outside any
  // rejection assertion, so a missing implementation cannot make a rejection test green.
  const verifier = createSuperVerifier(deps);
  return { ...fields, ...replay, clock, account, deps, verifier };
}

it('[AC-F1-06b-SUPER#1] returns only the verified active, bound super identity', async () => {
  const f = await setup();
  const before = await db
    .selectFrom('admin_users')
    .selectAll()
    .where('id', '=', f.account.adminId)
    .executeTakeFirstOrThrow();
  expect(await f.verifier.verify({ ...f.account, code: '287082' })).toEqual(f.account);
  expect(f.consume).toHaveBeenCalledExactlyOnceWith({ ...f.account, timeStep: 1n });
  const after = await db
    .selectFrom('admin_users')
    .selectAll()
    .where('id', '=', f.account.adminId)
    .executeTakeFirstOrThrow();
  expect(after).toEqual(before);
});

it.each([
  ['ordinary account', { is_super: false }],
  ['disabled account', { status: 'f1-06b-fixture-disabled' }],
  ['unknown status', { status: 'unrecognized-status' }],
  ['not yet bound with a pending cipher', { totp_bound_at: null }],
  ['bound timestamp without a cipher', { totp_secret_cipher: null }],
  ['never bound', { totp_bound_at: null, totp_secret_cipher: null }],
] satisfies [string, Partial<Insertable<DB['admin_users']>>][])(
  '[AC-F1-06b-SUPER#2] rejects %s before checking/consuming a code',
  async (_label, patch) => {
    const f = await setup(patch);
    expect(await f.verifier.verify({ ...f.account, code: '287082' })).toBeNull();
    expect(f.decrypt).not.toHaveBeenCalled();
    expect(f.consume).not.toHaveBeenCalled();
  },
);

it('[AC-F1-06b-SUPER#3] missing admin or mismatched app cannot authenticate', async () => {
  const f = await setup();
  expect(
    await f.verifier.verify({ ...f.account, adminId: randomUUID(), code: '287082' }),
  ).toBeNull();
  expect(await f.verifier.verify({ ...f.account, appId: 'couli_two', code: '287082' })).toBeNull();
  expect(f.decrypt).not.toHaveBeenCalled();
  expect(f.consume).not.toHaveBeenCalled();
});

it.each(['000000', '94287082', '28708x'])(
  '[AC-F1-06b-SUPER#4] rejects invalid code %s without burning the valid step',
  async (code) => {
    const f = await setup();
    expect(await f.verifier.verify({ ...f.account, code })).toBeNull();
    expect(f.consume).not.toHaveBeenCalled();
    expect(await f.verifier.verify({ ...f.account, code: '287082' })).toEqual(f.account);
  },
);

it('[AC-F1-06b-SUPER#5] super verification consumes a code once across fresh verifier instances', async () => {
  const f = await setup();
  const request = { ...f.account, code: '287082' };
  expect(await f.verifier.verify(request)).toEqual(f.account);
  expect(await f.verifier.verify(request)).toBeNull();
  const next = createSuperVerifier(f.deps);
  expect(await next.verify(request)).toBeNull();
  f.clock.advanceMs(30_000);
  expect(await next.verify({ ...request, code: '359152' })).toEqual(f.account);
});

it('[AC-F1-06b-SUPER#6] concurrent super checks return exactly one verified identity', async () => {
  const f = await setup();
  const other = createSuperVerifier(f.deps);
  const request = { ...f.account, code: '287082' };
  const results = await Promise.all([f.verifier.verify(request), other.verify(request)]);
  expect(results.filter((value) => value !== null)).toEqual([f.account]);
  expect(results.filter((value) => value === null)).toHaveLength(1);
});

it('[AC-F1-06b-SUPER#7] disabling a previously verified super is effective on the next call', async () => {
  const f = await setup();
  expect(await f.verifier.verify({ ...f.account, code: '287082' })).toEqual(f.account);
  await db
    .updateTable('admin_users')
    .set({ status: 'f1-06b-fixture-disabled' })
    .where('id', '=', f.account.adminId)
    .execute();
  f.clock.advanceMs(30_000);
  f.decrypt.mockClear();
  f.consume.mockClear();
  expect(await f.verifier.verify({ ...f.account, code: '359152' })).toBeNull();
  expect(f.decrypt).not.toHaveBeenCalled();
  expect(f.consume).not.toHaveBeenCalled();
});
