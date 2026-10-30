// B1-08zc 实现者单元测试：runPlatformRestore 的读历史、组键与端口入参（不连库：脚本化驱动只回预设的返利历史行）。
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  runPlatformRestore,
  type PlatformRestoreCheck,
  type PlatformRestoreDiffPort,
} from './platform-restore-step.ts';

interface Entry {
  readonly id: bigint;
  readonly event: string;
}

function scriptedDb(entry: Entry | undefined) {
  const queries: { sql: string; parameters: readonly unknown[] }[] = [];
  class ScriptedDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve({
        executeQuery<R>(compiled: {
          sql: string;
          parameters: readonly unknown[];
        }): Promise<QueryResult<R>> {
          queries.push({ sql: compiled.sql, parameters: compiled.parameters });
          if (compiled.sql.includes('"app"."order_status_history"')) {
            return Promise.resolve({ rows: (entry === undefined ? [] : [entry]) as R[] });
          }
          return Promise.resolve({ rows: [] });
        },
        streamQuery() {
          throw new Error('not used');
        },
      });
    }
  }
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ScriptedDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

const CHECK: PlatformRestoreCheck = {
  app_id: 'app-u',
  order_id: '019a0000-0000-7000-8000-000000000010',
  platform: 'taobao',
  sub_order_id: '5550001',
  rebate_status: 'VOID',
  reason: 'REFUND',
  platformBefore: 'INVALID',
  platformAfter: 'RECEIVED',
  estBefore: 789n,
  estAfter: 789n,
  settleBefore: null,
  settleAfter: null,
  // 中国时间 2026-11-01 00:30。
  now: new FixedClock('2026-10-31T16:30:00.000Z').now(),
};

function port(inserted = true) {
  const register = vi
    .fn<PlatformRestoreDiffPort['register']>()
    .mockResolvedValue({ inserted, id: '019a0000-0000-7000-8000-0000000000aa' });
  return { register };
}

it('[AC-B1-08zc#u6] 前提与触发成立：读进入当前返利状态的最近一条历史，按其 id 组键并登记（中国月份、R1、order）', async () => {
  const { db, queries } = scriptedDb({ id: 41n, event: 'PLATFORM_INVALID' });
  const p = port();
  const outcome = await db.transaction().execute((trx) => runPlatformRestore(trx, p, CHECK));
  expect(outcome).toEqual({
    kind: 'registered',
    inserted: true,
    reconDiffId: '019a0000-0000-7000-8000-0000000000aa',
    trigger: 'status',
    reasonCode: 'REFUND',
    rebateStatus: 'VOID',
  });
  const history = queries.filter((q) => q.sql.includes('order_status_history'));
  expect(history).toHaveLength(1);
  expect(history[0]?.sql).toContain('order by "id" desc');
  expect(history[0]?.parameters).toEqual(
    expect.arrayContaining(['app-u', CHECK.order_id, 'rebate', 'VOID']),
  );
  expect(p.register).toHaveBeenCalledTimes(1);
  expect(p.register.mock.calls[0]?.[1]).toEqual({
    appId: 'app-u',
    type: 'platform_restore',
    source: 'R1',
    period: '2026-11',
    refType: 'order',
    refId: 'taobao:5550001#RESTORE#41',
    expectedFen: 789n,
    actualFen: 0n,
    diffFen: 789n,
    dedupeKey: 'platform_restore:taobao:5550001:41',
    resolution: {
      reason_code: 'REFUND',
      rebate_status: 'VOID',
      trigger: 'status',
      platform_status: 'RECEIVED',
    },
  });
});

it('[AC-B1-08zc#u7] 无触发或返利状态不是 VOID / CLAWED_BACK：不读历史、不调端口', async () => {
  for (const check of [
    { ...CHECK, platformBefore: 'PAID', platformAfter: 'PAID' },
    { ...CHECK, rebate_status: 'WAITING' },
  ]) {
    const { db, queries } = scriptedDb({ id: 41n, event: 'PLATFORM_INVALID' });
    const p = port();
    const outcome = await db.transaction().execute((trx) => runPlatformRestore(trx, p, check));
    expect(outcome).toEqual({ kind: 'none' });
    expect(queries.filter((q) => q.sql.includes('order_status_history'))).toEqual([]);
    expect(p.register).not.toHaveBeenCalled();
  }
});

it('[AC-B1-08zc#u8] 前提不成立（PUNISH 作废）不登记；前提成立但没有进入行 → entry_missing，不登记', async () => {
  const punished = scriptedDb({ id: 7n, event: 'PUNISH' });
  const p1 = port();
  expect(
    await punished.db
      .transaction()
      .execute((trx) => runPlatformRestore(trx, p1, { ...CHECK, reason: 'PUNISH' })),
  ).toEqual({ kind: 'none' });
  expect(p1.register).not.toHaveBeenCalled();

  const missing = scriptedDb(undefined);
  const p2 = port();
  expect(
    await missing.db.transaction().execute((trx) => runPlatformRestore(trx, p2, CHECK)),
  ).toEqual({ kind: 'entry_missing', trigger: 'status' });
  expect(p2.register).not.toHaveBeenCalled();
});

it('[AC-B1-08zc#u9] 端口回报未插入照实返回 inserted=false；端口抛错原样抛出', async () => {
  const { db } = scriptedDb({ id: 41n, event: 'PLATFORM_INVALID' });
  const p = port(false);
  await expect(
    db.transaction().execute((trx) => runPlatformRestore(trx, p, CHECK)),
  ).resolves.toMatchObject({ kind: 'registered', inserted: false });

  const boom = new Error('synthetic');
  const failing = {
    register: vi.fn<PlatformRestoreDiffPort['register']>().mockRejectedValue(boom),
  };
  await expect(
    db.transaction().execute((trx) => runPlatformRestore(trx, failing, CHECK)),
  ).rejects.toBe(boom);
});
