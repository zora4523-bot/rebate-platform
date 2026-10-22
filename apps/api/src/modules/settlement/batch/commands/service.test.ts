// 单元测试（不连库）：命令时刻取在行锁之后，等待期间跨会计日按新日期重新校验（评审 r1 S1）。
// Kysely 跑在脚本化驱动上，只模拟本服务发出的几条语句；真实 PG 行为由 test/spec/settlement/batch-commands 覆盖。
import { accountingDate } from '@couli/domain';
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
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import { createBatchCommandService, type BatchCommandDeps } from './service.ts';

const APP = 'unit-app';
const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const BATCH = '00000000-0000-4000-8000-0000000000b1';
const BILL = 'bill-1';
const BEFORE_MIDNIGHT = '2032-07-24T23:59:59.999+08:00';
const AFTER_MIDNIGHT = '2032-07-25T00:00:00.001+08:00';

function batchRow(status: string) {
  return {
    batch_id: BATCH,
    app_id: APP,
    bill_id: BILL,
    platform: 'jd',
    kind: 'main',
    status,
    settle_mode: 'IMMEDIATE',
    scheduled_at: null,
    confirmed_by: status === 'DRAFT' ? null : ADMIN,
    confirmed_at: status === 'DRAFT' ? null : new Date('2032-07-20T10:00:00+08:00'),
    cancelled_reason: null,
    settle_run_id: null,
    order_count: 1,
    started_at: null,
    finished_at: null,
    paused_by_switch_at: null,
    row_version: 3,
    created_at: new Date('2032-07-20T09:00:00+08:00'),
  };
}

function setup(status: string, clock: FixedClock, onLock: () => void = () => undefined) {
  const updates: unknown[][] = [];
  const result = <R>(rows: unknown[], affected?: bigint): QueryResult<R> =>
    (affected === undefined ? { rows } : { rows, numAffectedRows: affected }) as QueryResult<R>;
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = compiled.sql;
      if (text.startsWith('select "generated_at" from "settle_bills"')) {
        return Promise.resolve(result([{ generated_at: new Date('2032-07-20T09:00:00+08:00') }]));
      }
      if (text.startsWith('select * from "settle_batches"') && text.endsWith('for update')) {
        onLock(); // 等待行锁期间时钟前进
        return Promise.resolve(result([batchRow(status)]));
      }
      if (text.startsWith('update "settle_batches"')) {
        updates.push([...compiled.parameters]);
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
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
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
  const readiness = vi.fn<BatchCommandDeps['readiness']>();
  const service = createBatchCommandService({
    db,
    clock,
    currentRound: async () => [BATCH],
    readiness,
  });
  return { service, readiness, updates };
}

/** 只有列出的会计日快照已完成；两个开关都开。 */
function snapshotsCompletedOn(days: readonly string[]) {
  return async ({ at }: { readonly at: Date }) => ({
    autoEnabled: true,
    creditEnabled: true,
    snapshotCompleted: days.includes(accountingDate(at)),
    snapshotTimedOut: false,
  });
}

const resume = { appId: APP, adminId: ADMIN, batchId: BATCH, expectedRowVersion: 3 };

it('[AC-B2-04o-UNIT#1] SB8 等待行锁跨过午夜：按锁后的新会计日查快照，新日未完成即拒绝且不写', async () => {
  const clock = new FixedClock(BEFORE_MIDNIGHT);
  const h = setup('PARTIAL', clock, () => clock.set(AFTER_MIDNIGHT));
  h.readiness.mockImplementation(snapshotsCompletedOn(['2032-07-24']));
  await expect(h.service.resumeBatch(resume)).rejects.toMatchObject({
    name: 'BatchCommandRejected',
    reason: 'snapshot_pending',
  });
  expect(h.readiness).toHaveBeenCalledTimes(1);
  expect(h.readiness).toHaveBeenCalledWith({
    appId: APP,
    platform: 'jd',
    at: new Date(AFTER_MIDNIGHT),
  });
  expect(h.updates).toHaveLength(0);
});

it('[AC-B2-04o-UNIT#2] SB8 快照查询期间跨过午夜：按新日期重新校验，新日未完成即拒绝且保持 PARTIAL', async () => {
  const clock = new FixedClock(BEFORE_MIDNIGHT);
  const h = setup('PARTIAL', clock);
  const check = snapshotsCompletedOn(['2032-07-24']);
  h.readiness.mockImplementation(async (input) => {
    const ready = await check(input);
    clock.set(AFTER_MIDNIGHT); // 查询返回时已是次日
    return ready;
  });
  await expect(h.service.resumeBatch(resume)).rejects.toMatchObject({
    name: 'BatchCommandRejected',
    reason: 'snapshot_pending',
  });
  expect(h.readiness.mock.calls.map(([input]) => accountingDate(input.at))).toEqual([
    '2032-07-24',
    '2032-07-25',
  ]);
  expect(h.updates).toHaveLength(0);
});

it('[AC-B2-04o-UNIT#3] SB8 查询期间跨日但新日快照也已完成：重新校验后放行', async () => {
  const clock = new FixedClock(BEFORE_MIDNIGHT);
  const h = setup('PARTIAL', clock);
  const check = snapshotsCompletedOn(['2032-07-24', '2032-07-25']);
  h.readiness.mockImplementation(async (input) => {
    const ready = await check(input);
    clock.set(AFTER_MIDNIGHT);
    return ready;
  });
  await h.service.resumeBatch(resume);
  expect(h.readiness).toHaveBeenCalledTimes(2);
  expect(h.updates).toHaveLength(1);
  expect(h.updates[0]).toContain('EXECUTING');
});

it('[AC-B2-04o-UNIT#4] SB8 未跨日：只查一次当日快照并放行', async () => {
  const clock = new FixedClock('2032-07-24T10:00:00+08:00');
  const h = setup('PARTIAL', clock, () => clock.advanceMs(500));
  h.readiness.mockImplementation(snapshotsCompletedOn(['2032-07-24']));
  await h.service.resumeBatch(resume);
  expect(h.readiness).toHaveBeenCalledTimes(1);
  expect(h.readiness).toHaveBeenCalledWith({
    appId: APP,
    platform: 'jd',
    at: new Date('2032-07-24T10:00:00.500+08:00'),
  });
  expect(h.updates).toHaveLength(1);
  expect(h.updates[0]).toContain('EXECUTING');
});

it('[AC-B2-04o-UNIT#5] SB2 等待行锁期间越过定时时刻：按锁后时刻拒绝，不确认', async () => {
  const clock = new FixedClock('2032-07-24T10:00:00+08:00');
  const scheduledAt = new Date('2032-07-24T10:00:01+08:00');
  const h = setup('DRAFT', clock, () => clock.set('2032-07-24T10:00:02+08:00'));
  await expect(
    h.service.confirmBill({
      appId: APP,
      adminId: ADMIN,
      billId: BILL,
      expectedBatches: [{ batchId: BATCH, expectedRowVersion: 3 }],
      mode: 'SCHEDULED',
      scheduledAt,
    }),
  ).rejects.toMatchObject({ name: 'BatchCommandRejected', reason: 'invalid_schedule' });
  expect(h.updates).toHaveLength(0);
});

it('[AC-B2-04o-UNIT#6] SB2 confirmed_at 取行锁之后的时刻', async () => {
  const clock = new FixedClock('2032-07-24T10:00:00+08:00');
  const h = setup('DRAFT', clock, () => clock.set('2032-07-24T10:00:02+08:00'));
  await h.service.confirmBill({
    appId: APP,
    adminId: ADMIN,
    billId: BILL,
    expectedBatches: [{ batchId: BATCH, expectedRowVersion: 3 }],
  });
  expect(h.updates).toHaveLength(1);
  expect(h.updates[0]).toContainEqual(new Date('2032-07-24T10:00:02+08:00'));
  expect(h.updates[0]).toContain('CONFIRMED');
});
