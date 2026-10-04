// Rule tests for the definition and the permissions of the partition-maintenance functions and for
// app.partition_default_rows (B1-01j; contract section A in
// apps/api/src/modules/platform/maintenance/index.ts). Basis: ADR-0001 §4.2 #4 (worker 以 couli_maint
// 调用 couli_migrator 所有的 SECURITY DEFINER 函数; 每张分区表设 DEFAULT 分区兜底，其中有数据即告警),
// #8 (couli_maint 只有分区函数的 EXECUTE，无 DDL 权限; 授权写在迁移里); 规划/02 §15.1 (分区的预建与删除由
// worker 定时任务以专用角色执行).
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  PERMISSION_DENIED,
  connect,
  disconnect,
  ensureMonths,
  insertEvents,
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

it('[ADR-0001 §4.2 #4、#8] app.drop_expired_month_partitions(text, timestamptz) 返回 text[]：只有一个重载，plpgsql、SECURITY DEFINER、属主 couli_migrator、search_path 固定为 pg_catalog, pg_temp，EXECUTE 只给 couli_maint（PUBLIC 已收回）', async () => {
  expect(await definitionOf('drop_expired_month_partitions')).toEqual([
    {
      arguments: 'p_table text, p_now timestamp with time zone',
      result: 'text[]',
      language: 'plpgsql',
      securityDefiner: true,
      owner: 'couli_migrator',
      config: ['search_path=pg_catalog, pg_temp'],
      acl: ACL,
    },
  ]);
});

it('[ADR-0001 §4.2 #4、#8] app.partition_default_rows() 返回 TABLE(table_name text, default_partition text, row_count bigint)：同样是属主 couli_migrator 的 SECURITY DEFINER 函数，EXECUTE 只给 couli_maint', async () => {
  expect(await definitionOf('partition_default_rows')).toEqual([
    {
      arguments: '',
      result: 'TABLE(table_name text, default_partition text, row_count bigint)',
      language: 'plpgsql',
      securityDefiner: true,
      owner: 'couli_migrator',
      config: ['search_path=pg_catalog, pg_temp'],
      acl: ACL,
    },
  ]);
});

it('[ADR-0001 §4.2 #8; 规划/02 §15.1 以专用角色执行] couli_app、couli_payout、couli_readonly 调用两个函数都被拒（42501），分区不变；couli_maint 可以调用', async () => {
  await ensureMonths(roles.maint, 'event_log', ['2019-01']);
  const got: Record<string, string> = {};
  for (const [role, db] of [
    ['couli_app', roles.app],
    ['couli_payout', roles.payout],
    ['couli_readonly', roles.readonly],
  ] as const) {
    got[`${role} drop`] = await sqlState(
      sql`SELECT app.drop_expired_month_partitions('event_log', '2100-01-01T00:00:00Z'::timestamptz)`.execute(
        db,
      ),
    );
    got[`${role} drop retained`] = await sqlState(
      sql`SELECT app.drop_expired_month_partitions('orders', '2100-01-01T00:00:00Z'::timestamptz)`.execute(
        db,
      ),
    );
    got[`${role} default rows`] = await sqlState(
      sql`SELECT * FROM app.partition_default_rows()`.execute(db),
    );
  }
  got['couli_maint default rows'] = await sqlState(
    sql`SELECT * FROM app.partition_default_rows()`.execute(roles.maint),
  );
  expect(got).toEqual({
    'couli_app drop': PERMISSION_DENIED,
    'couli_app drop retained': PERMISSION_DENIED,
    'couli_app default rows': PERMISSION_DENIED,
    'couli_payout drop': PERMISSION_DENIED,
    'couli_payout drop retained': PERMISSION_DENIED,
    'couli_payout default rows': PERMISSION_DENIED,
    'couli_readonly drop': PERMISSION_DENIED,
    'couli_readonly drop retained': PERMISSION_DENIED,
    'couli_readonly default rows': PERMISSION_DENIED,
    'couli_maint default rows': 'ok',
  });
  expect(await partitionNames(roles.maint, 'event_log')).toEqual([
    'event_log_default',
    'event_log_p201901',
  ]);
});

it('[ADR-0001 §4.2 #8 couli_maint 无 DDL 权限] couli_maint 自己不能删、摘、建分区（42501），只能经 SECURITY DEFINER 函数删', async () => {
  await ensureMonths(roles.maint, 'event_log', ['2019-02']);
  expect({
    drop: await sqlState(sql`DROP TABLE app.event_log_p201902`.execute(roles.maint)),
    detach: await sqlState(
      sql`ALTER TABLE app.event_log DETACH PARTITION app.event_log_p201902`.execute(roles.maint),
    ),
    create: await sqlState(
      sql`CREATE TABLE app.event_log_p209901 PARTITION OF app.event_log
          FOR VALUES FROM ('2099-01-01 00:00:00+00') TO ('2099-02-01 00:00:00+00')`.execute(
        roles.maint,
      ),
    ),
  }).toEqual({ drop: '42501', detach: '42501', create: '42501' });
  expect(await partitionNames(roles.maint, 'event_log')).toContain('event_log_p201902');
  const viaFunction = await sql<{ names: string[] }>`
    SELECT app.drop_expired_month_partitions('event_log', '2100-01-01T00:00:00Z'::timestamptz) AS names
  `
    .execute(roles.maint)
    .then(
      (r) => r.rows[0]?.names ?? [],
      (error: unknown) => [`failed ${String(error)}`],
    );
  expect(viaFunction).toContain('event_log_p201902');
  expect(await partitionNames(roles.maint, 'event_log')).not.toContain('event_log_p201902');
});

/** Every partitioned table of schema app that has a DEFAULT partition, from the catalogue. */
async function partitionedWithDefault(): Promise<Array<{ table: string; partition: string }>> {
  const result = await sql<{ t: string; d: string }>`
    SELECT p.relname::text AS t, d.relname::text AS d
    FROM pg_partitioned_table pt
    JOIN pg_class p ON p.oid = pt.partrelid
    JOIN pg_namespace n ON n.oid = p.relnamespace
    JOIN pg_class d ON d.oid = pt.partdefid
    WHERE n.nspname = 'app'
    ORDER BY p.relname COLLATE "C"
  `.execute(roles.app);
  return result.rows.map((row) => ({ table: row.t, partition: row.d }));
}

async function defaultRows(
  db = roles.maint,
): Promise<Array<{ table_name: string; default_partition: string; row_count: unknown }>> {
  const result = await sql<{ table_name: string; default_partition: string; row_count: unknown }>`
    SELECT * FROM app.partition_default_rows()
  `
    .execute(db)
    .catch((error: unknown) => ({
      rows: [
        {
          table_name: `failed ${String((error as { code?: unknown }).code)}`,
          default_partition: '',
          row_count: null,
        },
      ],
    }));
  return result.rows.map((row) => ({ ...row }));
}

it('[ADR-0001 §4.2 #4 每张分区表设 DEFAULT 分区兜底] 没有数据时：每张带 DEFAULT 的 app 分区表（含 event_log、link_logs、orders）正好一行、按表名排序、row_count 为 0（bigint）', async () => {
  const catalogue = await partitionedWithDefault();
  expect(catalogue.map((c) => c.table)).toEqual(
    expect.arrayContaining(['event_log', 'link_logs', 'orders']),
  );
  expect(await defaultRows()).toEqual(
    catalogue.map((c) => ({ table_name: c.table, default_partition: c.partition, row_count: 0n })),
  );
  const named = (await defaultRows()).filter((r) =>
    ['event_log', 'link_logs', 'orders'].includes(r.table_name),
  );
  expect(named).toEqual([
    { table_name: 'event_log', default_partition: 'event_log_default', row_count: 0n },
    { table_name: 'link_logs', default_partition: 'link_logs_default', row_count: 0n },
    { table_name: 'orders', default_partition: 'orders_default', row_count: 0n },
  ]);
});

it('[ADR-0001 §4.2 #4 其中有数据即告警] row_count 是 DEFAULT 分区里的确切行数：落进月分区的行不算，DEFAULT 里 3 行就是 3；建了别的月分区后不变', async () => {
  const fresh = await createTestDatabase();
  const own = connect(fresh);
  try {
    await ensureMonths(own.maint, 'event_log', ['2030-06']);
    expect(await insertEvents(own.app, '2030-06-10T00:00:00Z', 1)).toEqual([
      'app.event_log_p203006',
    ]);
    expect(await insertEvents(own.app, '2030-05-31T23:59:59.999Z', 3)).toEqual([
      'app.event_log_default',
      'app.event_log_default',
      'app.event_log_default',
    ]);
    const rowsOf = async (): Promise<Record<string, unknown>> =>
      Object.fromEntries(
        (await defaultRows(own.maint)).map((r) => [r.table_name, r.row_count] as const),
      );
    expect(await rowsOf()).toEqual(
      expect.objectContaining({ event_log: 3n, link_logs: 0n, orders: 0n }),
    );
    await ensureMonths(own.maint, 'event_log', ['2030-07']);
    expect((await rowsOf()).event_log).toBe(3n);
    expect(await outcome(ensureMonths(own.maint, 'event_log', ['2030-05']))).toMatch(/^23514 /);
  } finally {
    await disconnect(own);
    await fresh.drop();
  }
});
