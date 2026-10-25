// B1-09i: the manual sync use case over the real order_sync_requests table, with union's access
// port and the queue replaced: the offline breaker of the platform is per process (02 §6.2), so its
// open state is reached only through the port.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createManualOrderSyncs } from '../../../../apps/api/src/modules/orders/application/manual-sync.ts';
import type {
  SyncAccessPort,
  SyncAccount,
} from '../../../../apps/api/src/modules/orders/application/sync-ports.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { JobQueue } from '../../../../apps/api/src/modules/platform/index.ts';

const NOW = '2026-10-09T02:00:00.000Z';
const MIN = 60_000;
const FROM_MS = Date.parse(NOW) - 180 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 }).withSchema('app');
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

async function scenario() {
  const appId = `msync_${randomUUID().replaceAll('-', '')}`;
  const adminId = randomUUID();
  await db
    .insertInto('admin_users')
    .values({
      id: adminId,
      app_id: appId,
      login_name: `msync-${adminId}`,
      password_hash: 'synthetic-not-a-hash',
      is_super: false,
      status: 'active',
    })
    .execute();
  const own: SyncAccount = {
    app_id: appId,
    platform: 'pdd',
    union_account_id: randomUUID(),
    sync_start_at: null,
  };
  const accounts: SyncAccount[] = [
    { ...own, app_id: `msync_${randomUUID().replaceAll('-', '')}`, union_account_id: randomUUID() },
    { ...own, platform: 'jd', union_account_id: randomUUID() },
    own,
  ];
  const state = { open: false, auth: true };
  const access = {
    listEnabledAccounts: vi.fn<SyncAccessPort['listEnabledAccounts']>(async () => accounts),
    siteAuthAvailable: vi.fn<SyncAccessPort['siteAuthAvailable']>(async () => state.auth),
    offlineCircuitOpen: vi.fn<SyncAccessPort['offlineCircuitOpen']>(async () => state.open),
  };
  const send = vi.fn<JobQueue['send']>(async () => randomUUID());
  const syncs = createManualOrderSyncs({
    db,
    clock: new FixedClock(NOW),
    queue: { send },
    access,
  });
  const rows = () =>
    db.selectFrom('order_sync_requests').selectAll().where('app_id', '=', appId).execute();
  return { appId, adminId, own, state, access, send, syncs, rows };
}

const body = (startMs: number, minutes: number) =>
  ({ platform: 'pdd', from: iso(startMs), to: iso(startMs + minutes * MIN) }) as const;

it('[AC-B1-09i#25] 熔断关闭时只按本应用该平台的联盟账号逐窗投递；熔断打开期间不投递', async () => {
  const s = await scenario();
  await s.syncs.create({ appId: s.appId, adminId: s.adminId }, body(FROM_MS, 60));
  const sent = s.send.mock.calls.filter(([queue]) => queue === 'order-sync');
  expect(sent).toHaveLength(2);
  for (const [, , payload] of sent) {
    expect(payload).toMatchObject({
      app_id: s.appId,
      platform: 'pdd',
      union_account_id: s.own.union_account_id,
    });
  }
  s.state.open = true;
  s.send.mockClear();
  await s.syncs
    .create({ appId: s.appId, adminId: s.adminId }, body(FROM_MS + 60 * MIN, 60))
    .catch(() => undefined);
  expect(s.access.offlineCircuitOpen).toHaveBeenCalledWith('pdd');
  expect(s.send).not.toHaveBeenCalled();
});

it('[AC-B1-09i#26] 端口判定站长授权暂停时拒绝且不建请求不投递；判定对象是本应用该平台的账号', async () => {
  const s = await scenario();
  await s.syncs.create({ appId: s.appId, adminId: s.adminId }, body(FROM_MS, 20));
  expect(s.send.mock.calls.filter(([queue]) => queue === 'order-sync')).toHaveLength(1);
  expect(s.access.siteAuthAvailable).toHaveBeenCalledWith(
    expect.objectContaining({
      app_id: s.appId,
      platform: 'pdd',
      union_account_id: s.own.union_account_id,
    }),
  );
  expect(await s.rows()).toHaveLength(1);
  s.state.auth = false;
  s.send.mockClear();
  await expect(
    s.syncs.create({ appId: s.appId, adminId: s.adminId }, body(FROM_MS + 60 * MIN, 20)),
  ).rejects.toBeDefined();
  await expect(
    s.syncs.create(
      { appId: s.appId, adminId: s.adminId },
      { platform: 'pdd', order_nos: ['231006-1234567891'] },
    ),
  ).rejects.toBeDefined();
  expect(s.send).not.toHaveBeenCalled();
  expect(await s.rows()).toHaveLength(1);
});
