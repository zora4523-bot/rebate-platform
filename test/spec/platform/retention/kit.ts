// B1-15zb — BR-ID-30 正文、⑥⑩⑮⑯⑱ 保留期清理第一批：本文件头是契约（写法照
// apps/api/src/modules/platform/maintenance/index.ts 第 J 节与迁移 0022），不新增 TS 导出，也不用骨架。
//
// SQL 函数（迁移文件名不属于契约），每表一个，都只有一个重载：
//   app.delete_expired_login_logs、…_device_registrations、…_inbox_messages、…_notify_logs、
//   …_sms_send_attempts (p_now timestamptz, p_days integer, p_batch_size integer) RETURNS bigint
//   app.delete_expired_deleted_identities (p_now timestamptz, p_batch_size integer) RETURNS bigint
// - 每次最多删 p_batch_size 行，按时间列从旧到新，覆盖所有 app_id，返回实际删除数；被写入方锁住的行跳过
//   （SKIP LOCKED），留给后面的批次。
// - 前五个：created_at 严格小于截断点才删。截断点 = p_now 的 +08:00 日历日 − p_days 个日历天，再取该日
//   00:00（+08:00）；不看会话时区。deleted_identities：expire_at 严格小于 p_now 才删（⑩），不截到日界，
//   不看 created_at、deleted_at。
// - 入参：p_now、p_days、p_batch_size 为 NULL → 22004；p_now 非有限、p_batch_size 不在 1..10000、
//   p_days 不在 [下限, 36500] → 22023。下限即 08 现值：login_logs、device_registrations、inbox_messages
//   180，notify_logs、sms_send_attempts 190；36500 是防溢出的技术上限。下限写死在函数里，所以配置被改小
//   也删不过头。
// - SECURITY DEFINER，属主 couli_migrator，search_path=pg_catalog, pg_temp，lock_timeout=5s；撤销 PUBLIC
//   EXECUTE，只授 couli_maint；不新增任何角色的直接 DELETE。函数正文不引用账务、订单、审计、提现类表
//   （⑧⑫⑰）与 blocklist；order_sync_drop_keys、blocklist 本批不清（D10-457、D10-454）。
//
// 运行（createPartitionMaintenance 的 dayPartitions=true 路径，含 createWorkerMaintenance）：
// - 在第 C.4 节的门内（+08:00 04:00:00.000 起），第 J 节清理之后、C.5 之前，用同一个 now（时钟每轮只读一次）。
//   04:00 前不清理。
// - 配置每轮重读，不缓存；行写在 app_id 'couli'（种子所在的 app）。couli_maint 现在读不到 config_items，
//   只读途径由实现在迁移里给，不得给写权限。
//   - retention.purge.enabled：值为 false 时本批清理全部不跑（deleted_identities 也不跑），其他维护照常；
//     缺行按 on。
//   - retention.<login_logs|device_registrations|inbox_messages|notify_logs|sms_send_attempts>_days：
//     缺行或值不合法（不是整数、低于配置下限 30）回落 08 现值；改长后按新值。
//     30 ≤ 值 < 表下限时可以回落，也可以记一次失败，本测试只钉「不删过头」。
// - 每表独立分批：每批 1000 行、各自一条语句（不开显式事务，单连接池够用），直到返回 0 或做满 100 批；
//   积压留到下一轮。一张表失败不影响其他表，维护继续。
// - 报告形状不变，删除行不进 dropped、ensured 和 partition_maintenance_done 的计数。
// - 日志只经 options.logger，字段正好如下（只有表名与删除行数，没有手机号、设备、用户 id、IP）：
//     retention_purged        info   { table, rows }  本表本轮删了行且已清完（rows 是 number）
//     retention_purge_backlog warn   { table, rows }  做满 100 批且最后一批仍 > 0（替代上一行）
//     retention_purge_failed  error  { table, sqlstate }  本表失败：failed += 1，本表本轮不再继续；
//                                    失败前已删的行先按上两行记一条
//   没有删除、也没有失败时不写任何行（既有 run 的日志行不变）。
//
// 实现提示（不在这里测）：每表要有 created_at 或 expire_at 的单列索引，否则每批全表扫。
import { randomBytes, randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { createWorkerMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/worker.ts';
import { disconnect, type Database, type Roles } from '../../db/partitions/kit.ts';
import { memoryLogger, reduceLine, settableClock } from '../maintenance/kit.ts';

/** 2026-11-20 04:00:00.000 +08:00，门内第一刻。 */
export const NOW = '2026-11-19T20:00:00.000Z';

/** NOW 的截断点：2026-05-24 与 2026-05-14 的 00:00（+08:00）。 */
export const CUTOFF = {
  180: '2026-05-23T16:00:00.000Z',
  190: '2026-05-13T16:00:00.000Z',
} as const;

/** 各表的留存天数（BR-ID-30 ⑥⑮⑯⑱），也是 p_days 的下限。 */
export const RETAINED_DAYS = {
  login_logs: 180,
  device_registrations: 180,
  inbox_messages: 180,
  notify_logs: 190,
  sms_send_attempts: 190,
} as const;

export type CreatedAtTable = keyof typeof RETAINED_DAYS;
export type PurgedTable = CreatedAtTable | 'deleted_identities';

export const CREATED_AT_TABLES: readonly CreatedAtTable[] = [
  'login_logs',
  'device_registrations',
  'inbox_messages',
  'notify_logs',
  'sms_send_attempts',
];

export const PURGED_TABLES: readonly PurgedTable[] = [...CREATED_AT_TABLES, 'deleted_identities'];

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** ISO 时刻平移 `ms` 毫秒，格式与 times() 相同。 */
export function shift(instant: string, ms: number): string {
  return new Date(new Date(instant).getTime() + ms).toISOString();
}

/** NOW 这一轮的分界：恰等于它的行保留，早一毫秒的行删除。 */
export function boundary(table: PurgedTable): string {
  return table === 'deleted_identities' ? NOW : CUTOFF[RETAINED_DAYS[table]];
}

export function daysKey(table: CreatedAtTable): string {
  return `retention.${table}_days`;
}

export function signature(table: PurgedTable): string {
  return table === 'deleted_identities'
    ? 'app.delete_expired_deleted_identities(timestamptz,integer)'
    : `app.delete_expired_${table}(timestamptz,integer,integer)`;
}

export interface World extends Roles {
  readonly database: Database;
}

/** 每个场景一个新库；maint 只有一条连接（第 J 节同口径：每批一条语句，不再要第二条连接）。 */
export async function inWorld(
  database: Database,
  scenario: (world: World) => Promise<void>,
): Promise<void> {
  const roles: Roles = {
    maint: createDb({ connectionString: database.urlFor('couli_maint'), max: 1 }),
    app: createDb({ connectionString: database.urlFor('couli_app'), max: 2 }),
    payout: createDb({ connectionString: database.urlFor('couli_payout'), max: 1 }),
    readonly: createDb({ connectionString: database.urlFor('couli_readonly'), max: 1 }),
  };
  try {
    await scenario({ ...roles, database });
  } finally {
    await disconnect(roles);
    await database.drop();
  }
}

/** 缺迁移时先在这里以断言失败，不去执行不存在的 SQL 函数。 */
export async function requireFunctions(db: Kysely<DB>): Promise<void> {
  const result = await sql<{ signature: string }>`
    SELECT t.signature
    FROM unnest(${PURGED_TABLES.map(signature)}::text[]) AS t(signature)
    WHERE to_regprocedure(t.signature) IS NULL
  `.execute(db);
  expect(result.rows).toEqual([]);
}

export async function deleteBatch(
  db: Kysely<DB>,
  table: CreatedAtTable,
  now: string | null,
  days: number | null,
  size: number | null,
): Promise<bigint> {
  const result = await sql<{ deleted: bigint }>`
    SELECT ${sql.id('app', `delete_expired_${table}`)}(
      ${now}::timestamptz, ${days}::integer, ${size}::integer
    ) AS deleted
  `.execute(db);
  return result.rows[0]!.deleted;
}

export async function deleteIdentities(
  db: Kysely<DB>,
  now: string | null,
  size: number | null,
): Promise<bigint> {
  const result = await sql<{ deleted: bigint }>`
    SELECT app.delete_expired_deleted_identities(${now}::timestamptz, ${size}::integer) AS deleted
  `.execute(db);
  return result.rows[0]!.deleted;
}

/** 按 08 现值调用本表的函数。 */
export async function deleteAny(
  db: Kysely<DB>,
  table: PurgedTable,
  now: string,
  size: number,
): Promise<bigint> {
  return table === 'deleted_identities'
    ? deleteIdentities(db, now, size)
    : deleteBatch(db, table, now, RETAINED_DAYS[table], size);
}

function hex64(): string {
  return randomBytes(32).toString('hex');
}

async function seedUser(app: Kysely<DB>, appId: string): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO app.users
      (id, app_id, nickname, avatar, invite_code, attr_code, level, register_method, status)
    VALUES (${id}, ${appId}, 'synthetic', 'synthetic', ${randomUUID()}, ${randomUUID()},
      'L1', 'sms', 'normal')
  `.execute(app);
  return id;
}

/** 一行 deleted_identities；deleted_at 默认比 expire_at 早一天（表上有 expire_at > deleted_at）。 */
export async function seedIdentity(
  app: Kysely<DB>,
  expireAt: string,
  options: { readonly createdAt?: string; readonly appId?: string } = {},
): Promise<void> {
  const createdAt = options.createdAt ?? shift(expireAt, -DAY_MS);
  await sql`
    INSERT INTO app.deleted_identities
      (app_id, reason, phone_hmac, deleted_at, expire_at, created_at)
    VALUES (${options.appId ?? 'couli'}, 'account_deleted', ${hex64()},
      ${shift(expireAt, -DAY_MS)}::timestamptz, ${expireAt}::timestamptz,
      ${createdAt}::timestamptz)
  `.execute(app);
}

/** 本表一行，时间列（created_at，deleted_identities 为 expire_at）取 `at`。 */
export async function seedRow(
  app: Kysely<DB>,
  table: PurgedTable,
  at: string,
  appId = 'couli',
): Promise<void> {
  switch (table) {
    case 'login_logs':
      await sql`
        INSERT INTO app.login_logs (app_id, device_hash, device_id_hash, ip, method, created_at)
        VALUES (${appId}, ${hex64()}, ${hex64()}, '192.0.2.37', 'sms', ${at}::timestamptz)
      `.execute(app);
      return;
    case 'device_registrations':
      await sql`
        INSERT INTO app.device_registrations
          (app_id, device_hash, user_id, register_method, created_at)
        VALUES (${appId}, ${hex64()}, ${await seedUser(app, appId)}, 'sms', ${at}::timestamptz)
      `.execute(app);
      return;
    case 'inbox_messages':
      await sql`
        INSERT INTO app.inbox_messages
          (message_id, app_id, user_id, code, title, body, created_at)
        VALUES (${randomUUID()}, ${appId}, ${await seedUser(app, appId)}, 'SPEC', 'synthetic',
          'synthetic', ${at}::timestamptz)
      `.execute(app);
      return;
    case 'notify_logs':
      await sql`
        INSERT INTO app.notify_logs
          (id, app_id, code, channel, dedupe_key, planned_at, created_at)
        VALUES (${randomUUID()}, ${appId}, 'SPEC', 'inbox', ${randomUUID()},
          ${at}::timestamptz, ${at}::timestamptz)
      `.execute(app);
      return;
    case 'sms_send_attempts':
      await sql`
        INSERT INTO app.sms_send_attempts
          (app_id, attempt_id, ip_hmac, phone_hmac, status, created_at, updated_at)
        VALUES (${appId}, ${randomUUID()}, ${hex64()}, ${hex64()}, 'accepted',
          ${at}::timestamptz, ${at}::timestamptz)
      `.execute(app);
      return;
    case 'deleted_identities':
      await seedIdentity(app, at, { appId });
  }
}

/** login_logs 里 `count` 行，最新一行取 `newest`，每行早一毫秒。 */
export async function seedLoginLogs(app: Kysely<DB>, count: number, newest: string): Promise<void> {
  await sql`
    INSERT INTO app.login_logs (app_id, device_hash, device_id_hash, ip, method, created_at)
    SELECT 'couli', repeat('a', 64), repeat('b', 64), '192.0.2.37'::inet, 'sms',
      ${newest}::timestamptz - n * interval '1 millisecond'
    FROM generate_series(0, ${count - 1}::integer) AS series(n)
  `.execute(app);
}

/** 本表现存行的时间列，从旧到新。 */
export async function times(db: Kysely<DB>, table: PurgedTable): Promise<string[]> {
  const column = sql.id(table === 'deleted_identities' ? 'expire_at' : 'created_at');
  const result = await sql<{ at: string }>`
    SELECT to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
    FROM ${sql.table(`app.${table}`)}
    ORDER BY ${column}
  `.execute(db);
  return result.rows.map((row) => row.at);
}

export async function countRows(db: Kysely<DB>, table: string): Promise<bigint> {
  const result = await sql<{ n: bigint }>`
    SELECT count(*) AS n FROM ${sql.table(`app.${table}`)}
  `.execute(db);
  return result.rows[0]!.n;
}

/** 六张表各一行早一毫秒、一行恰在分界。 */
export async function seedAround(app: Kysely<DB>): Promise<void> {
  for (const table of PURGED_TABLES) {
    await seedRow(app, table, shift(boundary(table), -1));
    await seedRow(app, table, boundary(table));
  }
}

/** seedAround 的两行都在。 */
export function bothRows(table: PurgedTable): string[] {
  return [shift(boundary(table), -1), boundary(table)];
}

/** 到期行已删，分界上的行还在。 */
export function boundaryRow(table: PurgedTable): string[] {
  return [boundary(table)];
}

export async function expectLeft(
  db: Kysely<DB>,
  rows: (table: PurgedTable) => string[],
): Promise<void> {
  for (const table of PURGED_TABLES) {
    expect(await times(db, table), table).toEqual(rows(table));
  }
}

/** 直接写 config_items 行（couli_app），不依赖配置登记表。 */
export async function setConfig(app: Kysely<DB>, key: string, json: string): Promise<void> {
  await sql`
    INSERT INTO app.config_items (app_id, key, value, updated_by)
    VALUES ('couli', ${key}, ${json}::jsonb, 'spec')
    ON CONFLICT (app_id, key) DO UPDATE SET value = EXCLUDED.value
  `.execute(app);
}

/** worker 的维护实例，时钟可调，日志原文收进 lines。 */
export function startWorker(world: World): {
  readonly maintenance: ReturnType<typeof createWorkerMaintenance>;
  readonly clock: ReturnType<typeof settableClock>;
  readonly lines: string[];
} {
  const clock = settableClock(NOW);
  const { logger, lines } = memoryLogger();
  const maintenance = createWorkerMaintenance({ db: world.maint, logger, clock });
  return { maintenance, clock, lines };
}

/** 本批清理写的日志行（reduceLine 之后）；不是一行 JSON 的原文也留着，让断言失败。 */
export function retentionLines(lines: readonly string[]): (Record<string, unknown> | string)[] {
  return lines
    .map(reduceLine)
    .filter(
      (record) => typeof record === 'string' || String(record['msg']).startsWith('retention_'),
    );
}

export interface Held {
  readonly ready: Promise<void>;
  readonly release: () => void;
  readonly done: Promise<void>;
}

/** couli_app 自己一条连接开事务跑 `hold`，到 release() 才回滚。 */
export function holdLock(database: Database, hold: (trx: Kysely<DB>) => Promise<unknown>): Held {
  const db = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markReady: () => void = () => undefined;
  let markFailed: (reason: unknown) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    markFailed = reject;
  });
  const done = db
    .transaction()
    .execute(async (trx) => {
      await hold(trx);
      markReady();
      await released;
      throw new Error('rollback the held lock');
    })
    .catch(markFailed)
    .finally(() => destroyDb(db).catch(() => undefined));
  return { ready, release, done };
}

/**
 * 持有一行的行锁。couli_app 对 deleted_identities 没有 UPDATE，FOR UPDATE 被拒，用未提交的 DELETE
 * 持锁（holdLock 回滚）；其他表都有列级 UPDATE，FOR UPDATE 可用。
 */
export async function lockRow(trx: Kysely<DB>, table: PurgedTable, at: string): Promise<void> {
  if (table === 'deleted_identities') {
    await sql`
      DELETE FROM app.deleted_identities WHERE expire_at = ${at}::timestamptz
    `.execute(trx);
    return;
  }
  await sql`
    SELECT 1 FROM ${sql.table(`app.${table}`)} WHERE created_at = ${at}::timestamptz FOR UPDATE
  `.execute(trx);
}
