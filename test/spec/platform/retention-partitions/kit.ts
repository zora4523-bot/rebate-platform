// B1-15zc — BR-ID-30 ⑦ union_raw_payloads 保留 180 天：本文件头是契约（写法照
// test/spec/platform/retention/kit.ts），不新增 TS 导出，也不用骨架。依据：BR-ID-30 正文与 ⑦；编排 D10-451、
// D10-454、D10-458；maintenance 第 A1、K 节。
//
// 落法（编排裁定）：test/spec/platform/maintenance/contract.test.ts 钉死 DROPPABLE_TABLES 恰为 ['event_log']，
// test/spec/db/union-raw 的 [AC-B1-04a#8] 钉死 app.drop_expired_month_partitions 拒绝本表，所以这两处都不改；
// 另建下面的独立函数，maintenance 里用单独的常量。台账标题「加入 DROPPABLE_TABLES」按此落实。本表带只增触发器
// union_raw_payloads_append_only，只能丢分区，不能逐行删。
//
// SQL 函数（迁移文件名不属于契约），只有一个重载：
//   app.drop_expired_union_raw_payload_partitions(p_now timestamptz, p_days integer) RETURNS text[]
// - 截断点 = p_now 的 +08:00 日历日 − p_days 个日历天，再取该日 00:00（+08:00）；不看会话时区。
// - 只考虑 app.union_raw_payloads 名字恰为 union_raw_payloads_pYYYYMM 的子分区，实际上界（读目录，不看名字）
//   ≤ 截断点才 DROP TABLE。分区键是 fetched_at，所以此时分区里每行的 fetched_at 都早于截断点，不必读行，也不看
//   created_at（任务标题「按 fetched_at」）。上界晚于截断点的月分区整月保留，哪怕里面的行全都更早；月分区是
//   UTC 月，截断点是 +08:00 日界，比较时不做任何取整。DEFAULT 分区不丢，里面的行再旧也不动。
// - 返回丢掉的分区名，升序；没丢时是 '{}'，不是 NULL。
// - 入参：p_now、p_days 为 NULL → 22004；p_now 非有限、p_days 不在 [180, 36500] → 22023，什么都不丢。下限写死在
//   函数里，所以配置被改小也丢不过头；36500 是防溢出的技术上限，同 B1-15zb。
// - SECURITY DEFINER，属主 couli_migrator，search_path=pg_catalog, pg_temp，lock_timeout=5s；撤销 PUBLIC
//   EXECUTE，只授 couli_maint；不给任何角色直接删行或 DDL 的权限。正文不引用别的业务表。
// - 锁：没有要丢的分区时不申请表锁（有人持表锁也立刻返回 '{}'）；有要丢的分区时等锁受 lock_timeout 限制，超时
//   55P03，整条语句回滚，什么都没丢。多个会话同时调用都成功，每个分区恰好丢一次、报告一次。
//
// 运行（createPartitionMaintenance 的 dayPartitions=true 路径，含 createWorkerMaintenance；未开时不动本表）：
// - 在第 C.4 节的门内（+08:00 04:00:00.000 起），用同一个 now（时钟每轮只读一次），每轮调用一次函数。
// - 配置走第 K 节那一次读取（每轮一次，不缓存）。
//   - retention.purge.enabled 恰为 false：不丢本表，其他值或缺行照常。总开关只管 retention 这批：event_log 的
//     月分区、link_logs 的日分区照旧丢。
//   - 配置读失败：开关未知，本表也不丢；只记第 K 节那一行 retention_purge_failed { table: 'config_items',
//     sqlstate }，failed += 1，下一轮补上。
//   - retention.union_raw_payloads_days：不小于 180 的整数按它（高于 36500 按 36500，不回落）；缺行、不是整数或
//     低于 180 回落 180，照常丢，不记失败。
// - 结果与 event_log 同口径：每个名字进 report.dropped，记 info partition_dropped { table, partition }，计入
//   partition_maintenance_done 的 dropped。日志只有表名与分区名；没丢时不写行。
// - 失败（55P03 也一样）：记 error partition_drop_failed { table: 'union_raw_payloads', sqlstate }，failed += 1，
//   不立即重试；本轮其他表的分区维护、第 K 节的行清理、DEFAULT 检查都照做。反过来第 K 节某表失败也不挡本表。
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { createWorkerMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/worker.ts';
import { ensureMonths, monthRange, names, type Database } from '../../db/partitions/kit.ts';
import { fixture, insert, TABLE } from '../../db/union-raw/kit.ts';
import { line, memoryLogger, settableClock } from '../maintenance/kit.ts';
import { holdLock, type Held, type World } from '../retention/kit.ts';

export { TABLE };

export const SIGNATURE = 'app.drop_expired_union_raw_payload_partitions(timestamptz,integer)';

export const DAYS_KEY = 'retention.union_raw_payloads_days';

/** 比所有分区都晚的时刻。 */
export const FAR = '2100-01-01T00:00:00.000Z';

/** 2026-12-28 04:00:00.000 +08:00，门内第一刻。 */
export const NOW = '2026-12-27T20:00:00.000Z';

/** 2026-12-28 03:59:59.999 +08:00，同一日、门外最后一刻。 */
export const BEFORE_GATE = '2026-12-27T19:59:59.999Z';

/** 2026-12-29 04:00:00.000 +08:00：截断点晚一天，p202606 才到期。 */
export const NEXT_DAY = '2026-12-28T20:00:00.000Z';

/**
 * NOW 的 180 天截断点：2026-07-01 00:00（+08:00）。它早于 p202606 的上界 2026-07-01T00:00Z，所以 180 天时
 * p202606 整月保留，少一天（179）就会被丢。
 */
export const CUTOFF = '2026-06-30T16:00:00.000Z';

/** 比 180 长的配置值。NOW 的截断点是 2026-05-22 00:00（+08:00）：p202604 到期，p202605 保留。 */
export const LONGER_DAYS = 220;

/** 每月一行：NOW 按 180 天丢前两个月，留最后一个月。 */
export const OLD_MONTHS: readonly string[] = ['2026-04', '2026-05', '2026-06'];
export const EXPIRED_MONTHS: readonly string[] = ['2026-04', '2026-05'];

/** NOW 这一轮预建的四个 UTC 月。 */
export const AHEAD_MONTHS: readonly string[] = monthRange('2026-12', '2027-03');

export function monthPartition(month: string): string {
  return names(TABLE, [month]).join('');
}

/** 缺迁移时先在这里以断言失败，不去执行不存在的 SQL 函数。 */
export async function requireFunction(db: Kysely<DB>): Promise<void> {
  const result = await sql<{ found: string | null }>`
    SELECT to_regprocedure(${SIGNATURE})::text AS found
  `.execute(db);
  expect(result.rows[0]?.found ?? null, SIGNATURE).not.toBeNull();
}

export async function dropExpiredRaw(
  db: Kysely<DB>,
  now: string | null,
  days: number | null,
): Promise<string[]> {
  const result = await sql<{ names: string[] | null }>`
    SELECT app.drop_expired_union_raw_payload_partitions(
      ${now}::timestamptz, ${days}::integer
    ) AS names
  `.execute(db);
  const dropped = result.rows[0]?.names;
  if (dropped === undefined) throw new Error('no row');
  if (dropped === null) throw new Error('NULL result');
  return dropped;
}

/** 一行归档，created_at 默认等于 fetched_at：夹具的结果不随跑测试的墙钟变。 */
export async function seedRaw(
  app: Kysely<DB>,
  fetchedAt: string,
  createdAt: string = fetchedAt,
): Promise<void> {
  await insert(app, { ...fixture(fetchedAt), created_at: new Date(createdAt) });
}

/** OLD_MONTHS 的月分区，每月 15 日一行。 */
export async function seedOldMonths({ app, maint }: Pick<World, 'app' | 'maint'>): Promise<void> {
  await ensureMonths(maint, TABLE, OLD_MONTHS);
  for (const month of OLD_MONTHS) await seedRaw(app, `${month}-15T00:00:00.000Z`);
}

export interface RawRow {
  readonly part: string;
  readonly at: string;
}

/** 现存行所在的分区与 fetched_at，从旧到新。 */
export async function rawRows(db: Kysely<DB>): Promise<RawRow[]> {
  const result = await sql<{ part: string; at: string }>`
    SELECT tableoid::regclass::text AS part,
      to_char(fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
    FROM app.union_raw_payloads
    ORDER BY fetched_at
  `.execute(db);
  return result.rows.map((row) => ({ part: row.part, at: row.at }));
}

/** seedOldMonths 写在这些月的行。 */
export function rowsOf(months: readonly string[]): RawRow[] {
  return months.map((month) => ({
    part: `app.${monthPartition(month)}`,
    at: `${month}-15T00:00:00.000Z`,
  }));
}

/** 一轮运行之后本表应有的分区：DEFAULT、还留着的旧月、预建的四个月。 */
export function leftAfterRun(kept: readonly string[]): string[] {
  return [`${TABLE}_default`, ...names(TABLE, [...kept, ...AHEAD_MONTHS])];
}

/** couli_app 对本表只有 SELECT、INSERT：未结束的读事务就是实际会挡住丢分区的那把锁。 */
export function holdRawRead(database: Database): Held {
  return holdLock(database, (trx) => sql`SELECT count(*) FROM app.union_raw_payloads`.execute(trx));
}

/** worker 的维护实例，时钟可调，日志原文收进 lines；maint 只有一条连接。 */
export function workerAt(
  world: Pick<World, 'maint'>,
  instant: string,
): {
  readonly maintenance: ReturnType<typeof createWorkerMaintenance>;
  readonly clock: ReturnType<typeof settableClock>;
  readonly lines: string[];
} {
  const clock = settableClock(instant);
  const { logger, lines } = memoryLogger();
  const maintenance = createWorkerMaintenance({ db: world.maint, logger, clock });
  return { maintenance, clock, lines };
}

export function dropLine(table: string, partition: string): Record<string, unknown> {
  return line('info', 'partition_dropped', { table, partition });
}
