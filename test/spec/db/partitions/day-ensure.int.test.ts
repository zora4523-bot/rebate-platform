// Rule tests for app.ensure_day_partition (B1-01s; contract section I1a in
// apps/api/src/modules/platform/maintenance/index.ts). Basis: ADR-0001 §4.2 #4 (按日的表预建; 每张分区
// 表设 DEFAULT 分区兜底，有数据须先迁出才能建对应区间的分区，否则建分区报错), #5 (link_logs 按日);
// BR-ID-30 (运行当日 00:00（+08:00）: the day is the +08:00 calendar day); 规划/04 §3.2 (link_logs 按日分区).
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { dayBound, dayNames, dayRange, ensureDays, insertLinkLog, linkLogRows } from './day-kit.ts';
import { connect, disconnect, partitionNames, partitionsOf, type Roles } from './kit.ts';

let database: TestDatabase;
let roles: Roles;

beforeAll(async () => {
  database = await createTestDatabase();
  roles = connect(database);
});

afterAll(async () => {
  await disconnect(roles);
  await database.drop();
});

/** Each scenario that inspects the whole partition list or DEFAULT clones its own database. */
async function withDatabase(
  scenario: (own: Roles, db: TestDatabase) => Promise<void>,
): Promise<void> {
  const fresh = await createTestDatabase();
  const own = connect(fresh);
  try {
    await scenario(own, fresh);
  } finally {
    await disconnect(own);
    await fresh.drop();
  }
}

it('[ADR-0001 §4.2 #5; BR-ID-30 +08:00 日界; contract I1 Day] 建 2026-10-05 的分区：名字 link_logs_p20261005、范围正好是 [2026-10-05 00:00 +08:00, 2026-10-06 00:00 +08:00)（UTC 渲染 2026-10-04 16:00 至 2026-10-05 16:00）；前后 1 毫秒的行落在 DEFAULT，边界上的行落进分区', async () => {
  await withDatabase(async ({ maint, app }) => {
    expect(await ensureDays(maint, 'link_logs', ['2026-10-05'])).toEqual(['link_logs_p20261005']);
    expect(await partitionsOf(maint, 'link_logs')).toEqual([
      { name: 'link_logs_default', bound: 'DEFAULT' },
      {
        name: 'link_logs_p20261005',
        bound: "FOR VALUES FROM ('2026-10-04 16:00:00+00') TO ('2026-10-05 16:00:00+00')",
      },
    ]);
    expect({
      lastMsBefore: await insertLinkLog(app, '2026-10-04T15:59:59.999Z'),
      first: await insertLinkLog(app, '2026-10-05T00:00:00.000+08:00'),
      lastMs: await insertLinkLog(app, '2026-10-05T15:59:59.999Z'),
      next: await insertLinkLog(app, '2026-10-06T00:00:00.000+08:00'),
    }).toEqual({
      lastMsBefore: 'app.link_logs_default',
      first: 'app.link_logs_p20261005',
      lastMs: 'app.link_logs_p20261005',
      next: 'app.link_logs_default',
    });
  });
});

it('[contract I1a 幂等] 同一天再建两次：返回同一名字、分区不多、已有的行不动', async () => {
  await withDatabase(async ({ maint, app }) => {
    expect(await ensureDays(maint, 'link_logs', ['2026-10-07'])).toEqual(['link_logs_p20261007']);
    expect(await insertLinkLog(app, '2026-10-07T12:00:00+08:00')).toBe('app.link_logs_p20261007');
    expect(await ensureDays(maint, 'link_logs', ['2026-10-07', '2026-10-07'])).toEqual([
      'link_logs_p20261007',
      'link_logs_p20261007',
    ]);
    expect(await partitionNames(maint, 'link_logs')).toEqual([
      'link_logs_default',
      'link_logs_p20261007',
    ]);
    expect(await linkLogRows(app)).toEqual([
      { part: 'app.link_logs_p20261007', at: '2026-10-07T04:00:00.000Z' },
    ]);
  });
});

it('[ADR-0001 §4.2 #4 按日的表预建未来 14 天; contract I1] 连续 15 天（跨月、跨年：2026-12-25 至 2027-01-08）各建一个分区，界首尾相接、名字与界确切；闰日 2028-02-29、2000-01-01 与 9999-12-31 也照常', async () => {
  await withDatabase(async ({ maint }) => {
    const days = dayRange('2026-12-25', '2027-01-08');
    expect(days).toHaveLength(15);
    expect(await ensureDays(maint, 'link_logs', days)).toEqual(dayNames('link_logs', days));
    const edges = ['2000-01-01', '2028-02-29', '9999-12-31'];
    expect(await ensureDays(maint, 'link_logs', edges)).toEqual(dayNames('link_logs', edges));
    const all = [...edges.slice(0, 1), ...days, ...edges.slice(1)];
    expect(await partitionsOf(maint, 'link_logs')).toEqual([
      { name: 'link_logs_default', bound: 'DEFAULT' },
      ...all.map((d) => ({ name: dayNames('link_logs', [d])[0], bound: dayBound(d) })),
    ]);
    expect(dayBound('2027-01-01')).toBe(
      "FOR VALUES FROM ('2026-12-31 16:00:00+00') TO ('2027-01-01 16:00:00+00')",
    );
  });
});

it('[BR-ID-30 +08:00; contract I1 Day] 界不随会话时区变：在 Pacific/Kiritimati（+14）与 America/New_York 会话里建的分区，界与 UTC 会话建的同形', async () => {
  const inZone = async (zone: string, day: string): Promise<string> =>
    roles.maint
      .transaction()
      .execute(async (trx) => {
        await sql`SELECT set_config('TimeZone', ${zone}, true)`.execute(trx);
        const result = await sql<{ name: string }>`
          SELECT app.ensure_day_partition('link_logs', ${day}::date) AS name
        `.execute(trx);
        return result.rows[0]?.name ?? 'no row';
      })
      .catch((error: unknown) => `failed ${String((error as { code?: unknown }).code)}`);
  expect(await inZone('Pacific/Kiritimati', '2033-03-10')).toBe('link_logs_p20330310');
  expect(await inZone('America/New_York', '2033-03-13')).toBe('link_logs_p20330313');
  const got = (await partitionsOf(roles.maint, 'link_logs')).filter((p) =>
    ['link_logs_p20330310', 'link_logs_p20330313'].includes(p.name),
  );
  expect(got).toEqual([
    { name: 'link_logs_p20330310', bound: dayBound('2033-03-10') },
    { name: 'link_logs_p20330313', bound: dayBound('2033-03-13') },
  ]);
});

it('[ADR-0001 §4.2 #4 有数据须先迁出才能建对应区间的分区; contract I1a] DEFAULT 里有 2026-11-25（+08:00，含当日最后 1 毫秒）的行：该日建不了（23514），前一日与后一日照建；行都还在 DEFAULT', async () => {
  await withDatabase(async ({ maint, app }) => {
    expect(await insertLinkLog(app, '2026-11-25T15:59:59.999Z')).toBe('app.link_logs_default');
    expect(
      await ensureDays(maint, 'link_logs', ['2026-11-24', '2026-11-25', '2026-11-26']),
    ).toEqual(['link_logs_p20261124', 'failed 23514', 'link_logs_p20261126']);
    expect(await partitionNames(maint, 'link_logs')).toEqual([
      'link_logs_default',
      'link_logs_p20261124',
      'link_logs_p20261126',
    ]);
    expect(await linkLogRows(app)).toEqual([
      { part: 'app.link_logs_default', at: '2026-11-25T15:59:59.999Z' },
    ]);
  });
});

it('[ADR-0001 §4.2 #4 DEFAULT 兜底; contract I1a] DEFAULT 里只有别的日子的行（前一日最后 1 毫秒、后一日第 1 毫秒）时照建，行留在 DEFAULT', async () => {
  await withDatabase(async ({ maint, app }) => {
    expect(await insertLinkLog(app, '2026-11-24T15:59:59.999Z')).toBe('app.link_logs_default');
    expect(await insertLinkLog(app, '2026-11-25T16:00:00.000Z')).toBe('app.link_logs_default');
    expect(await ensureDays(maint, 'link_logs', ['2026-11-25'])).toEqual(['link_logs_p20261125']);
    expect(await linkLogRows(app)).toEqual([
      { part: 'app.link_logs_default', at: '2026-11-24T15:59:59.999Z' },
      { part: 'app.link_logs_default', at: '2026-11-25T16:00:00.000Z' },
    ]);
  });
});

it('[ADR-0001 §4.2 #4 并发; contract I1a] 六个会话同时建同样的 15 天：全部成功、每个会话拿到同样的 15 个名字，分区正好 15 个加 DEFAULT', async () => {
  await withDatabase(async ({ maint }, fresh) => {
    const days = dayRange('2029-05-01', '2029-05-15');
    const sessions = Array.from({ length: 6 }, () =>
      createDb({ connectionString: fresh.urlFor('couli_maint'), max: 1 }),
    );
    try {
      const results = await Promise.all(sessions.map((db) => ensureDays(db, 'link_logs', days)));
      expect(results).toEqual(Array(6).fill(dayNames('link_logs', days)));
    } finally {
      await Promise.all(sessions.map((db) => destroyDb(db)));
    }
    expect(await partitionNames(maint, 'link_logs')).toEqual([
      'link_logs_default',
      ...dayNames('link_logs', days),
    ]);
  });
});
