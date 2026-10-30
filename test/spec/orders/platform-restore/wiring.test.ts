// B1-08zc（评审 r1 S1 第 3 条）：生产装配必须把平台恢复端口交给订单更新步骤（编排 9.2 第 1 条）。
// 别的规则测试都自己组 OrderUpdateDeps；这里从 app.module 的 worker 入口真实组装（不连库，DummyDriver 只编译
// 语句），核对 createOrderUpdateStep 拿到的 deps 带 platformRestore 端口，且端口在调用方事务上调 ledger 的
// registerReconDiffOnce（注入的 CLOCK），登记 type platform_restore、source R1、ref_type order。
// 骗法：update-step 里做了检测，但 OrdersModule.forWorker / app.module 没把端口传进去（部署后一张单都不出）。
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import * as recon from '../../../../apps/api/src/modules/ledger/application/recon-diffs.ts';
import * as update from '../../../../apps/api/src/modules/orders/application/update-step.ts';
import type { PlatformRestoreDiffInput } from '../../../../apps/api/src/modules/orders/index.ts';
import { capture } from '../attribution/kit.ts';
import { built } from '../wiring/db-kit.ts';
import { contextOf, runtime } from '../wiring/context-kit.ts';
import { ordersTimers } from '../wiring/owner-kit.ts';

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const databases: Kysely<DB>[] = [];
afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

/** Compile-only database that keeps each statement with its parameters. */
function recordingDb(statements: Statement[]): Kysely<DB> {
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      statements.push({ sql: event.query.sql, parameters: event.query.parameters });
    },
  });
  databases.push(db);
  return db;
}

const INPUT: PlatformRestoreDiffInput = {
  appId: 'wiring-platform-restore',
  type: 'platform_restore',
  source: 'R1',
  period: '2026-10',
  refType: 'order',
  refId: 'taobao:5550001#RESTORE#41',
  expectedFen: 1234n,
  actualFen: 0n,
  diffFen: 1234n,
  dedupeKey: 'platform_restore:taobao:5550001:41',
  resolution: {
    reason_code: 'REFUND',
    rebate_status: 'VOID',
    trigger: 'status',
    platform_status: 'RECEIVED',
  },
};

type Registration = Awaited<ReturnType<typeof recon.registerReconDiffOnce>>;

it('[AC-B1-08zc#27] worker 装配把 platformRestore 端口交给 createOrderUpdateStep；端口在调用方事务上经 ledger registerReconDiffOnce 登记 platform_restore / R1 / order', async () => {
  vi.useFakeTimers();
  const makeUpdate = vi.spyOn(update, 'createOrderUpdateStep');
  const register = vi.spyOn(recon, 'registerReconDiffOnce');
  const statements: Statement[] = [];
  const db = recordingDb(statements);
  const t = ordersTimers();
  const f = await built(() => contextOf('worker', true, db));
  try {
    await runtime(f.context);
    expect(makeUpdate).toHaveBeenCalledTimes(1);
    const port = makeUpdate.mock.calls[0]![0].platformRestore;
    expect(port).toMatchObject({ register: expect.any(Function) });
    if (port === undefined) throw new Error('platformRestore port missing');
    // 装配本身不登记。
    expect(register).not.toHaveBeenCalled();
    const clock = f.context.get(f.platform.CLOCK, { strict: false });

    // ① 端口把 ledger 的结果映射为 { inserted, id }。
    const rowId = '019a0000-0000-7000-8000-0000000000aa';
    register.mockResolvedValueOnce({
      row: { id: rowId },
      inserted: true,
    } as unknown as Registration);
    await db.transaction().execute(async (trx) => {
      const result = await capture(() => port.register(trx, INPUT));
      expect(result).toEqual({ ok: true, value: { inserted: true, id: rowId } });
      expect(register).toHaveBeenCalledTimes(1);
      const [usedTrx, usedInput, dependencies] = register.mock.calls[0]!;
      expect(usedTrx).toBe(trx);
      expect(usedInput).toMatchObject(INPUT);
      expect(dependencies.clock).toBe(clock);
    });

    // ② 不打桩：真实 ledger 函数在这个事务上编译出写 recon_diffs 的语句，带本单的类型、来源、引用与键。
    register.mockClear();
    statements.splice(0);
    await db.transaction().execute(async (trx) => {
      // DummyDriver 不回行，登记结果不作断言；只核对发出的语句。
      await capture(() => port.register(trx, INPUT));
      expect(register).toHaveBeenCalledTimes(1);
      expect(register.mock.calls[0]![0]).toBe(trx);
    });
    const inserts = statements.filter((s) => /^insert into\b.*"recon_diffs"/i.test(s.sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.parameters).toEqual(
      expect.arrayContaining([
        INPUT.appId,
        'platform_restore',
        'R1',
        INPUT.period,
        'order',
        INPUT.refId,
        INPUT.dedupeKey,
        'open',
      ]),
    );
  } finally {
    t.restore();
    await f.context.close();
  }
});
