import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createTotpVerifier,
  type TotpAccount,
  type TotpClaim,
} from '../../../../apps/api/src/modules/admin/domain/totp.ts';
import { createPgTotpReplayStore } from '../../../../apps/api/src/modules/admin/infra/totp-replay-pg.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  COLLISION_CODE,
  COLLISION_INSTANTS,
  COLLISION_STEP,
  COLLISION_STEP_START,
  PREVIOUS_STEP,
  claim,
  cryptoFixture,
  expectCollision,
} from './kit.ts';

// 编排裁定 D10-238 with the durable replay store (admin_users.totp_last_step, monotonic per
// account, unchanged by B1-34l): every matched step is tried in ascending order.

let database: TestDatabase | undefined;
let db: Kysely<DB>;
// An arbitrary status text: the verifier never reads admin_users.status.
const STATUS = 'b1-34l-enabled';

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app') });
});

afterAll(async () => {
  if (db !== undefined) await destroyDb(db);
  if (database !== undefined) await database.drop();
});

async function setup(epochMs: number, lastStep: bigint | null, code = COLLISION_CODE) {
  const fields = await cryptoFixture();
  const account: TotpAccount = { appId: 'couli', adminId: randomUUID() };
  const secretCipher = fields.encryptFor(account);
  await db
    .insertInto('admin_users')
    .values({
      id: account.adminId,
      app_id: account.appId,
      login_name: `totp-window-${account.adminId}`,
      password_hash: 'unused-hash',
      is_super: false,
      status: STATUS,
      totp_secret_cipher: secretCipher,
      totp_bound_at: '2026-02-23T00:00:00Z',
      totp_last_step: lastStep,
    })
    .execute();
  const store = createPgTotpReplayStore({ db });
  const consume = vi.fn((c: TotpClaim) => store.consume(c));
  const clock = new FixedClock(new Date(epochMs));
  const verifier = createTotpVerifier({
    clock,
    crypto: fields.crypto,
    replay: { consume },
    digits: 6,
  });
  return { account, clock, consume, verifier, request: { ...account, secretCipher, code } };
}

async function storedStep(account: TotpAccount): Promise<bigint | null> {
  const row = await db
    .selectFrom('admin_users')
    .select('totp_last_step')
    .where('app_id', '=', account.appId)
    .where('id', '=', account.adminId)
    .executeTakeFirstOrThrow();
  return row.totp_last_step;
}

it.each(COLLISION_INSTANTS)(
  '[AC-B1-34l#5] PG store: step N-1 already used, the same code is accepted for step N (%s)',
  async (_label, epochMs) => {
    expectCollision();
    const f = await setup(epochMs, PREVIOUS_STEP);
    expect(await f.verifier.verify(f.request)).toBe(true);
    expect(f.consume.mock.calls).toEqual([
      [claim(PREVIOUS_STEP, f.account)],
      [claim(COLLISION_STEP, f.account)],
    ]);
    expect(await storedStep(f.account)).toBe(COLLISION_STEP);
  },
);

it.each(COLLISION_INSTANTS)(
  '[AC-B1-34l#5] PG store: steps N-1 and N both used, the code is refused (%s)',
  async (_label, epochMs) => {
    expectCollision();
    const f = await setup(epochMs, COLLISION_STEP);
    expect(await f.verifier.verify(f.request)).toBe(false);
    expect(f.consume.mock.calls).toEqual([
      [claim(PREVIOUS_STEP, f.account)],
      [claim(COLLISION_STEP, f.account)],
    ]);
    expect(await storedStep(f.account)).toBe(COLLISION_STEP);
  },
);

it('[AC-B1-34l#5] PG store: a colliding code is accepted for N-1, then for N, then refused', async () => {
  expectCollision();
  const f = await setup(COLLISION_STEP_START * 1000 + 15_000, null);
  expect(await f.verifier.verify(f.request)).toBe(true);
  expect(await storedStep(f.account)).toBe(PREVIOUS_STEP);
  expect(await f.verifier.verify(f.request)).toBe(true);
  expect(await storedStep(f.account)).toBe(COLLISION_STEP);
  f.consume.mockClear();
  expect(await f.verifier.verify(f.request)).toBe(false);
  expect(f.consume.mock.calls).toEqual([
    [claim(PREVIOUS_STEP, f.account)],
    [claim(COLLISION_STEP, f.account)],
  ]);
  expect(await storedStep(f.account)).toBe(COLLISION_STEP);
});

// RFC 6238 Appendix B seed at 59 s (step 1): RFC 4226 Appendix D gives 287082 for counter 1 and
// 359152 for counter 2, each matching a single step of the window.
it('[AC-B1-34l#5] PG store: once step N is accepted, a code of step N-1 is refused', async () => {
  expectCollision();
  const f = await setup(59_000, null, '359152');
  expect(await f.verifier.verify(f.request)).toBe(true);
  expect(await storedStep(f.account)).toBe(2n);
  expect(await f.verifier.verify({ ...f.request, code: '287082' })).toBe(false);
  expect(f.consume.mock.calls).toEqual([[claim(2n, f.account)], [claim(1n, f.account)]]);
  expect(await storedStep(f.account)).toBe(2n);
});
