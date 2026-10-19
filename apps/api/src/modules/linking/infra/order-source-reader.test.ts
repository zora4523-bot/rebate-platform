// B1-08q 源码旁单元测试：orders 来源回填用的 link_logs 读口。不连库：编译期驱动只记录语句与参数。
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createOrderSourceReader } from './order-source-reader.ts';

const USER = '019a0000-0000-7000-8000-000000000042';
const at = (iso: string) => new FixedClock(iso).now();
const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

function compileOnly(queries: { sql: string; parameters: readonly unknown[] }[]): Kysely<DB> {
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => void queries.push({ sql: event.query.sql, parameters: event.query.parameters }),
  });
  handles.push(db);
  return db;
}

it('[AC-B1-08q#u10] 建读口不查库；每次调用一条 select：App/用户/平台相等、created_at 两端闭、不按事件结果过滤', async () => {
  const queries: { sql: string; parameters: readonly unknown[] }[] = [];
  const reader = createOrderSourceReader(compileOnly(queries));
  expect(queries).toEqual([]);
  const from = at('2026-10-01T04:05:06.000Z');
  const to = at('2026-10-16T04:05:06.000Z');
  const input = { appId: 'app-1', userId: USER, platform: 'pdd', from, to };
  expect(await reader.linkLogs(input)).toEqual([]);
  expect(await reader.linkLogs(input)).toEqual([]);
  expect(queries).toHaveLength(2);
  expect(queries[0]).toEqual(queries[1]);
  expect(queries[0]!.sql).toBe(
    'select "id", "link_id", "event", "user_id", "platform", "product_key", "shop_id", ' +
      '"pid_scene", "scene", "agent_session_id", "result_code", "no_rebate", ' +
      '"no_rebate_reason", "created_at" from "app"."link_logs" where "app_id" = $1 and ' +
      '"user_id" = $2 and "platform" = $3 and "created_at" >= $4 and "created_at" <= $5 ' +
      'order by "created_at" desc, "id" desc',
  );
  expect(queries[0]!.parameters).toEqual(['app-1', USER, 'pdd', from, to]);
});

it('[AC-B1-08q#u11] 非 UUID 的用户没有外跳日志，不发出查询', async () => {
  const queries: { sql: string; parameters: readonly unknown[] }[] = [];
  const reader = createOrderSourceReader(compileOnly(queries));
  const rows = await reader.linkLogs({
    appId: 'app-1',
    userId: 'guest',
    platform: 'pdd',
    from: at('2026-10-01T04:05:06.000Z'),
    to: at('2026-10-16T04:05:06.000Z'),
  });
  expect(rows).toEqual([]);
  expect(queries).toEqual([]);
});
