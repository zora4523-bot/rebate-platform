import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createUnionPidService,
  type RegisterPidInput,
} from '../../../../apps/api/src/modules/union/pids/service.ts';
import {
  EVIDENCE,
  PLATFORMS,
  START,
  accountRegistration,
  audits,
  harness,
  registration,
  rejectedUnchanged,
  seedAccount,
  seedAdmin,
  seedPid,
  state,
  storedPid,
  whitelist,
  type Harness,
} from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
});
afterAll(async () => {
  if (db) await destroyDb(db);
  if (database) await database.drop();
});

// Each entry is a public writing capability, including a PID's implicit sync_start_at write.
const commands = {
  account: async (h: Harness) => () => h.service.registerAccount(accountRegistration(h)),
  pid: async (h: Harness) => {
    const account = await seedAccount(h);
    const input = registration(h, account.id);
    return () => h.service.registerPid(input);
  },
  evidence: async (h: Harness) => {
    const pid = await seedPid(h, {
      hjy_ignore_confirmed_at: null,
      hjy_ignore_evidence_path: null,
    });
    return () =>
      h.service.confirmHjyIgnore({
        ...h.auth,
        pidId: pid.id,
        confirmedAt: h.clock.now(),
        evidencePath: EVIDENCE,
      });
  },
  activate: async (h: Harness) => {
    const pid = await seedPid(h);
    return () => h.service.setPidStatus({ ...h.auth, pidId: pid.id, status: 'active' });
  },
  retire: async (h: Harness) => {
    const pid = await seedPid(h, { status: 'active' });
    return () => h.service.setPidStatus({ ...h.auth, pidId: pid.id, status: 'retired' });
  },
};

for (const [name, prepare] of Object.entries(commands)) {
  for (const reason of [
    'not-super',
    'wrong-code',
    'unbound',
    'inactive',
    'replayed',
    'missing-account',
  ]) {
    it(`[AC-B1-19b#1] ${name}: combined verifier refuses ${reason}; no write`, async () => {
      const h = harness(db);
      await seedAdmin(h);
      const command = await prepare(h);
      h.verify.mockResolvedValue(null);
      await rejectedUnchanged(h, command);
      expect(h.verify).toHaveBeenCalledExactlyOnceWith({
        appId: h.appId,
        adminId: h.adminId,
        code: h.auth.code,
      });
      expect(h.append).not.toHaveBeenCalled();
    });
  }

  it(`[AC-B1-19b#2] ${name}: verifier outage fails closed`, async () => {
    const h = harness(db);
    const command = await prepare(h);
    h.verify.mockRejectedValue(new Error('synthetic verifier unavailable'));
    await rejectedUnchanged(h, command);
    expect(h.append).not.toHaveBeenCalled();
  });

  it(`[AC-B1-19b#3] ${name}: verified identity from another app is refused`, async () => {
    const h = harness(db);
    const command = await prepare(h);
    h.verify.mockResolvedValue({ appId: `${h.appId}-other`, adminId: h.adminId });
    await rejectedUnchanged(h, command);
    expect(h.append).not.toHaveBeenCalled();
  });

  it(`[AC-B1-19b#4] ${name}: audit append failure rolls back business and audit writes`, async () => {
    const h = harness(db);
    await seedAdmin(h);
    const command = await prepare(h);
    const append = h.append.getMockImplementation()!;
    h.append.mockImplementation(async (trx, input) => {
      await append(trx, input);
      throw new Error('synthetic audit failure after insert');
    });
    await rejectedUnchanged(h, command);
    expect(h.append).toHaveBeenCalled();
  });

  it(`[AC-B1-19b#5] ${name}: verified identity, IP, target, snapshots and Clock reach durable audit`, async () => {
    const h = harness(db);
    await seedAdmin(h);
    // Verifier normalizes UUIDs; the audit actor must come from its returned identity.
    const original = h.adminId;
    const upper = original.toUpperCase();
    h.auth = { ...h.auth, adminId: upper };
    const command = await prepare(h);
    const before = await state(h);
    const row = await command();
    const entries = await audits(h);
    const entry = entries.find((item) => item.target?.includes(row.id));
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      app_id: h.appId,
      admin_id: original,
      ip: h.auth.ip,
      at: new Date(START),
    });
    expect(entry!.action.length).toBeGreaterThan(0);
    expect(entry!.after).toMatchObject({ id: row.id, app_id: h.appId, status: row.status });
    if (name === 'account' || name === 'pid') {
      expect(entry!.before).toBeNull();
    } else {
      expect(entry!.before).toMatchObject({ id: row.id, status: before.pids[0]!.status });
    }
    if (name === 'evidence') {
      expect(entry!.before).toMatchObject({
        hjy_ignore_confirmed_at: null,
        hjy_ignore_evidence_path: null,
      });
      expect(entry!.after).toMatchObject({
        hjy_ignore_confirmed_at: START,
        hjy_ignore_evidence_path: EVIDENCE,
      });
    }
    expect(JSON.stringify(entries)).not.toContain(`"code":"${h.auth.code}"`);
    expect(h.verify).toHaveBeenCalledExactlyOnceWith({
      appId: h.appId,
      adminId: upper,
      code: h.auth.code,
    });
  });

  it(`[AC-B1-19b#25] ${name}: prior success never caches permission for a subsequent write`, async () => {
    const h = harness(db);
    await seedAdmin(h);
    const first = await prepare(h);
    await first();
    const second = await prepare(h);
    h.verify.mockResolvedValue(null);
    const auditCalls = h.append.mock.calls.length;
    await rejectedUnchanged(h, second);
    expect(h.verify).toHaveBeenCalledTimes(2);
    expect(h.append).toHaveBeenCalledTimes(auditCalls);
  });
}

for (const platform of PLATFORMS) {
  it(`[AC-B1-19b#6] ${platform}: registrations persist pending and first PID fixes sync start from Clock`, async () => {
    const h = harness(db);
    await seedAdmin(h);
    const account = await h.service.registerAccount(accountRegistration(h, platform));
    expect(account).toMatchObject({
      app_id: h.appId,
      platform,
      status: 'pending',
      sync_start_at: null,
      created_at: new Date(START),
      updated_at: new Date(START),
    });
    h.clock.advanceMs(60_000);
    const input = registration(h, account.id, platform);
    const pid = await h.service.registerPid(input);
    expect(pid).toMatchObject({
      app_id: h.appId,
      platform,
      union_account_id: account.id,
      site_id: input.siteId,
      pid: input.pid,
      pid_scene: input.pidScene,
      status: 'pending',
      hjy_ignore_confirmed_at: null,
      hjy_ignore_evidence_path: null,
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
    });
    const first = h.clock.now();
    h.clock.advanceMs(60_000);
    await h.service.registerPid(registration(h, account.id, platform));
    const stored = await db
      .selectFrom('union_accounts')
      .selectAll()
      .where('id', '=', account.id)
      .executeTakeFirstOrThrow();
    expect(stored.sync_start_at).toEqual(first);
    expect(
      await h.service.isWhitelisted({
        appId: h.appId,
        platform,
        unionAccountId: account.id,
        siteId: input.siteId,
        pid: pid.pid,
      }),
    ).toBe(true);
    expect(
      await h.service.getActivePid({
        appId: h.appId,
        platform,
        pidScene: 'self_buy',
        purpose: 'convert',
      }),
    ).toBeNull();
    const syncAudit = (await audits(h)).find(
      (item) =>
        item.target?.includes(account.id) &&
        JSON.stringify(item.after).includes(first.toISOString()),
    );
    expect(syncAudit, 'implicit account mutation is audited too').toBeDefined();
  });
}

it('[AC-B1-19b#7] caller cannot smuggle active status, evidence or sync-start into registration', async () => {
  const h = harness(db);
  await seedAdmin(h);
  // Extra properties may be rejected or ignored, never granted authority.
  const account = await h.service.registerAccount(accountRegistration(h));
  const input = {
    ...registration(h, account.id),
    status: 'active',
    hjy_ignore_confirmed_at: h.clock.now(),
    hjy_ignore_evidence_path: EVIDENCE,
    sync_start_at: new Date('2000-01-01T00:00:00Z'),
    isSuper: true,
  };
  await h.service.registerPid(input).catch(() => undefined);
  const stored = await state(h);
  for (const pid of stored.pids)
    expect(pid).toMatchObject({
      status: 'pending',
      hjy_ignore_confirmed_at: null,
      hjy_ignore_evidence_path: null,
    });
  expect(
    stored.accounts[0]!.sync_start_at === null ||
      stored.accounts[0]!.sync_start_at.getTime() === h.clock.now().getTime(),
  ).toBe(true);
});

it('[AC-B1-19b#8] cross-app or cross-platform account cannot receive a PID', async () => {
  const h = harness(db);
  await seedAdmin(h);
  const foreign = await seedAccount(h, { app_id: `${h.appId}-foreign` });
  const otherPlatform = await seedAccount(h, { platform: 'pdd' });
  for (const account of [foreign, otherPlatform]) {
    await rejectedUnchanged(h, () => h.service.registerPid(registration(h, account.id)));
    expect(
      await db
        .selectFrom('union_accounts')
        .selectAll()
        .where('id', '=', account.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(account);
  }
});

it('[AC-B1-19b#9] concurrent duplicate registration has one winner and no loser audit', async () => {
  const h = harness(db);
  await seedAdmin(h);
  const account = await seedAccount(h);
  const input = registration(h, account.id);
  const results = await Promise.allSettled([
    h.service.registerPid(input),
    h.service.registerPid(input),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const snapshot = await state(h);
  expect(snapshot.pids).toHaveLength(1);
  expect(snapshot.accounts[0]!.sync_start_at).toEqual(snapshot.pids[0]!.created_at);
  expect(
    snapshot.audits.filter((entry) => entry.target?.includes(snapshot.pids[0]!.id)),
  ).toHaveLength(1);
});

it('[AC-B1-19b#10] later Clock commits first; sync start still uses the earliest PID creation time', async () => {
  const h = harness(db);
  await seedAdmin(h);
  const account = await seedAccount(h);
  const otherClock = { now: () => new Date('2031-05-06T08:08:09Z') };
  const later = createUnionPidService({ ...h.deps, clock: otherClock });
  const laterPid = await later.registerPid(registration(h, account.id));
  const earlierPid = await h.service.registerPid(registration(h, account.id));
  expect(laterPid.created_at).toEqual(otherClock.now());
  expect(earlierPid.created_at).toEqual(h.clock.now());
  expect(earlierPid.created_at.getTime()).toBeLessThan(laterPid.created_at.getTime());
  const snapshot = await state(h);
  expect(snapshot.pids).toHaveLength(2);
  expect(snapshot.accounts[0]!.sync_start_at?.getTime()).toBe(
    Math.min(...snapshot.pids.map((pid) => pid.created_at.getTime())),
  );
});

it('[AC-B1-19b#26] PID identity uniqueness spans account, scene and retired status', async () => {
  const h = harness(db);
  await seedAdmin(h);
  const old = await seedPid(h, { status: 'retired' });
  const account = await seedAccount(h);
  await rejectedUnchanged(h, () =>
    h.service.registerPid({ ...registration(h, account.id), pid: old.pid, pidScene: 'share' }),
  );
  expect(
    await h.service.isWhitelisted({
      appId: h.appId,
      platform: 'jd',
      unionAccountId: old.union_account_id,
      siteId: null,
      pid: old.pid,
    }),
  ).toBe(true);
});

it('[AC-B1-19b#27] registration preserves the schema scene and Taobao-site constraints', async () => {
  const h = harness(db);
  await seedAdmin(h);
  for (const platform of PLATFORMS) {
    const account = await seedAccount(h, { platform });
    const input = registration(h, account.id, platform);
    for (const pidScene of ['', 'search', 'SELF_BUY']) {
      await rejectedUnchanged(h, () =>
        h.service.registerPid({ ...input, pidScene } as RegisterPidInput),
      );
    }
    await rejectedUnchanged(h, () =>
      h.service.registerPid({ ...input, siteId: platform === 'taobao' ? null : '200' }),
    );
  }
});

for (const pidScene of ['self_buy', 'share', 'agent', 'fallback', 'query'] as const) {
  it(`[AC-B1-19b#30] ${pidScene}: verified super registers the requested scene as pending and whitelisted`, async () => {
    const h = harness(db);
    await seedAdmin(h);
    const account = await seedAccount(h);
    const input = { ...registration(h, account.id), pidScene };
    const pid = await h.service.registerPid(input);
    const stored = await storedPid(h, pid.id);
    expect(stored).toMatchObject({
      app_id: h.appId,
      union_account_id: account.id,
      pid: input.pid,
      pid_scene: pidScene,
      status: 'pending',
    });
    expect(await h.service.isWhitelisted(whitelist(h, stored))).toBe(true);
    expect(h.verify).toHaveBeenCalledExactlyOnceWith({
      appId: h.appId,
      adminId: h.adminId,
      code: h.auth.code,
    });
    expect((await audits(h)).filter((entry) => entry.target?.includes(pid.id))).toHaveLength(1);
  });
}

it('[AC-B1-19b#28] missing code and caller-supplied super claims cannot bypass the combined verifier', async () => {
  const h = harness(db);
  const account = await seedAccount(h);
  h.verify.mockResolvedValue(null);
  const input = {
    ...registration(h, account.id),
    code: '',
    isSuper: true,
    role: 'super',
    verified: true,
    verifiedSuper: { appId: h.appId, adminId: h.adminId },
  };
  await rejectedUnchanged(h, () => h.service.registerPid(input));
  expect(h.append).not.toHaveBeenCalled();
});
