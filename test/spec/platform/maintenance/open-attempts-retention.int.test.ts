// B1-01zk — BR-ID-30 正文、②；接口补充契约（不改变既有维护报告的结构）。
// app.delete_expired_link_open_attempts(p_now timestamptz, p_batch_size integer) RETURNS bigint:
// - 每次最多删除 p_batch_size 行，返回实际删除数；按 opened_at（open 成功时刻）严格小于
//   p_now 的 +08:00 当日零点减 90 天判断，独立于会话时区、created_at、jump_reported_at、
//   dismissed_at；覆盖所有 app_id，保留 links 与仍在期限内的尝试。
// - p_now / p_batch_size 为 NULL → 22004；非有限 p_now 或批大小不在 1..10000 → 22023。
// - SECURITY DEFINER，属主 couli_migrator，search_path=pg_catalog, pg_temp，lock_timeout=5s；
//   撤销 PUBLIC EXECUTE，只授权 couli_maint；不新增任何角色的直接 DELETE 权限，不弱化写入保护。
// - createPartitionMaintenance 的 dayPartitions=true 路径（含 createWorkerMaintenance）在
//   每日 +08:00 04:00 起，与 link_logs 日分区删除同轮调用；每批 1000 行、每批独立事务，
//   重复调用到返回 0；整轮只读取一次注入时钟，所有批次用同一个时刻。04:00 前不清理。
// 技术批大小与函数名由本任务规则测试定义；迁移文件名不属于契约。无需新增 TS 导出或骨架。
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import { createPartitionMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import { createWorkerMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/worker.ts';
import { ensureDays, insertLinkLog, linkLogRows } from '../../db/partitions/day-kit.ts';
import { connect, disconnect, sqlState, type Roles } from '../../db/partitions/kit.ts';
import { memoryLogger, settableClock } from './kit.ts';

const NOW = '2026-11-19T20:00:00.000Z'; // 2026-11-20 04:00 +08:00
const CUTOFF = '2026-08-21T16:00:00.000Z'; // 2026-08-22 00:00 +08:00
const OLD = '2026-08-21T15:59:59.999Z';
const LINK = '00000000-0000-7000-8000-000000000001';

async function withWorld(scenario: (roles: Roles) => Promise<void>): Promise<void> {
  const database = await createTestDatabase();
  const roles = connect(database);
  try {
    await scenario(roles);
  } finally {
    await disconnect(roles);
    await database.drop();
  }
}

async function seedLink(app: Kysely<DB>, appId = 'couli', linkId = LINK): Promise<void> {
  await sql`
    INSERT INTO app.links (app_id, link_id, platform, scene, expire_at)
    VALUES (${appId}, ${linkId}::uuid, 'demo', 'self', '2027-01-01T00:00:00Z'::timestamptz)
  `.execute(app);
}

async function seedAttempt(
  app: Kysely<DB>,
  id: number,
  openedAt: string,
  createdAt: string,
  appId = 'couli',
  linkId = LINK,
): Promise<void> {
  await sql`
    INSERT INTO app.link_open_attempts
      (attempt_id, app_id, link_id, opened_at, created_at, jump_reported_at, dismissed_at)
    VALUES ((${`00000000-0000-7000-8000-${String(id).padStart(12, '0')}`})::uuid,
      ${appId}, ${linkId}::uuid, ${openedAt}::timestamptz, ${createdAt}::timestamptz,
      ${NOW}::timestamptz, ${NOW}::timestamptz)
  `.execute(app);
}

async function remaining(app: Kysely<DB>): Promise<string[]> {
  const result = await sql<{ id: string }>`
    SELECT attempt_id::text AS id FROM app.link_open_attempts ORDER BY attempt_id
  `.execute(app);
  return result.rows.map((row) => row.id);
}

async function requireDeletionFunction(db: Kysely<DB>): Promise<void> {
  const result = await sql<{ present: boolean }>`
    SELECT to_regprocedure('app.delete_expired_link_open_attempts(timestamptz,integer)')
      IS NOT NULL AS present
  `.execute(db);
  // 缺迁移时先以契约断言失败，不执行不存在的 SQL 函数。
  expect(result.rows).toEqual([{ present: true }]);
}

async function deleteBatch(db: Kysely<DB>, now: string, batchSize: number): Promise<bigint> {
  const result = await sql<{ deleted: bigint }>`
    SELECT app.delete_expired_link_open_attempts(${now}::timestamptz, ${batchSize}::integer)
      AS deleted
  `.execute(db);
  return result.rows[0]!.deleted;
}

it.each(['UTC', 'Pacific/Kiritimati', 'America/New_York'])(
  '[AC-B1-01zk#1] BR-ID-30 ②：%s 会话下按 opened_at 的 90 天日界删除，截止相等与稍晚的保留',
  async (zone) => {
    await withWorld(async ({ app, maint }) => {
      await seedLink(app);
      // 故意让 created_at 与 opened_at 的新旧相反，防止误用 created_at 或回执时刻。
      await seedAttempt(app, 1, OLD, NOW);
      await seedAttempt(app, 2, CUTOFF, '2026-01-01T00:00:00Z');
      await seedAttempt(app, 3, '2026-08-21T16:00:00.001Z', '2026-01-01T00:00:00Z');
      await requireDeletionFunction(maint);
      await maint.transaction().execute(async (trx) => {
        await sql`SELECT set_config('TimeZone', ${zone}, true)`.execute(trx);
        expect(await deleteBatch(trx, NOW, 1000)).toBe(1n);
        expect(await deleteBatch(trx, NOW, 1000)).toBe(0n);
      });
      expect(await remaining(app)).toEqual([
        '00000000-0000-7000-8000-000000000002',
        '00000000-0000-7000-8000-000000000003',
      ]);
      // 第二天零点推进截止，先前的相等和稍晚两行才可删除。
      expect(await deleteBatch(maint, '2026-11-20T16:00:00Z', 1000)).toBe(2n);
      expect(await remaining(app)).toEqual([]);
      const links = await sql<{ n: bigint }>`SELECT count(*) AS n FROM app.links`.execute(app);
      expect(links.rows).toEqual([{ n: 1n }]);
    });
  },
  60_000,
);

it('[AC-B1-01zk#2] 多于一批的过期行跨 app_id 清理完毕，每批有上限且重复调用返回零', async () => {
  await withWorld(async ({ app, maint }) => {
    await seedLink(app);
    const otherLink = '00000000-0000-7000-8000-000000000002';
    await seedLink(app, 'other-app', otherLink);
    for (let id = 1; id <= 5; id += 1) {
      await seedAttempt(
        app,
        id,
        OLD,
        NOW,
        id % 2 === 0 ? 'other-app' : 'couli',
        id % 2 === 0 ? otherLink : LINK,
      );
    }
    await seedAttempt(app, 6, CUTOFF, OLD);
    await requireDeletionFunction(maint);
    const counts: bigint[] = [];
    for (let batch = 0; batch < 4; batch += 1) {
      counts.push(await deleteBatch(maint, NOW, 2));
      const rows = await remaining(app);
      expect(rows).toHaveLength([4, 2, 1, 1][batch]!);
      expect(rows).toContain('00000000-0000-7000-8000-000000000006');
    }
    expect(counts).toEqual([2n, 2n, 1n, 0n]);
  });
}, 60_000);

it('[AC-B1-01zk#3] 只许维护角色经有界 SECURITY DEFINER 函数删除，直接删除仍拒绝，写一次保护仍在', async () => {
  await withWorld(async (roles) => {
    const { maint, app } = roles;
    await seedLink(app);
    await seedAttempt(app, 1, OLD, NOW);
    await seedAttempt(app, 2, CUTOFF, OLD);
    await requireDeletionFunction(maint);
    const definition = await sql<{
      owner: string;
      security_definer: boolean;
      settings: string[];
      acl: string[];
    }>`
      SELECT pg_get_userbyid(proowner)::text AS owner, prosecdef AS security_definer,
        proconfig AS settings, proacl::text[] AS acl
      FROM pg_proc
      WHERE oid = to_regprocedure('app.delete_expired_link_open_attempts(timestamptz,integer)')
    `.execute(app);
    expect(definition.rows[0]).toMatchObject({ owner: 'couli_migrator', security_definer: true });
    expect(definition.rows[0]?.settings).toEqual(
      expect.arrayContaining(['search_path=pg_catalog, pg_temp', 'lock_timeout=5s']),
    );
    expect([...(definition.rows[0]?.acl ?? [])].sort()).toEqual([
      'couli_maint=X/couli_migrator',
      'couli_migrator=X/couli_migrator',
    ]);
    for (const role of [maint, app, roles.payout, roles.readonly]) {
      expect(await sqlState(sql`DELETE FROM app.link_open_attempts`.execute(role))).toBe('42501');
    }
    for (const role of [app, roles.payout, roles.readonly]) {
      expect(await sqlState(deleteBatch(role, NOW, 1000))).toBe('42501');
    }
    expect(await deleteBatch(maint, NOW, 1000)).toBe(1n);
    expect(
      await sqlState(
        sql`
      UPDATE app.link_open_attempts SET jump_reported_at = '2027-01-01T00:00:00Z'::timestamptz
      WHERE attempt_id = '00000000-0000-7000-8000-000000000002'::uuid
    `.execute(app),
      ),
    ).toBe('23001');
    expect(await remaining(app)).toEqual(['00000000-0000-7000-8000-000000000002']);
  });
}, 60_000);

it('[AC-B1-01zk#4] 无效截止与批大小拒绝且不删除任何行，批大小 1 与 10000 均可用', async () => {
  await withWorld(async ({ app, maint }) => {
    await seedLink(app);
    await seedAttempt(app, 1, OLD, NOW);
    await requireDeletionFunction(maint);
    const inputs: Array<[string | null, number | null, string]> = [
      [null, 1, '22004'],
      [NOW, null, '22004'],
      ['infinity', 1, '22023'],
      ['-infinity', 1, '22023'],
      [NOW, 0, '22023'],
      [NOW, -1, '22023'],
      [NOW, 10001, '22023'],
    ];
    for (const [now, size, code] of inputs) {
      expect(
        await sqlState(
          sql`
        SELECT app.delete_expired_link_open_attempts(${now}::timestamptz, ${size}::integer)
      `.execute(maint),
        ),
      ).toBe(code);
    }
    expect(await remaining(app)).toEqual(['00000000-0000-7000-8000-000000000001']);
    await seedAttempt(app, 2, OLD, NOW);
    expect(await deleteBatch(maint, NOW, 1)).toBe(1n);
    expect(await remaining(app)).toHaveLength(1);
    expect(await deleteBatch(maint, NOW, 10000)).toBe(1n);
    expect(await remaining(app)).toEqual([]);
  });
}, 60_000);

it.each(['module', 'worker'] as const)(
  '[AC-B1-01zk#5] %s 同轮按 04:00 门槛清理 link_logs 与超过两批的打开尝试，注入时钟只读一次',
  async (entry) => {
    // 单连接也应能完成多批清理，不应在持有事务时再请求池里的第二条连接。
    const database = await createTestDatabase();
    const maint = createDb({ connectionString: database.urlFor('couli_maint'), max: 1 });
    const app = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
    try {
      await seedLink(app);
      await sql`
        INSERT INTO app.link_open_attempts (attempt_id, app_id, link_id, opened_at, created_at)
        SELECT ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
          'couli', ${LINK}::uuid, ${OLD}::timestamptz, ${NOW}::timestamptz
        FROM generate_series(1, 2001) AS series(n)
      `.execute(app);
      await seedAttempt(app, 2002, CUTOFF, OLD);
      expect(await ensureDays(maint, 'link_logs', ['2026-08-21', '2026-08-22'])).toEqual([
        'link_logs_p20260821',
        'link_logs_p20260822',
      ]);
      expect(await insertLinkLog(app, OLD)).toBe('app.link_logs_p20260821');
      expect(await insertLinkLog(app, CUTOFF)).toBe('app.link_logs_p20260822');
      const clock = settableClock('2026-11-19T19:59:59.999Z');
      const { logger } = memoryLogger();
      const options = { db: maint, clock, logger };
      const maintenance =
        entry === 'worker'
          ? createWorkerMaintenance(options)
          : createPartitionMaintenance({ ...options, dayPartitions: true });
      const before = await maintenance.runOnce();
      expect(before.failed).toBe(0);
      expect(await remaining(app)).toHaveLength(2002);
      expect(await linkLogRows(app)).toHaveLength(2);
      expect(clock.calls()).toBe(1);
      clock.set(NOW);
      const after = await maintenance.runOnce();
      expect(after.failed).toBe(0);
      expect(after.dropped).toContain('link_logs_p20260821');
      expect(await linkLogRows(app)).toEqual([{ part: 'app.link_logs_p20260822', at: CUTOFF }]);
      expect(await remaining(app)).toEqual(['00000000-0000-7000-8000-000000002002']);
      expect(clock.calls()).toBe(2);
      expect((await maintenance.runOnce()).failed).toBe(0);
      expect(await remaining(app)).toEqual(['00000000-0000-7000-8000-000000002002']);
      expect(clock.calls()).toBe(3);
    } finally {
      await Promise.all([destroyDb(maint), destroyDb(app)]);
      await database.drop();
    }
  },
  60_000,
);
