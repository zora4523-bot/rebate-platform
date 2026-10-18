import { createDb, destroyDb } from '@couli/db';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createInviteBackfillActivityReader } from '../../../../apps/api/src/modules/identity/infra/me-reads.ts';
import {
  CODE,
  OTHER_CODE,
  withHttp,
  seed,
  client,
  answer,
  row,
  logs,
  callsFor,
} from '../backfill/http-kit.ts';
import { CLAIM_CASES, claim } from './kit.ts';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let redis: Awaited<ReturnType<typeof acquireTestRedis>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  redis = await acquireTestRedis();
}, 180_000);
afterAll(async () => {
  try {
    await redis?.stop();
  } finally {
    try {
      if (db) await destroyDb(db);
    } finally {
      await database?.drop();
    }
  }
});

// B1-11p §9.2: real AppModule, transaction-scoped activity reader and HTTP mapping.
// The shared spy delegates to the real binder; no forced result or activity override.
for (const specimen of CLAIM_CASES) {
  it(`[AC-B1-11p#1] 本人无申请可绑定；本人有 ${specimen[0]} 真实申请时 HTTP 回 30409 且关系、日志零写入`, async () => {
    await withHttp(db, redis.url, async (f) => {
      const parent = await seed(f, CODE);
      // Another user's claim (even the inviter's) must not disqualify the applicant.
      await claim(f.db, f.appId, parent, specimen, f.clock.now());
      const clean = await client(f, { uid: await seed(f, OTHER_CODE) });
      answer(f, await clean.post());
      expect(await row(f, clean.uid)).toMatchObject({
        parent_id: parent,
        self_bind_used: true,
        parent_bind_source: 'backfill',
        parent_bound_at: f.clock.now(),
      });
      expect(await logs(f, clean.uid)).toMatchObject([
        { from_parent_id: null, to_parent_id: parent, source: 'backfill' },
      ]);

      const applicant = await client(f);
      const savedClaim = await claim(f.db, f.appId, applicant.uid, specimen, f.clock.now());
      const before = await row(f, applicant.uid);
      expect(await logs(f, applicant.uid)).toEqual([]);
      const response = await applicant.post();
      // Soft assertions preserve evidence of every forbidden write on the red baseline.
      expect.soft(await row(f, applicant.uid)).toEqual(before);
      expect.soft(await logs(f, applicant.uid)).toEqual([]);
      answer(f, response, 30409);
      expect(callsFor(f, applicant.uid)).toEqual([
        {
          transactional: true,
          command: {
            app_id: f.appId,
            user_id: applicant.uid,
            device_id: applicant.deviceId,
            channel: 'backfill',
            invite_code: CODE,
          },
        },
      ]);
      expect(
        await f.db.selectFrom('claims').selectAll().where('id', '=', savedClaim.id).execute(),
      ).toEqual([savedClaim]);
    });
  });
}

it('[AC-B1-11p#3] hasClaims 同时限定 app_id 与 user_id，且读取提交后最新状态', async () => {
  await withHttp(db, redis.url, async (f) => {
    const owner = await seed(f, CODE);
    const other = await seed(f, OTHER_CODE);
    const reader = createInviteBackfillActivityReader(f.db);
    const subject = { appId: f.appId, userId: owner };
    expect(await reader.hasClaims(subject)).toBe(false);
    await claim(f.db, f.appId, owner, CLAIM_CASES[0], f.clock.now());
    expect(await reader.hasClaims({ appId: f.appId, userId: other })).toBe(false);
    // A mismatched tenant/user pair cannot see this row (users.id is globally unique).
    expect(await reader.hasClaims({ appId: `${f.appId}_other`, userId: owner })).toBe(false);
    expect(await reader.hasClaims(subject)).toBe(true);
  });
});
