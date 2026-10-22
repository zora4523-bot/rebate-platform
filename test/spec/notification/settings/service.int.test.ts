// Real business-role PostgreSQL: persistence, isolation, timestamps and concurrent upserts.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
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
  '[AC-B1-12m#9] 同账号并发首次PUT都成功，唯一行保存某一完整请求而非混合值',
  async () => {
    const f = await fixture();
    const service = createNotificationSettings({ db, clock: f.clock });
    const first = { service_push: false, subscription_push: true, marketing_push: false };
    const second = { service_push: true, subscription_push: false, marketing_push: true };
    expect(await settingsOf(db, f.owner)).toEqual([]);
    const results = await Promise.allSettled([
      service.update(f.owner, first),
      service.update(f.owner, second),
    ]);
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
  },
  TIMEOUT,
);
