import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createUnionPidService } from '../../../../apps/api/src/modules/union/pids/service.ts';
import {
  EVIDENCE,
  PLATFORMS,
  harness,
  seedAccount,
  seedAdmin,
  seedPid,
  state,
  whitelist,
} from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
let readonlyDb: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  readonlyDb = createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 });
});
afterAll(async () => {
  if (readonlyDb) await destroyDb(readonlyDb);
  if (db) await destroyDb(db);
  if (database) await database.drop();
});

for (const platform of PLATFORMS) {
  for (const status of ['pending', 'active', 'retired'] as const) {
    it(`[AC-B1-19b#19] ${platform}/${status}: whitelist requires the complete identity, regardless of status`, async () => {
      const h = harness(db);
      const pid = await seedPid(h, { platform, status });
      const key = whitelist(h, pid);
      expect(await h.service.isWhitelisted(key)).toBe(true);
      const otherAccount = await seedAccount(h, { platform });
      for (const mismatch of [
        { appId: `${h.appId}-unknown` },
        { platform: platform === 'jd' ? ('pdd' as const) : ('jd' as const) },
        { unionAccountId: otherAccount.id },
        { pid: `${pid.pid}-not-ours` },
        ...(platform === 'taobao' ? [{ siteId: '999' }, { siteId: null }] : []),
      ]) {
        expect(await h.service.isWhitelisted({ ...key, ...mismatch })).toBe(false);
      }
      expect(h.verify).not.toHaveBeenCalled();
      expect(h.append).not.toHaveBeenCalled();
    });
  }
}

it('[AC-B1-19b#20] active lookup isolates app × platform × scene and never substitutes pending/retired', async () => {
  const h = harness(db);
  for (const status of ['pending', 'retired'] as const) await seedPid(h, { status });
  await seedPid({ ...h, appId: `${h.appId}-other` }, { status: 'active' });
  await seedPid(h, { platform: 'pdd', status: 'active' });
  await seedPid(h, { pid_scene: 'share', status: 'active' });
  const lookup = {
    appId: h.appId,
    platform: 'jd' as const,
    pidScene: 'self_buy' as const,
    purpose: 'convert' as const,
  };
  expect(await h.service.getActivePid(lookup)).toBeNull();
  const chosen = await seedPid(h, { status: 'active' });
  expect((await h.service.getActivePid(lookup))?.id).toBe(chosen.id);
  expect(await h.service.getActivePid({ ...lookup, appId: `${h.appId}-empty` })).toBeNull();
});

it('[AC-B1-19b#21] fallback is whitelist-only and query PID is usable only for price queries', async () => {
  const h = harness(db);
  const fallback = await seedPid(h, { pid_scene: 'fallback', status: 'active' });
  const query = await seedPid(h, { pid_scene: 'query', status: 'active' });
  const lookup = { appId: h.appId, platform: 'jd' as const, purpose: 'convert' as const };
  for (const pidScene of ['self_buy', 'share', 'agent', 'taolijin', 'fallback', 'query'] as const) {
    expect(await h.service.getActivePid({ ...lookup, pidScene })).toBeNull();
  }
  expect(
    await h.service.getActivePid({ ...lookup, purpose: 'query', pidScene: 'fallback' }),
  ).toBeNull();
  expect(
    (await h.service.getActivePid({ ...lookup, purpose: 'query', pidScene: 'query' }))?.id,
  ).toBe(query.id);
  expect(await h.service.isWhitelisted(whitelist(h, fallback))).toBe(true);
  expect(await h.service.isWhitelisted(whitelist(h, query))).toBe(true);
});

for (const pidScene of ['self_buy', 'share', 'agent', 'taolijin'] as const) {
  it(`[AC-B1-19b#22] ${pidScene}: exact active scene lookup`, async () => {
    const h = harness(db);
    const pid = await seedPid(h, { pid_scene: pidScene, status: 'active' });
    expect(
      (
        await h.service.getActivePid({
          appId: h.appId,
          platform: 'jd',
          pidScene,
          purpose: 'convert',
        })
      )?.id,
    ).toBe(pid.id);
  });
}

it('[AC-B1-19b#23] queries work using a read-only DB role, with no verification or audit side effects', async () => {
  const h = harness(db);
  const pid = await seedPid(h, { status: 'active' });
  const before = await state(h);
  h.verify.mockRejectedValue(new Error('queries must not call verification'));
  h.append.mockRejectedValue(new Error('queries must not append audit'));
  const reader = createUnionPidService({ ...h.deps, db: readonlyDb });
  expect(await reader.isWhitelisted(whitelist(h, pid))).toBe(true);
  expect(
    (
      await reader.getActivePid({
        appId: h.appId,
        platform: 'jd',
        pidScene: 'self_buy',
        purpose: 'convert',
      })
    )?.id,
  ).toBe(pid.id);
  expect(await state(h)).toEqual(before);
  expect(h.verify).not.toHaveBeenCalled();
  expect(h.append).not.toHaveBeenCalled();
});

it('[AC-B1-19b#24] provisional task default: earliest activation wins, not creation or last update', async () => {
  // Task §2 explicitly lists this as a provisional default awaiting owner confirmation.
  // Exercise genuine activation commands so no new storage column is dictated by this test.
  const h = harness(db);
  await seedAdmin(h);
  const older = await seedPid(h);
  h.clock.advanceMs(60_000);
  const newer = await seedPid(h);
  await h.service.setPidStatus({ ...h.auth, pidId: newer.id, status: 'active' });
  h.clock.advanceMs(60_000);
  await h.service.setPidStatus({ ...h.auth, pidId: older.id, status: 'active' });
  const lookup = {
    appId: h.appId,
    platform: 'jd' as const,
    pidScene: 'self_buy' as const,
    purpose: 'convert' as const,
  };
  expect((await h.service.getActivePid(lookup))?.id).toBe(newer.id);
  h.clock.advanceMs(60_000);
  // A permitted evidence correction must not change activation order. Refusing corrections
  // after activation is also valid here: BR-ATTR-28 only mandates filling pending evidence.
  await h.service
    .confirmHjyIgnore({
      ...h.auth,
      pidId: newer.id,
      confirmedAt: h.clock.now(),
      evidencePath: EVIDENCE,
    })
    .catch(() => undefined);
  expect((await h.service.getActivePid(lookup))?.id).toBe(newer.id);
  await h.service.setPidStatus({ ...h.auth, pidId: newer.id, status: 'retired' });
  expect((await h.service.getActivePid(lookup))?.id).toBe(older.id);
  expect(await h.service.isWhitelisted(whitelist(h, newer))).toBe(true);
});
