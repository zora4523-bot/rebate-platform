import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type {
  ConfirmHjyInput,
  SetPidStatusInput,
} from '../../../../apps/api/src/modules/union/pids/service.ts';
import {
  EVIDENCE,
  PLATFORMS,
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

for (const platform of PLATFORMS) {
  it(`[AC-B1-19b#11] ${platform}: pending → evidence → active → retired; whitelist retained`, async () => {
    const h = harness(db);
    await seedAdmin(h);
    const account = await h.service.registerAccount(accountRegistration(h, platform));
    const pid = await h.service.registerPid(registration(h, account.id, platform));
    const key = whitelist(h, pid);
    const lookup = {
      appId: h.appId,
      platform,
      pidScene: 'self_buy' as const,
      purpose: 'convert' as const,
    };
    expect(await h.service.isWhitelisted(key)).toBe(true);
    expect(await h.service.getActivePid(lookup)).toBeNull();
    h.clock.advanceMs(60_000);
    const confirmedAt = h.clock.now();
    const confirmed = await h.service.confirmHjyIgnore({
      ...h.auth,
      pidId: pid.id,
      confirmedAt,
      evidencePath: EVIDENCE,
    });
    expect(confirmed).toMatchObject({
      id: pid.id,
      status: 'pending',
      hjy_ignore_confirmed_at: confirmedAt,
      hjy_ignore_evidence_path: EVIDENCE,
    });
    expect(await h.service.getActivePid(lookup)).toBeNull();
    h.clock.advanceMs(60_000);
    const active = await h.service.setPidStatus({ ...h.auth, pidId: pid.id, status: 'active' });
    expect(active).toMatchObject({
      status: 'active',
      created_at: pid.created_at,
      updated_at: h.clock.now(),
    });
    expect((await h.service.getActivePid(lookup))?.id).toBe(pid.id);
    h.clock.advanceMs(60_000);
    const retired = await h.service.setPidStatus({ ...h.auth, pidId: pid.id, status: 'retired' });
    expect(retired).toMatchObject({
      status: 'retired',
      hjy_ignore_confirmed_at: confirmedAt,
      hjy_ignore_evidence_path: EVIDENCE,
      created_at: pid.created_at,
      updated_at: h.clock.now(),
    });
    expect(await h.service.getActivePid(lookup)).toBeNull();
    expect(await h.service.isWhitelisted(key)).toBe(true);
    expect(await storedPid(h, pid.id)).toEqual(retired);
    const snapshot = await state(h);
    expect(snapshot.pids).toHaveLength(1);
    expect(snapshot.accounts[0]!.sync_start_at).toEqual(pid.created_at);
    expect(h.verify).toHaveBeenCalledTimes(5);
    expect((await audits(h)).filter((entry) => entry.target?.includes(pid.id))).toHaveLength(4);
  });
}

for (const [confirmedAt, evidencePath] of [
  [null, null],
  [new Date('2031-05-06T07:08:09Z'), null],
  [null, EVIDENCE],
  [new Date('2031-05-06T07:08:09Z'), ''],
  [new Date('2031-05-06T07:08:09Z'), ' \t\n '],
] as const) {
  it(`[AC-B1-19b#12] activation validates stored confirmation and nonblank screenshot: ${String(confirmedAt)}/${JSON.stringify(evidencePath)}`, async () => {
    const h = harness(db);
    await seedAdmin(h);
    const pid = await seedPid(h, {
      hjy_ignore_confirmed_at: confirmedAt,
      hjy_ignore_evidence_path: evidencePath,
    });
    await rejectedUnchanged(h, () =>
      h.service.setPidStatus({ ...h.auth, pidId: pid.id, status: 'active' }),
    );
    expect(await h.service.isWhitelisted(whitelist(h, pid))).toBe(true);
  });
}

for (const [caseIndex, bad] of [
  { confirmedAt: new Date(Number.NaN), evidencePath: EVIDENCE },
  { confirmedAt: null, evidencePath: EVIDENCE },
  { confirmedAt: 'not-an-instant', evidencePath: EVIDENCE },
  { confirmedAt: new Date('2031-05-06T07:08:09Z'), evidencePath: null },
  { confirmedAt: new Date('2031-05-06T07:08:09Z'), evidencePath: '' },
  { confirmedAt: new Date('2031-05-06T07:08:09Z'), evidencePath: ' \t\n ' },
].entries()) {
  it(`[AC-B1-19b#13] invalid HJY confirmation rejected atomically, case ${caseIndex}: ${JSON.stringify(bad)}`, async () => {
    const h = harness(db);
    await seedAdmin(h);
    const pid = await seedPid(h, { hjy_ignore_confirmed_at: null, hjy_ignore_evidence_path: null });
    const input = { ...h.auth, pidId: pid.id, ...bad } as unknown as ConfirmHjyInput;
    await rejectedUnchanged(h, () => h.service.confirmHjyIgnore(input));
  });
}

for (const status of ['active', 'retired'] as const) {
  it(`[AC-B1-19b#29] ${status}: later evidence changes cannot clear the activation prerequisites`, async () => {
    const h = harness(db);
    await seedAdmin(h);
    const pid = await seedPid(h, { status });
    await rejectedUnchanged(h, () =>
      h.service.confirmHjyIgnore({
        ...h.auth,
        pidId: pid.id,
        confirmedAt: h.clock.now(),
        evidencePath: ' \t\n ',
      }),
    );
    expect(await h.service.isWhitelisted(whitelist(h, pid))).toBe(true);
  });
}

for (const [from, to] of [
  ['pending', 'retired'],
  ['active', 'pending'],
  ['retired', 'active'],
  ['retired', 'pending'],
  ['pending', 'deleted'],
  ['active', 'deleted'],
  ['retired', 'deleted'],
] as const) {
  it(`[AC-B1-19b#14] illegal transition ${from} → ${to} cannot change or delete the row`, async () => {
    const h = harness(db);
    await seedAdmin(h);
    const pid = await seedPid(h, { status: from });
    await rejectedUnchanged(h, () =>
      h.service.setPidStatus({ ...h.auth, pidId: pid.id, status: to } as SetPidStatusInput),
    );
    expect(await h.service.isWhitelisted(whitelist(h, pid))).toBe(true);
  });
}

it('[AC-B1-19b#15] account and PID deletion capabilities are absent', () => {
  const h = harness(db);
  expect('deleteAccount' in h.service).toBe(false);
  expect('deletePid' in h.service).toBe(false);
  expect('removeAccount' in h.service).toBe(false);
  expect('removePid' in h.service).toBe(false);
});

it('[AC-B1-19b#16] another app cannot confirm, activate or retire a PID by its UUID', async () => {
  const h = harness(db);
  await seedAdmin(h);
  const foreign = { ...h, appId: `${h.appId}-foreign` };
  const account = await seedAccount(foreign);
  for (const status of ['pending', 'active'] as const) {
    const pid = await seedPid(foreign, { union_account_id: account.id, status });
    const before = await state(foreign);
    await rejectedUnchanged(h, () =>
      h.service.confirmHjyIgnore({
        ...h.auth,
        pidId: pid.id,
        confirmedAt: h.clock.now(),
        evidencePath: 'fixtures/other.png',
      }),
    );
    await rejectedUnchanged(h, () =>
      h.service.setPidStatus({
        ...h.auth,
        pidId: pid.id,
        status: status === 'pending' ? 'active' : 'retired',
      }),
    );
    expect(await state(foreign)).toEqual(before);
  }
});

it('[AC-B1-19b#17] a confirmed Taobao media sibling does not authorize an unconfirmed PID', async () => {
  const h = harness(db);
  await seedAdmin(h);
  const account = await seedAccount(h, { platform: 'taobao' });
  await seedPid(h, {
    platform: 'taobao',
    union_account_id: account.id,
    pid: 'mm_100_200_300',
    status: 'active',
  });
  const pid = await seedPid(h, {
    platform: 'taobao',
    union_account_id: account.id,
    pid: 'mm_100_200_301',
    hjy_ignore_confirmed_at: null,
    hjy_ignore_evidence_path: null,
  });
  await rejectedUnchanged(h, () =>
    h.service.setPidStatus({ ...h.auth, pidId: pid.id, status: 'active' }),
  );
  expect(await h.service.isWhitelisted(whitelist(h, pid))).toBe(true);
});

it('[AC-B1-19b#18] concurrent activation produces at most one status-change audit', async () => {
  const h = harness(db);
  await seedAdmin(h);
  const pid = await seedPid(h);
  const input = { ...h.auth, pidId: pid.id, status: 'active' as const };
  const results = await Promise.allSettled([
    h.service.setPidStatus(input),
    h.service.setPidStatus(input),
  ]);
  expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
  expect((await storedPid(h, pid.id)).status).toBe('active');
  // A repeated command may reject or return its existing result, but cannot activate twice.
  const changes = (await audits(h)).filter((entry) => {
    const before = entry.before as { status?: string } | null;
    const after = entry.after as { status?: string } | null;
    return before?.status === 'pending' && after?.status === 'active';
  });
  expect(changes).toHaveLength(1);
});
