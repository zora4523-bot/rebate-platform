// B1-01zk — BR-ID-30 正文、⑯：event_log 仍按 occurred_at 分区上界 + created_at 留存 190 天。
// 锁内复查 SELECT EXISTS (SELECT 1 FROM app.<partition> WHERE created_at >= cutoff)
// 必须有可用的 created_at 首列索引（父表、DEFAULT 与后来创建的月分区都覆盖）。
// 本任务采用台账允许的分区索引方案，不固定索引名或迁移文件名，也不禁用 Seq Scan 来强迫走索引。
// 测试只连标准业务角色：couli_app 写行、couli_maint 调删除函数；不需要 ANALYZE 权限。
// 在同一个维护事务中读取 pg_stat_xact_user_tables 的即时计数，度量删除函数实际执行的扫描；
// 全部行均过期时必须确实删除目标分区，覆盖锁外预查和锁内复查，随后回滚到保存点恢复分区。
// 扫描计数不随保存点回滚撤销；恢复后断言 seq_scan 不增、idx_scan 增加，不等待统计刷新。
// PG 18 支持事务内即时统计：https://www.postgresql.org/docs/18/monitoring-stats.html#MONITORING-STATS-VIEWS
// 不依赖自动 ANALYZE 时机：尚无列统计时也应有界地使用索引，不固定具体复查 SQL 写法。
// 后续仍用同一批真实行核对 190 天边界与晚到事件，不新增供测试专用的数据库函数或权限。
// 原有 drop-expired / 并发锁内复查规则测试继续保留，容器完整验证须一并执行。
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import {
  connect,
  disconnect,
  dropped,
  ensureMonths,
  partitionNames,
  type Roles,
} from '../../db/partitions/kit.ts';

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

async function indexedRelations(roles: Roles): Promise<string[]> {
  const result = await sql<{ relation: string }>`
    SELECT DISTINCT c.relname::text AS relation
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
    WHERE c.relnamespace = 'app'::regnamespace
      AND (c.oid = 'app.event_log'::regclass OR c.oid IN (
        SELECT inhrelid FROM pg_inherits WHERE inhparent = 'app.event_log'::regclass
      ))
      AND a.attname = 'created_at' AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND i.indnkeyatts > 0
    ORDER BY relation
  `.execute(roles.app);
  return result.rows.map((row) => row.relation);
}

interface ScanCounts {
  seq_scan: bigint;
  idx_scan: bigint;
}

async function scanCounts(db: Kysely<DB>): Promise<ScanCounts> {
  const result = await sql<ScanCounts>`
    SELECT seq_scan, coalesce(idx_scan, 0)::bigint AS idx_scan
    FROM pg_stat_xact_user_tables
    WHERE schemaname = 'app' AND relname = 'event_log_p202603'
  `.execute(db);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

it('[AC-B1-01zk#6] event_log 的 created_at 首列有效非部分索引覆盖父表、DEFAULT 和新月分区', async () => {
  await withWorld(async (roles) => {
    expect(await ensureMonths(roles.maint, 'event_log', ['2026-02', '2026-03', '2027-01'])).toEqual(
      ['event_log_p202602', 'event_log_p202603', 'event_log_p202701'],
    );
    expect(await indexedRelations(roles)).toEqual([
      'event_log',
      'event_log_default',
      'event_log_p202602',
      'event_log_p202603',
      'event_log_p202701',
    ]);
  });
}, 60_000);

it('[AC-B1-01zk#7] 实际删除函数复查无顺序扫描；190 天边界和晚到事件仍保护整个旧分区', async () => {
  await withWorld(async (roles) => {
    const { maint, app } = roles;
    await ensureMonths(maint, 'event_log', ['2026-02', '2026-03']);
    // 当前 main 在真实索引缺失处先红，不以 SQL 错误或超时作为先红依据。
    expect(await indexedRelations(roles)).toContain('event_log_p202603');
    await sql`
      INSERT INTO app.event_log (app_id, event_id, name, payload, occurred_at, created_at)
      SELECT 'couli', ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
        'user.updated', '{}'::jsonb, '2026-03-15T00:00:00Z'::timestamptz,
        '2026-03-15T00:00:00Z'::timestamptz + n * interval '1 second'
      FROM generate_series(1, 50000) AS series(n)
    `.execute(app);
    await maint.transaction().execute(async (trx) => {
      const before = await scanCounts(trx);
      await sql`SAVEPOINT measure_recheck`.execute(trx);
      // 先不插入晚到行，避免锁外预查直接跳过分区而根本没执行锁内复查。
      // 回滚 DROP 后目录中的分区及索引恢复，事务内的扫描计数仍可读取。
      try {
        expect(await dropped(trx, 'event_log', '2026-10-08T20:00:00Z')).toEqual([
          'event_log_p202602',
          'event_log_p202603',
        ]);
      } finally {
        await sql`ROLLBACK TO SAVEPOINT measure_recheck`.execute(trx);
        await sql`RELEASE SAVEPOINT measure_recheck`.execute(trx);
      }
      const after = await scanCounts(trx);
      expect(after.seq_scan - before.seq_scan).toBe(0n);
      expect(after.idx_scan - before.idx_scan).toBeGreaterThan(0n);
    });

    // 2026-10-09 +08:00 的 190 天截止 = 2026-04-02 00:00 +08:00。
    // occurred_at 很旧，但 created_at 恰好等于截止的一行必须保留整个分区。
    await sql`
      INSERT INTO app.event_log (app_id, event_id, name, payload, occurred_at, created_at)
      VALUES ('couli', '00000000-0000-7000-8000-000000050001'::uuid,
        'user.updated', '{}'::jsonb, '2026-03-16T00:00:00Z'::timestamptz,
        '2026-04-01T16:00:00Z'::timestamptz)
    `.execute(app);
    expect(await dropped(maint, 'event_log', '2026-10-08T20:00:00Z')).toEqual([
      'event_log_p202602',
    ]);
    expect(await partitionNames(maint, 'event_log')).toEqual([
      'event_log_default',
      'event_log_p202603',
    ]);
    const kept = await sql<{ n: bigint }>`SELECT count(*) AS n FROM app.event_log`.execute(app);
    expect(kept.rows).toEqual([{ n: 50001n }]);
    expect(await dropped(maint, 'event_log', '2026-10-09T15:59:59.999Z')).toEqual([]);
    expect(await dropped(maint, 'event_log', '2026-10-09T16:00:00Z')).toEqual([
      'event_log_p202603',
    ]);
    expect(await partitionNames(maint, 'event_log')).toEqual(['event_log_default']);
    expect(await dropped(maint, 'event_log', '2026-10-09T16:00:00Z')).toEqual([]);
    const empty = await sql<{ n: bigint }>`SELECT count(*) AS n FROM app.event_log`.execute(app);
    expect(empty.rows).toEqual([{ n: 0n }]);
  });
}, 60_000);
