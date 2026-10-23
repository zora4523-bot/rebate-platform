// 单元测试（不连库）：settle_jobs 状态只经生成的 settle-job transition()，按旧状态 CAS（decision 46）。
// Kysely 跑在脚本化驱动上，驱动只模拟 settle_jobs 一张表（事务回滚时恢复快照）；
// 真实 PG 行为由 test/spec/settlement/bill 的连库规则测试覆盖。
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
import { createBillJob, type BillJobDependencies } from './job.ts';
import {
  claimSettleJob,
  completeSettleJob,
  failSettleJob,
  settleJobStep,
  type SettleJobKey,
} from './settle-job.ts';

const APP = 'unit-app';
const RUN = '2032-07-24T00:01:00+08:00';
const T1 = '2032-07-24T00:05:00+08:00';
const T2 = '2032-07-24T01:00:00+08:00';
const KEY: SettleJobKey = { appId: APP, job: 'bill', platform: 'taobao', runAt: new Date(RUN) };

type Row = Record<string, unknown>;

/** 只认 settle_jobs 的 INSERT … ON CONFLICT DO NOTHING / SELECT … FOR UPDATE / UPDATE … WHERE id AND status。 */
function fakeDb() {
  let rows: Row[] = [];
  let saved: Row[] | null = null;
  const statements: string[] = [];
  const result = <R>(out: unknown[], affected?: bigint): QueryResult<R> =>
    (affected === undefined
      ? { rows: out }
      : { rows: out, numAffectedRows: affected }) as QueryResult<R>;
  const columns = (list: string) => [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = compiled.sql;
      const params = compiled.parameters;
      statements.push(text);
      // 账单表一律注入故障，用来模拟生成事务中途失败。
      if (text.includes('"settle_bills"')) {
        return Promise.reject(new Error('injected bill write failure'));
      }
      const insert =
        /^insert into "app"\."settle_jobs" \(([^)]*)\) values \(([^)]*)\) on conflict \(([^)]*)\) do nothing returning "id"$/.exec(
          text,
        );
      if (insert !== null) {
        const cols = columns(insert[1]!);
        const row: Row = { row_version: 0 };
        cols.forEach((c, i) => (row[c] = params[i]));
        const clash = rows.find((r) =>
          ['app_id', 'job', 'platform', 'run_at'].every((c) =>
            c === 'run_at'
              ? (r[c] as Date).getTime() === (row[c] as Date).getTime()
              : r[c] === row[c],
          ),
        );
        if (clash !== undefined) return Promise.resolve(result([]));
        rows.push(row);
        return Promise.resolve(result([{ id: row['id'] }]));
      }
      if (
        text ===
        'select "id", "status" from "app"."settle_jobs" where "app_id" = $1 and "job" = $2 and "platform" = $3 and "run_at" = $4 for update'
      ) {
        const hit = rows.find(
          (r) =>
            r['app_id'] === params[0] &&
            r['job'] === params[1] &&
            r['platform'] === params[2] &&
            (r['run_at'] as Date).getTime() === (params[3] as Date).getTime(),
        );
        return Promise.resolve(
          result(hit === undefined ? [] : [{ id: hit['id'], status: hit['status'] }]),
        );
      }
      const update =
        /^update "app"\."settle_jobs" set (.*) where "id" = \$(\d+) and "status" = \$(\d+)$/.exec(
          text,
        );
      if (update !== null) {
        const id = params[Number(update[2]) - 1];
        const from = params[Number(update[3]) - 1];
        const hit = rows.find((r) => r['id'] === id && r['status'] === from);
        if (hit === undefined) return Promise.resolve(result([], 0n));
        for (const part of update[1]!.split(', ')) {
          const set = /^"([a-z_]+)" = \$(\d+)$/.exec(part);
          const inc = /^"row_version" = "row_version" \+ \$(\d+)$/.exec(part);
          if (set !== null) hit[set[1]!] = params[Number(set[2]) - 1];
          else if (inc !== null)
            hit['row_version'] = Number(hit['row_version']) + Number(params[Number(inc[1]) - 1]);
          else return Promise.reject(new Error(`unscripted set: ${part}`));
        }
        return Promise.resolve(result([], 1n));
      }
      return Promise.reject(new Error(`unscripted statement: ${text}`));
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => {
      saved = rows.map((r) => ({ ...r }));
    },
    commitTransaction: async () => {
      saved = null;
    },
    rollbackTransaction: async () => {
      if (saved !== null) rows = saved;
      saved = null;
    },
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, rows: () => rows, statements };
}

function deps(clock: FixedClock): BillJobDependencies {
  const unused = () => Promise.reject(new Error('not reached'));
  return {
    clock,
    config: { get: async () => null },
    readSource: unused,
    readSnapshot: unused,
    readTljDeductFen: unused,
    snapshotStatus: async () => ({
      state: 'complete',
      snapshotId: 's-1',
      waitingComparable: false,
    }),
    registerDiff: unused,
    saveValidations: unused,
  };
}

it('[AC-B2-04n-UNIT#1] 只认生成的 settle-job 表内迁移；表外与未知状态抛 IllegalTransition', () => {
  expect(settleJobStep(null, 'START')).toBe('running');
  expect(settleJobStep('running', 'COMPLETE')).toBe('done');
  expect(settleJobStep('running', 'FAIL')).toBe('failed');
  expect(settleJobStep('failed', 'RETRY')).toBe('running');
  for (const [from, event] of [
    ['done', 'RETRY'],
    ['running', 'RETRY'],
    ['failed', 'COMPLETE'],
    ['done', 'START'],
    ['paused', 'COMPLETE'],
  ] as const) {
    expect(() => settleJobStep(from, event)).toThrow(
      expect.objectContaining({ name: 'IllegalTransition' }),
    );
  }
});

it('[AC-B2-04n-UNIT#2] 首投递失败：生成事务回滚后该键记为 failed，原错误照常抛出', async () => {
  const clock = new FixedClock(T1);
  const f = fakeDb();
  await expect(
    createBillJob(deps(clock)).run(f.db, { appId: APP, platform: 'taobao', runAt: new Date(RUN) }),
  ).rejects.toThrow('injected bill write failure');
  expect(f.rows()).toEqual([
    expect.objectContaining({
      app_id: APP,
      job: 'bill',
      platform: 'taobao',
      status: 'failed',
      finished_at: new Date(T1),
      row_version: 1,
    }),
  ]);
});

it('[AC-B2-04n-UNIT#3] 失败后同一 run_at 重投递：同一行经 RETRY 回 running，跑完 COMPLETE 为 done', async () => {
  const f = fakeDb();
  await failSettleJob(f.db, KEY, new Date(T1));
  const failedId = f.rows()[0]!['id'];
  expect(f.rows()).toEqual([expect.objectContaining({ status: 'failed', row_version: 1 })]);

  const claimed = await f.db.transaction().execute((trx) => claimSettleJob(trx, KEY, new Date(T2)));
  expect(claimed).toBe(failedId);
  expect(f.rows()).toEqual([
    expect.objectContaining({
      id: failedId,
      status: 'running',
      started_at: new Date(T2),
      finished_at: null,
      row_version: 2,
    }),
  ]);

  await f.db.transaction().execute((trx) => completeSettleJob(trx, claimed!, new Date(T2), 3, 1));
  expect(f.rows()).toEqual([
    expect.objectContaining({
      id: failedId,
      status: 'done',
      finished_at: new Date(T2),
      processed_count: 3,
      skipped_count: 1,
      row_version: 3,
    }),
  ]);
});

it('[AC-B2-04n-UNIT#4] done 后重投递：返回 duplicate，不发 UPDATE、不改行', async () => {
  const f = fakeDb();
  const id = await f.db.transaction().execute((trx) => claimSettleJob(trx, KEY, new Date(T1)));
  await f.db.transaction().execute((trx) => completeSettleJob(trx, id!, new Date(T1), 0, 0));
  const before = f.rows().map((r) => ({ ...r }));
  f.statements.length = 0;

  const result = await createBillJob(deps(new FixedClock(T2))).run(f.db, {
    appId: APP,
    platform: 'taobao',
    runAt: new Date(RUN),
  });
  expect(result).toEqual({ outcome: 'duplicate', billId: expect.any(String), status: null });
  expect(f.rows()).toEqual(before);
  expect(f.statements.some((s) => s.startsWith('update'))).toBe(false);
});

it('[AC-B2-04n-UNIT#5] 旧状态已被改动时 CAS 不命中，抛 IllegalTransition 而不覆盖', async () => {
  const f = fakeDb();
  const id = await f.db.transaction().execute((trx) => claimSettleJob(trx, KEY, new Date(T1)));
  await f.db.transaction().execute((trx) => completeSettleJob(trx, id!, new Date(T1), 0, 0));
  await expect(
    f.db.transaction().execute((trx) => completeSettleJob(trx, id!, new Date(T2), 9, 9)),
  ).rejects.toMatchObject({ name: 'IllegalTransition' });
  expect(f.rows()).toEqual([expect.objectContaining({ status: 'done', processed_count: 0 })]);
});
