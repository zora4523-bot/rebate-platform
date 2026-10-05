// F1-02b acceptance of content/index.ts's createContentReader({ db, clock }).
// The full public shape and explicit cache/error choices are in ./kit.ts's header.
// Real PostgreSQL, one isolated clone for this file, business-role handles only.
// Every factory call is inside an it body, outside any rejection assertion, so the skeleton
// makes every case red with NotImplemented rather than a hook/import failure or a false pass.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createContentReader } from '../../../../apps/api/src/modules/content/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  CACHE_MS,
  START,
  changeConfig,
  observeQueries,
  seedConfig,
  seedVersion,
  type Json,
} from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
});

afterAll(async () => {
  await destroyDb(db);
  await database.drop();
});

it('[AC-F1-02b#1] BR-ID-01 判定、04 §3.2：三端按端和渠道返回最低版本，不能拿最新或推荐版本代替', async () => {
  const appId = 'content_read_1';
  const rows = [
    ['ios', 'appstore', '1.2.3'],
    ['android', 'official', '2.10.0'],
    ['android', 'huawei', '3.0.4'],
    ['harmony', 'agc', '10.20.30'],
  ] as const;
  for (const [platform, channel, minimum] of rows) {
    await seedVersion(db, appId, platform, channel, minimum);
  }
  const reader = createContentReader({ db, clock: new FixedClock(START) });
  for (const [platform, channel, minimum] of rows) {
    expect(await reader.minSupportedVersion(appId, platform, channel)).toBe(minimum);
  }
});

it('[AC-F1-02b#2] BR-ID-01 没有配置行：端或渠道不匹配均返回 null，不回退到其他行', async () => {
  const appId = 'content_read_2';
  await seedVersion(db, appId, 'android', 'official', '2.0.0');
  const reader = createContentReader({ db, clock: new FixedClock(START) });
  expect(await reader.minSupportedVersion(appId, 'ios', 'official')).toBeNull();
  expect(await reader.minSupportedVersion(appId, 'android', 'huawei')).toBeNull();
  expect(await reader.minSupportedVersion(appId, 'harmony', 'agc')).toBeNull();
});

it('[AC-F1-02b#3] BR-ID-01 没有设最低版本：已配置最新和推荐版本仍返回 null', async () => {
  const appId = 'content_read_3';
  await seedVersion(db, appId, 'android', 'official', null);
  const reader = createContentReader({ db, clock: new FixedClock(START) });
  expect(await reader.minSupportedVersion(appId, 'android', 'official')).toBeNull();
});

it('[AC-F1-02b#4] 04 §3.2、db/schema.sql app_id：同端同渠道在不同应用间隔离，包括本应用无行', async () => {
  const clock = new FixedClock(START);
  await seedVersion(db, 'content_read_4_a', 'android', 'official', '1.0.0');
  await seedVersion(db, 'content_read_4_b', 'android', 'official', '8.0.0');
  const reader = createContentReader({ db, clock });
  expect(await reader.minSupportedVersion('content_read_4_a', 'android', 'official')).toBe('1.0.0');
  expect(await reader.minSupportedVersion('content_read_4_b', 'android', 'official')).toBe('8.0.0');
  expect(
    await reader.minSupportedVersion('content_read_4_missing', 'android', 'official'),
  ).toBeNull();
  expect(await reader.minSupportedVersion('content_read_4_a', 'android', 'official')).toBe('1.0.0');
});

it('[AC-F1-02b#5] BR-ID-01 h5、admin 不判定：即使有最低版本配置也返回 null，且不依赖数据库可用', async () => {
  const appId = 'content_read_5';
  await seedVersion(db, appId, 'h5', 'official', '7.0.0');
  await seedVersion(db, appId, 'admin', 'official', '8.0.0');
  const probe = observeQueries(db);
  probe.state.failure = new Error('database unavailable for this read');
  const reader = createContentReader({ db: probe.db, clock: new FixedClock(START) });
  expect(await reader.minSupportedVersion(appId, 'h5', 'official')).toBeNull();
  expect(await reader.minSupportedVersion(appId, 'admin', 'official')).toBeNull();
  expect(probe.queries).toHaveLength(0);
});

it('[AC-F1-02b#6] 02 §10、04 §3.2 config_items：JSON 各形状原样返回，version 不混用 row_version', async () => {
  const appId = 'content_read_6';
  const values: Json[] = [
    { text: '说明', nested: { enabled: false }, items: [null, 0, '域名'] },
    ['a', { enabled: true }, 2],
    '文案',
    '',
    0,
    123,
    false,
    true,
    null,
    {},
    [],
  ];
  for (const [index, value] of values.entries()) {
    await seedConfig(db, appId, `shape.${String(index)}`, value, index + 2);
  }
  const reader = createContentReader({ db, clock: new FixedClock(START) });
  for (const [index, value] of values.entries()) {
    expect(await reader.configValue(appId, `shape.${String(index)}`)).toStrictEqual({
      value,
      version: index + 2,
    });
  }
});

it('[AC-F1-02b#7] 04 §3.2、db/schema.sql app_id/key：不同应用同键和同应用不同键的值与缓存不串用', async () => {
  const clock = new FixedClock(START);
  await seedConfig(db, 'content_read_7_a', 'shared', { app: 'A' }, 2);
  await seedConfig(db, 'content_read_7_b', 'shared', { app: 'B' }, 5);
  await seedConfig(db, 'content_read_7_a', 'other', false, 3);
  const reader = createContentReader({ db, clock });
  expect(await reader.configValue('content_read_7_a', 'shared')).toStrictEqual({
    value: { app: 'A' },
    version: 2,
  });
  expect(await reader.configValue('content_read_7_b', 'shared')).toStrictEqual({
    value: { app: 'B' },
    version: 5,
  });
  expect(await reader.configValue('content_read_7_a', 'other')).toStrictEqual({
    value: false,
    version: 3,
  });
  expect(await reader.configValue('content_read_7_a', 'shared')).toStrictEqual({
    value: { app: 'A' },
    version: 2,
  });
  expect(await reader.configValue('content_read_7_b', 'shared')).toStrictEqual({
    value: { app: 'B' },
    version: 5,
  });
});

it('[AC-F1-02b#8] 02 §10、任务 §9 #3：不存在的键返回 null，其他应用的配置不能充当默认值', async () => {
  await seedConfig(db, 'content_read_8_other', 'foreign', { secret: 'other-app-value' }, 4);
  const reader = createContentReader({ db, clock: new FixedClock(START) });
  expect(await reader.configValue('content_read_8', 'missing')).toBeNull();
  expect(await reader.configValue('content_read_8', 'foreign')).toBeNull();
  expect(await reader.configValue('content_read_8_other', 'foreign')).toStrictEqual({
    value: { secret: 'other-app-value' },
    version: 4,
  });
  expect(await reader.configValue('content_read_8', 'foreign')).toBeNull();
});

it('[AC-F1-02b#9] 02 §10 缓存刷新：同键连续读命中缓存，不重复查库', async () => {
  const appId = 'content_read_9';
  await seedConfig(db, appId, 'cached', { enabled: true }, 4);
  const probe = observeQueries(db);
  const reader = createContentReader({ db: probe.db, clock: new FixedClock(START) });
  expect(await reader.configValue(appId, 'cached')).toStrictEqual({
    value: { enabled: true },
    version: 4,
  });
  const count = probe.queries.length;
  expect(count).toBeGreaterThan(0);
  expect(await reader.configValue(appId, 'cached')).toStrictEqual({
    value: { enabled: true },
    version: 4,
  });
  expect(probe.queries).toHaveLength(count);
});

it('[AC-F1-02b#10] 02 §10 带版本缓存（本任务 TTL 60 秒）：到期换入新值与版本，命中不续期', async () => {
  const appId = 'content_read_10';
  const clock = new FixedClock(START);
  await seedConfig(db, appId, 'refresh', { label: 'old' }, 4);
  const probe = observeQueries(db);
  const reader = createContentReader({ db: probe.db, clock });
  expect(await reader.configValue(appId, 'refresh')).toStrictEqual({
    value: { label: 'old' },
    version: 4,
  });
  const loaded = probe.queries.length;
  await changeConfig(db, appId, 'refresh', { label: 'new' }, 5);
  clock.advanceMs(CACHE_MS - 1);
  expect(await reader.configValue(appId, 'refresh')).toStrictEqual({
    value: { label: 'old' },
    version: 4,
  });
  expect(probe.queries).toHaveLength(loaded);
  clock.advanceMs(1);
  expect(await reader.configValue(appId, 'refresh')).toStrictEqual({
    value: { label: 'new' },
    version: 5,
  });
  expect(probe.queries.length).toBeGreaterThan(loaded);
  const refreshed = probe.queries.length;
  expect(await reader.configValue(appId, 'refresh')).toStrictEqual({
    value: { label: 'new' },
    version: 5,
  });
  expect(probe.queries).toHaveLength(refreshed);
});

it('[AC-F1-02b#11] 02 §10 缓存刷新：成功复查续期，后续增版可生效', async () => {
  const appId = 'content_read_11';
  const clock = new FixedClock(START);
  await seedConfig(db, appId, 'versioned', 'published', 7);
  const probe = observeQueries(db);
  const reader = createContentReader({ db: probe.db, clock });
  expect(await reader.configValue(appId, 'versioned')).toStrictEqual({
    value: 'published',
    version: 7,
  });
  const loaded = probe.queries.length;
  clock.advanceMs(CACHE_MS);
  expect(await reader.configValue(appId, 'versioned')).toStrictEqual({
    value: 'published',
    version: 7,
  });
  expect(probe.queries.length).toBeGreaterThan(loaded);
  const revalidated = probe.queries.length;
  await changeConfig(db, appId, 'versioned', 'published-next', 8);
  clock.advanceMs(CACHE_MS - 1);
  expect(await reader.configValue(appId, 'versioned')).toStrictEqual({
    value: 'published',
    version: 7,
  });
  expect(probe.queries).toHaveLength(revalidated);
  clock.advanceMs(1);
  expect(await reader.configValue(appId, 'versioned')).toStrictEqual({
    value: 'published-next',
    version: 8,
  });
});

it('[AC-F1-02b#12] 02 §10 普通参数刷新：先前缺失的键新增后最迟在 TTL 到期可读', async () => {
  const appId = 'content_read_12';
  const clock = new FixedClock(START);
  const reader = createContentReader({ db, clock });
  expect(await reader.configValue(appId, 'later')).toBeNull();
  await seedConfig(db, appId, 'later', { added: true }, 1);
  clock.advanceMs(CACHE_MS);
  expect(await reader.configValue(appId, 'later')).toStrictEqual({
    value: { added: true },
    version: 1,
  });
});

it('[AC-F1-02b#13] 任务 §9 #4 读库失败选择：首次查询报错，不能伪装成最低版本或配置未配置', async () => {
  const appId = 'content_read_13';
  await seedConfig(db, appId, 'present', { available: true }, 2);
  await seedVersion(db, appId, 'android', 'official', '3.0.0');
  const probe = observeQueries(db);
  const reader = createContentReader({ db: probe.db, clock: new FixedClock(START) });
  probe.state.failure = new Error('database unavailable for this read');
  await expect(reader.configValue(appId, 'present')).rejects.toBeInstanceOf(Error);
  await expect(reader.minSupportedVersion(appId, 'android', 'official')).rejects.toBeInstanceOf(
    Error,
  );
  probe.state.failure = null;
  expect(await reader.configValue(appId, 'present')).toStrictEqual({
    value: { available: true },
    version: 2,
  });
  expect(await reader.minSupportedVersion(appId, 'android', 'official')).toBe('3.0.0');
});

it('[AC-F1-02b#14] 02 §10、任务 §9 #4 失败选择：刷新失败不返回过期值、不延长 TTL，恢复后立即可重读', async () => {
  const appId = 'content_read_14';
  const clock = new FixedClock(START);
  await seedConfig(db, appId, 'unavailable', { value: 'old' }, 3);
  const probe = observeQueries(db);
  const reader = createContentReader({ db: probe.db, clock });
  expect(await reader.configValue(appId, 'unavailable')).toStrictEqual({
    value: { value: 'old' },
    version: 3,
  });
  await changeConfig(db, appId, 'unavailable', { value: 'new' }, 4);
  clock.advanceMs(CACHE_MS);
  probe.state.failure = new Error('database unavailable for this read');
  await expect(reader.configValue(appId, 'unavailable')).rejects.toBeInstanceOf(Error);
  await expect(reader.configValue(appId, 'unavailable')).rejects.toBeInstanceOf(Error);
  probe.state.failure = null;
  expect(await reader.configValue(appId, 'unavailable')).toStrictEqual({
    value: { value: 'new' },
    version: 4,
  });
});

it('[AC-F1-02b#15] 任务只读目标、04 §3.2：只用 SELECT 权限即可完成两类查询，不写任何表', async () => {
  const appId = 'content_read_15';
  await seedConfig(db, appId, 'read-only', { text: 'hello' }, 6);
  await seedVersion(db, appId, 'ios', 'appstore', '1.2.0');
  const readonlyDb = createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 });
  try {
    const reader = createContentReader({ db: readonlyDb, clock: new FixedClock(START) });
    expect(await reader.configValue(appId, 'read-only')).toStrictEqual({
      value: { text: 'hello' },
      version: 6,
    });
    expect(await reader.minSupportedVersion(appId, 'ios', 'appstore')).toBe('1.2.0');
  } finally {
    await destroyDb(readonlyDb);
  }
});

it('[AC-F1-02b#16] 02 §10 缓存刷新、任务 §9 #3：缓存中的键变为不存在后，到期返回 null', async () => {
  const appId = 'content_read_16';
  const clock = new FixedClock(START);
  await seedConfig(db, appId, 'removed', { present: true }, 9);
  const reader = createContentReader({ db, clock });
  expect(await reader.configValue(appId, 'removed')).toStrictEqual({
    value: { present: true },
    version: 9,
  });
  // couli_app has UPDATE but no DELETE; moving the key creates the same missing-row condition.
  await db
    .updateTable('config_items')
    .set({ key: 'moved' })
    .where('app_id', '=', appId)
    .where('key', '=', 'removed')
    .execute();
  clock.advanceMs(CACHE_MS);
  expect(await reader.configValue(appId, 'removed')).toBeNull();
});

it('[AC-F1-02b#17] BR-ID-01 最低版本判定、02 §10 刷新约定：TTL 到期能读到提高后的最低版本及取消门槛', async () => {
  const appId = 'content_read_17';
  const clock = new FixedClock(START);
  await seedVersion(db, appId, 'android', 'official', '1.0.0');
  const reader = createContentReader({ db, clock });
  expect(await reader.minSupportedVersion(appId, 'android', 'official')).toBe('1.0.0');
  await db
    .updateTable('app_versions')
    .set({ min_supported_version: '2.0.0' })
    .where('app_id', '=', appId)
    .where('platform', '=', 'android')
    .where('channel', '=', 'official')
    .execute();
  clock.advanceMs(CACHE_MS);
  expect(await reader.minSupportedVersion(appId, 'android', 'official')).toBe('2.0.0');
  await db
    .updateTable('app_versions')
    .set({ min_supported_version: null })
    .where('app_id', '=', appId)
    .where('platform', '=', 'android')
    .where('channel', '=', 'official')
    .execute();
  clock.advanceMs(CACHE_MS);
  expect(await reader.minSupportedVersion(appId, 'android', 'official')).toBeNull();
});
