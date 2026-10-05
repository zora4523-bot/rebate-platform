// Rule tests for the definition, the permissions and the argument checks of the day-partition
// functions (B1-01s; contract section I1 in apps/api/src/modules/platform/maintenance/index.ts).
// Basis: ADR-0001 §4.2 #4 (worker 以 couli_maint 调用 couli_migrator 所有的 SECURITY DEFINER 函数建和删
// 分区), #5 (link_logs、events 按日), #8 (couli_maint 只有分区函数的 EXECUTE，无 DDL 权限; 授权写在迁移里);
// BR-ID-30 ② (link_logs 按日分区删除). One database for the whole file: every scenario here leaves
// the partitions it checks unchanged, except where it creates its own (distinct days).
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { dayNames, dropDays, ensureDays } from './day-kit.ts';
import {
  PERMISSION_DENIED,
  connect,
  disconnect,
  ensureMonths,
  outcome,
  partitionNames,
  sqlState,
  type Roles,
} from './kit.ts';

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

interface Definition {
  readonly arguments: string;
  readonly result: string;
  readonly language: string;
  readonly securityDefiner: boolean;
  readonly owner: string;
  readonly config: string[] | null;
  readonly acl: string[];
}

async function definitionOf(name: string): Promise<Definition[]> {
  const result = await sql<{
    args: string;
    result: string;
    lang: string;
    secdef: boolean;
    owner: string;
    config: string[] | null;
    acl: string[] | null;
  }>`
    SELECT pg_get_function_identity_arguments(p.oid) AS args,
           pg_get_function_result(p.oid) AS result,
           l.lanname::text AS lang,
           p.prosecdef AS secdef,
           pg_get_userbyid(p.proowner)::text AS owner,
           p.proconfig AS config,
           p.proacl::text[] AS acl
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'app' AND p.proname = ${name}
  `.execute(roles.app);
  return result.rows.map((row) => ({
    arguments: row.args,
    result: row.result,
    language: row.lang,
    securityDefiner: row.secdef,
    owner: row.owner,
    config: row.config,
    acl: [...(row.acl ?? ['<NULL: default PUBLIC execute>'])].sort(),
  }));
}

const ACL = ['couli_maint=X/couli_migrator', 'couli_migrator=X/couli_migrator'];
const CONFIG = [
  'search_path=pg_catalog, pg_temp',
  'lock_timeout=5s',
  'DateStyle=ISO, YMD',
  'TimeZone=UTC',
];

it('[ADR-0001 §4.2 #4、#8; contract I1] app.ensure_day_partition(p_table text, p_day date) 返回 text：只有一个重载，plpgsql、SECURITY DEFINER、属主 couli_migrator、函数级设置正好是 search_path、lock_timeout=5s、DateStyle、TimeZone=UTC，EXECUTE 只给 couli_maint', async () => {
  expect(await definitionOf('ensure_day_partition')).toEqual([
    {
      arguments: 'p_table text, p_day date',
      result: 'text',
      language: 'plpgsql',
      securityDefiner: true,
      owner: 'couli_migrator',
      config: CONFIG,
      acl: ACL,
    },
  ]);
});

it('[ADR-0001 §4.2 #4、#8; BR-ID-30 ②; contract I1] app.drop_expired_day_partitions(p_table text, p_now timestamptz) 返回 text[]：只有一个重载，同样的属主、设置与 ACL', async () => {
  expect(await definitionOf('drop_expired_day_partitions')).toEqual([
    {
      arguments: 'p_table text, p_now timestamp with time zone',
      result: 'text[]',
      language: 'plpgsql',
      securityDefiner: true,
      owner: 'couli_migrator',
      config: CONFIG,
      acl: ACL,
    },
  ]);
});

it('[ADR-0001 §4.2 #8; 规划/02 §15.1 以专用角色执行] couli_app、couli_payout、couli_readonly 调用两个新函数都被拒（42501），没有建出分区；couli_maint 可以建', async () => {
  const got: Record<string, string> = {};
  for (const [role, db] of [
    ['couli_app', roles.app],
    ['couli_payout', roles.payout],
    ['couli_readonly', roles.readonly],
  ] as const) {
    got[`${role} ensure`] = await sqlState(
      sql`SELECT app.ensure_day_partition('link_logs', '2031-03-01'::date)`.execute(db),
    );
    got[`${role} drop`] = await sqlState(
      sql`SELECT app.drop_expired_day_partitions('link_logs', '2100-01-01T00:00:00Z'::timestamptz)`.execute(
        db,
      ),
    );
  }
  expect(got).toEqual({
    'couli_app ensure': PERMISSION_DENIED,
    'couli_app drop': PERMISSION_DENIED,
    'couli_payout ensure': PERMISSION_DENIED,
    'couli_payout drop': PERMISSION_DENIED,
    'couli_readonly ensure': PERMISSION_DENIED,
    'couli_readonly drop': PERMISSION_DENIED,
  });
  expect(await partitionNames(roles.maint, 'link_logs')).toEqual(['link_logs_default']);
  expect(await ensureDays(roles.maint, 'link_logs', ['2031-03-02'])).toEqual([
    'link_logs_p20310302',
  ]);
  expect(await partitionNames(roles.maint, 'link_logs')).toEqual([
    'link_logs_default',
    'link_logs_p20310302',
  ]);
});

it('[ADR-0001 §4.2 #8 couli_maint 无 DDL 权限] couli_maint 自己不能建、摘、删 link_logs 的分区（42501），只能经函数；函数删掉过期分区', async () => {
  expect(await ensureDays(roles.maint, 'link_logs', ['2020-02-02'])).toEqual([
    'link_logs_p20200202',
  ]);
  expect({
    create: await sqlState(
      sql`CREATE TABLE app.link_logs_p20990101 PARTITION OF app.link_logs
          FOR VALUES FROM ('2098-12-31 16:00:00+00') TO ('2099-01-01 16:00:00+00')`.execute(
        roles.maint,
      ),
    ),
    detach: await sqlState(
      sql`ALTER TABLE app.link_logs DETACH PARTITION app.link_logs_p20200202`.execute(roles.maint),
    ),
    drop: await sqlState(sql`DROP TABLE app.link_logs_p20200202`.execute(roles.maint)),
  }).toEqual({ create: '42501', detach: '42501', drop: '42501' });
  expect(await partitionNames(roles.maint, 'link_logs')).toContain('link_logs_p20200202');
  expect(await dropDays(roles.maint, 'link_logs', '2020-06-01T00:00:00Z')).toEqual([
    'link_logs_p20200202',
  ]);
  expect(await partitionNames(roles.maint, 'link_logs')).not.toContain('link_logs_p20200202');
});

it('[ADR-0001 §4.2 #5; contract I1a b] ensure_day_partition 只认 link_logs：别的表、尚不存在的 events、大小写或空白不同、带 schema、分区名、空串一律 22023 与确切文案，什么都不建', async () => {
  const before = {
    link_logs: await partitionNames(roles.maint, 'link_logs'),
    event_log: await partitionNames(roles.maint, 'event_log'),
    orders: await partitionNames(roles.maint, 'orders'),
  };
  const others = [
    'event_log',
    'orders',
    'events',
    'LINK_LOGS',
    'Link_Logs',
    ' link_logs',
    'link_logs ',
    'app.link_logs',
    '"link_logs"',
    'link_logs_default',
    'link_logs_p20310301',
    'no_such_table',
    '',
  ];
  const got: Record<string, string> = {};
  const want: Record<string, string> = {};
  for (const table of others) {
    got[table] = await outcome(
      sql`SELECT app.ensure_day_partition(${table}::text, '2031-03-01'::date)`.execute(roles.maint),
    );
    want[table] = `22023 ensure_day_partition: table "${table}" is not day-partitioned`;
  }
  expect(got).toEqual(want);
  expect({
    link_logs: await partitionNames(roles.maint, 'link_logs'),
    event_log: await partitionNames(roles.maint, 'event_log'),
    orders: await partitionNames(roles.maint, 'orders'),
  }).toEqual(before);
});

it('[contract I1a a、c] ensure_day_partition：NULL 参数 22004；p_day 早于 2000-01-01、晚于 9999-12-31 或为 ±infinity 时 22023，文案确切；NULL 先于名单、名单先于日期；什么都不建', async () => {
  const run = (table: string | null, day: string | null): Promise<string> =>
    outcome(
      sql`SELECT app.ensure_day_partition(${table}::text, ${day}::date)`.execute(roles.maint),
    );
  const required = '22004 ensure_day_partition: p_table and p_day are required';
  const range = '22023 ensure_day_partition: p_day must be between 2000-01-01 and 9999-12-31';
  const before = await partitionNames(roles.maint, 'link_logs');
  expect({
    nullTable: await run(null, '2031-03-01'),
    nullDay: await run('link_logs', null),
    nullDayOtherTable: await run('event_log', null),
    nullBoth: await run(null, null),
    lastDayBefore: await run('link_logs', '1999-12-31'),
    farPast: await run('link_logs', '0044-03-15'),
    afterLast: await run('link_logs', '10000-01-01'),
    infinity: await run('link_logs', 'infinity'),
    minusInfinity: await run('link_logs', '-infinity'),
    otherTableBadDay: await run('event_log', 'infinity'),
  }).toEqual({
    nullTable: required,
    nullDay: required,
    nullDayOtherTable: required,
    nullBoth: required,
    lastDayBefore: range,
    farPast: range,
    afterLast: range,
    infinity: range,
    minusInfinity: range,
    otherTableBadDay: '22023 ensure_day_partition: table "event_log" is not day-partitioned',
  });
  expect(await partitionNames(roles.maint, 'link_logs')).toEqual(before);
});

it('[BR-ID-30 ⑫、⑰; 规划/02 §15.1; contract I1b c] drop_expired_day_partitions 只认 link_logs：event_log、orders、账务与订单类表名、events、写法不同的名字一律 22023 与确切文案，event_log 与 orders 的旧分区一个不少', async () => {
  const months = ['2020-01', '2020-02'];
  await ensureMonths(roles.maint, 'event_log', months);
  await ensureMonths(roles.maint, 'orders', months);
  const before = {
    event_log: await partitionNames(roles.maint, 'event_log'),
    orders: await partitionNames(roles.maint, 'orders'),
    link_logs: await partitionNames(roles.maint, 'link_logs'),
  };
  const others = [
    'event_log',
    'orders',
    'ledger_entries',
    'order_keys',
    'audit_logs',
    'events',
    'LINK_LOGS',
    ' link_logs',
    'link_logs ',
    'app.link_logs',
    'link_logs_default',
    'event_log_p202001',
    '',
  ];
  const got: Record<string, string | string[]> = {};
  const want: Record<string, string> = {};
  for (const table of others) {
    got[table] = await outcome(
      sql`SELECT app.drop_expired_day_partitions(${table}::text, '2100-01-01T00:00:00Z'::timestamptz)`.execute(
        roles.maint,
      ),
    );
    want[table] =
      `22023 drop_expired_day_partitions: table "${table}" has no partition retention rule`;
  }
  expect(got).toEqual(want);
  expect({
    event_log: await partitionNames(roles.maint, 'event_log'),
    orders: await partitionNames(roles.maint, 'orders'),
    link_logs: await partitionNames(roles.maint, 'link_logs'),
  }).toEqual(before);
  expect(before.event_log).toEqual(
    expect.arrayContaining(['event_log_p202001', 'event_log_p202002']),
  );
});

it('[contract I1b a、b] drop_expired_day_partitions：NULL 参数 22004、p_now 为 ±infinity 时 22023，文案确切；NULL 先于有限性、有限性先于名单；什么都不删', async () => {
  expect(await ensureDays(roles.maint, 'link_logs', ['2020-03-03'])).toEqual([
    'link_logs_p20200303',
  ]);
  const run = (table: string | null, now: string | null): Promise<string> =>
    outcome(
      sql`SELECT app.drop_expired_day_partitions(${table}::text, ${now}::timestamptz)`.execute(
        roles.maint,
      ),
    );
  const required = '22004 drop_expired_day_partitions: p_table and p_now are required';
  const finite = '22023 drop_expired_day_partitions: p_now must be finite';
  expect({
    nullTable: await run(null, '2100-01-01T00:00:00Z'),
    nullNow: await run('link_logs', null),
    nullNowOtherTable: await run('event_log', null),
    nullBoth: await run(null, null),
    infinity: await run('link_logs', 'infinity'),
    minusInfinity: await run('link_logs', '-infinity'),
    infinityOtherTable: await run('orders', 'infinity'),
  }).toEqual({
    nullTable: required,
    nullNow: required,
    nullNowOtherTable: required,
    nullBoth: required,
    infinity: finite,
    minusInfinity: finite,
    infinityOtherTable: finite,
  });
  expect(await partitionNames(roles.maint, 'link_logs')).toContain('link_logs_p20200303');
});

it('[db/AGENTS.md 迁移规则 5; contract I1] 迁移不改月分区函数：ensure_month_partition 与 drop_expired_month_partitions 仍以 22023 拒绝 link_logs；新库上 link_logs 只有 DEFAULT 分区（迁移不建日分区）', async () => {
  const fresh = await createTestDatabase();
  const own = connect(fresh);
  try {
    expect(await partitionNames(own.maint, 'link_logs')).toEqual(['link_logs_default']);
    expect({
      ensureMonth: await outcome(
        sql`SELECT app.ensure_month_partition('link_logs', '2031-03-01'::date)`.execute(own.maint),
      ),
      dropMonth: await outcome(
        sql`SELECT app.drop_expired_month_partitions('link_logs', '2100-01-01T00:00:00Z'::timestamptz)`.execute(
          own.maint,
        ),
      ),
      ensureDayExists: (await definitionOfIn(own)).sort(),
    }).toEqual({
      ensureMonth: '22023 ensure_month_partition: table "link_logs" is not month-partitioned',
      dropMonth:
        '22023 drop_expired_month_partitions: table "link_logs" has no partition retention rule',
      ensureDayExists: ['drop_expired_day_partitions', 'ensure_day_partition'],
    });
    expect(dayNames('link_logs', ['2031-03-01'])).toEqual(['link_logs_p20310301']);
  } finally {
    await disconnect(own);
    await fresh.drop();
  }
});

/** Names of the app functions of this task present in the database of `own`. */
async function definitionOfIn(own: Roles): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT p.proname::text AS name FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app'
      AND p.proname IN ('ensure_day_partition', 'drop_expired_day_partitions')
  `.execute(own.app);
  return result.rows.map((r) => r.name);
}
