// B1-12m implementer unit tests: the settings service against a recording driver (no database).
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createNotificationSettings } from './notification-settings.ts';

const NOW = '2026-10-22T03:04:05.678Z';
const OWNER = { app_id: 'couli', user_id: '019a0000-0000-7000-8000-000000000412' };

function recording(rows: Record<string, unknown>[]) {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery: <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      queries.push(query);
      return Promise.resolve({ rows: rows as R[] });
    },
    streamQuery: () => {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (inner) => new PostgresIntrospector(inner),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

it('[AC-B1-12m#4] get without a row answers all three on and runs one scoped SELECT', async () => {
  const { db, queries } = recording([]);
  const service = createNotificationSettings({ db, clock: new FixedClock(NOW) });
  expect(await service.get(OWNER)).toEqual({
    service_push: true,
    subscription_push: true,
    marketing_push: true,
  });
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toMatch(/^select /);
  expect(queries[0]!.sql).toContain('"app"."notification_settings"');
  expect(queries[0]!.sql).toContain('"app_id" = $1');
  expect(queries[0]!.sql).toContain('"user_id" = $2');
  expect(queries[0]!.parameters).toEqual([OWNER.app_id, OWNER.user_id]);
});

it('[AC-B1-12m#5] get returns only the three stored switches', async () => {
  const stored = { service_push: false, subscription_push: true, marketing_push: false };
  const { db } = recording([{ ...stored, row_version: 3 }]);
  const service = createNotificationSettings({ db, clock: new FixedClock(NOW) });
  expect(await service.get(OWNER)).toEqual(stored);
});

it('[AC-B1-12m#6] update is one upsert with Clock times and an incremented row_version', async () => {
  const saved = { service_push: false, subscription_push: false, marketing_push: true };
  const { db, queries } = recording([saved]);
  const clock = new FixedClock(NOW);
  const service = createNotificationSettings({ db, clock });
  const result = await service.update(OWNER, { ...saved, extra: 'ignored' } as typeof saved);
  expect(result).toEqual(saved);
  expect(queries).toHaveLength(1);
  const { sql, parameters } = queries[0]!;
  expect(sql).toMatch(/^insert into "app"\."notification_settings"/);
  expect(sql).toContain('on conflict ("app_id", "user_id") do update set');
  expect(sql).toContain('"row_version" = notification_settings.row_version + 1');
  expect(sql).toContain('returning "service_push", "subscription_push", "marketing_push"');
  expect(sql).not.toContain('extra');
  expect(sql).not.toMatch(/now\(\)/i);
  expect(parameters.slice(0, 2)).toEqual([OWNER.app_id, OWNER.user_id]);
  const times = parameters.filter((value): value is Date => value instanceof Date);
  expect(times.map((value) => value.toISOString())).toEqual([NOW, NOW, NOW]);
});
