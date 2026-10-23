// Real business-role PostgreSQL: persistence, isolation, timestamps and concurrent upserts.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createNotificationSettings } from '../../../../apps/api/src/modules/notification/application/notification-settings.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  COMBINATIONS,
  NOW,
  OFF,
  ON,
  TIMEOUT,
  expectSchema,
  newAppId,
  seedSettings,
  seedUser,
  settingsOf,
} from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
let readonlyDb: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
  readonlyDb = createDb({ connectionString: database.urlFor('couli_readonly'), max: 2 });
}, 180_000);
afterAll(async () => {
  try {
    if (db !== undefined) await destroyDb(db);
    if (readonlyDb !== undefined) await destroyDb(readonlyDb);
  } finally {
    await database?.drop();
  }
}, 30_000);

async function fixture() {
  const app_id = newAppId('settings');
  const otherApp = newAppId('foreign');
  return {
    owner: { app_id, user_id: await seedUser(db, app_id) },
    someone: { app_id, user_id: await seedUser(db, app_id) },
    abroad: { app_id: otherApp, user_id: await seedUser(db, otherApp) },
    clock: new FixedClock(NOW),
  };
}

/** Polls until `count` backends of this database wait on a PG lock in a statement on `table`. */
async function lockWaiters(count: number, table: string) {
  let waiting = 0;
  for (let attempt = 0; attempt < 250 && waiting < count; attempt += 1) {
    if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const result = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and wait_event_type = 'Lock' and query like ${`%${table}%`}`.execute(db);
    waiting = result.rows[0]!.n;
  }
  const reason = `${count} calls must wait on a PG lock before it is released`;
  expect(waiting, reason).toBeGreaterThanOrEqual(count);
}

/**
 * Deterministic interleaving: `lock` takes one row lock in a transaction of its own; the calls
 * start in `order`, each only after every earlier one waits on PG, and the lock is released once
 * all of them wait. Returns the calls' promises indexed like `calls`.
 */
async function interleaved<T>(
  lock: (trx: Transaction<DB>) => Promise<unknown[]>,
  calls: readonly (() => Promise<T>)[],
  order: readonly number[],
  table: string,
): Promise<Promise<T>[]> {
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = db.transaction().execute(async (trx) => {
    expect(await lock(trx)).toHaveLength(1);
    locked.resolve();
    await release.promise;
  });
  const started: Promise<T>[] = [];
  try {
    await Promise.race([locked.promise, holder]);
    for (const [arrived, index] of order.entries()) {
      const pending = calls[index]!();
      void pending.catch(() => undefined);
      started[index] = pending;
      await lockWaiters(arrived + 1, table);
    }
  } finally {
    release.resolve();
    await holder;
  }
  return started;
}

it(
  '[AC-B1-12m#4] 无行GET返回三个true，不插行，也不借用其他账号的设置',
  async () => {
    const f = await fixture();
    await seedSettings(db, f.someone, OFF);
    await seedSettings(db, f.abroad, OFF);
    const before = await settingsOf(db, f.someone);
    const abroadBefore = await settingsOf(db, f.abroad);
    const service = createNotificationSettings({ db: readonlyDb, clock: f.clock });
    for (let i = 0; i < 2; i += 1) {
      const result = await service.get(f.owner);
      expect(result).toEqual(ON);
      await expectSchema('getNotificationSettings', 'data', result);
      expect(await settingsOf(db, f.owner)).toEqual([]);
    }
    expect(await settingsOf(db, f.someone)).toEqual(before);
    expect(await settingsOf(db, f.abroad)).toEqual(abroadBefore);
  },
  TIMEOUT,
);

it(
  '[AC-B1-12m#5][BR-WATCH-19] 已存设置GET精确保留每类布尔值，只读且同时限定app_id和user_id',
  async () => {
    const f = await fixture();
    const service = createNotificationSettings({ db: readonlyDb, clock: f.clock });
    for (const settings of COMBINATIONS) {
      const owner = { app_id: f.owner.app_id, user_id: await seedUser(db, f.owner.app_id) };
      await seedSettings(db, owner, settings);
      const before = await settingsOf(db, owner);
      expect(await service.get(owner)).toEqual(settings);
      expect(await service.get({ ...owner, app_id: f.abroad.app_id })).toEqual(ON);
      expect(await settingsOf(db, owner)).toEqual(before);
    }
    expect(await service.get(f.someone)).toEqual(ON);
  },
  TIMEOUT,
);

it(
  '[AC-B1-12m#6] 首次PUT插入一行，三个开关完整保存，时间来自Clock、版本取表默认',
  async () => {
    const f = await fixture();
    const service = createNotificationSettings({ db, clock: f.clock });
    for (const settings of COMBINATIONS) {
      const owner = { app_id: f.owner.app_id, user_id: await seedUser(db, f.owner.app_id) };
      const result = await service.update(owner, settings);
      expect(result).toEqual(settings);
      await expectSchema('updateNotificationSettings', 'data', result);
      expect(await settingsOf(db, owner)).toEqual([
        {
          ...owner,
          ...settings,
          row_version: 0,
          created_at: f.clock.now(),
          updated_at: f.clock.now(),
        },
      ]);
      expect(await service.get(owner)).toEqual(settings);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-12m#7] 后续PUT整体替换、版本递增、保留created_at，反复开关不影响同app他人或其他app',
  async () => {
    const f = await fixture();
    await seedSettings(db, f.owner, ON);
    await seedSettings(db, f.someone, OFF);
    await seedSettings(db, f.abroad, ON);
    const [original] = await settingsOf(db, f.owner);
    const someoneBefore = await settingsOf(db, f.someone);
    const abroadBefore = await settingsOf(db, f.abroad);
    const service = createNotificationSettings({ db, clock: f.clock });
    let version = original!.row_version;
    for (const settings of COMBINATIONS) {
      f.clock.advanceMs(7_000);
      expect(await service.update(f.owner, settings)).toEqual(settings);
      version += 1;
      expect(await settingsOf(db, f.owner)).toEqual([
        { ...original, ...settings, row_version: version, updated_at: f.clock.now() },
      ]);
      expect(await service.get(f.owner)).toEqual(settings);
      expect(await settingsOf(db, f.someone)).toEqual(someoneBefore);
      expect(await settingsOf(db, f.abroad)).toEqual(abroadBefore);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-12m#8] 同一内容重复PUT返回值不变且始终仅一行',
  async () => {
    const f = await fixture();
    const service = createNotificationSettings({ db, clock: f.clock });
    const settings = { service_push: false, subscription_push: true, marketing_push: false };
    expect(await service.update(f.owner, settings)).toEqual(settings);
    const [original] = await settingsOf(db, f.owner);
    for (let i = 0; i < 3; i += 1) {
      f.clock.advanceMs(1_000);
      expect(await service.update(f.owner, settings)).toEqual(settings);
      expect(await service.get(f.owner)).toEqual(settings);
      const rows = await settingsOf(db, f.owner);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ...f.owner, ...settings, created_at: original!.created_at });
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-12m#9] 同账号并发首次PUT都成功，唯一行保存某一完整请求而非混合值（确定性交错）',
  async () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const f = await fixture();
      const service = createNotificationSettings({ db, clock: f.clock });
      const first = { service_push: false, subscription_push: true, marketing_push: false };
      const second = { service_push: true, subscription_push: false, marketing_push: true };
      expect(await settingsOf(db, f.owner)).toEqual([]);
      // The account's users row is locked FOR UPDATE elsewhere, so the earlier PUT's insert stops
      // in its foreign-key check with its row already in the primary key, and the later PUT meets
      // that uncommitted row: check-then-insert answers 23505, insert-or-ignore keeps the earlier
      // values while the later PUT reports its own.
      const results = await Promise.allSettled(
        await interleaved(
          (trx) =>
            trx
              .withSchema('app')
              .selectFrom('users')
              .select('id')
              .where('app_id', '=', f.owner.app_id)
              .where('id', '=', f.owner.user_id)
              .forUpdate()
              .execute(),
          [() => service.update(f.owner, first), () => service.update(f.owner, second)],
          order,
          'notification_settings',
        ),
      );
      expect(results).toEqual([
        { status: 'fulfilled', value: first },
        { status: 'fulfilled', value: second },
      ]);
      const saved = await service.get(f.owner);
      expect([first, second]).toContainEqual(saved);
      expect(await settingsOf(db, f.owner)).toEqual([
        {
          ...f.owner,
          ...saved,
          created_at: f.clock.now(),
          updated_at: f.clock.now(),
          row_version: 1,
        },
      ]);
      // The later PUT becomes the update of the committed earlier row, so its values are kept.
      expect(saved).toEqual([first, second][order[1]!]);
    }
  },
  TIMEOUT,
);
