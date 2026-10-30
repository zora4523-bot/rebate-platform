// B2-02q: the B2-02p execution step on the ports app.module assembles (task brief §9.3; B2-02p
// rule-test review out_of_scope): payout's createWithdrawHolds — the withdraw_holds row (reason
// ledger_mismatch, source_ref recon_diff:<id>, created_by system, no expiry) and its
// withdraw_hold.add audit record, taken after the recon diff row and under the users row lock
// (BR-WDR-05 / BR-WDR-07: 先锁 users 行), without deadlock between concurrent runs — and content's
// createSystemSwitchWriter (settle.auto.enabled off by system, its history row, the alert after the
// commit). Then the worker module itself: the handler it registers on ledger-check runs a day and
// enqueues the next one.
// The audit record: audit_logs.admin_id is a NOT NULL uuid referencing admin_users (db/schema.sql),
// so a hold created by `system` cannot be stored there; its withdraw_hold.add record is the line the
// assembled audit port writes to the given logger (as payout's B2-07c system holds do), with the
// hold id as target. Real pieces: PostgreSQL as couli_app, app.module's ports, the runner with the
// real db/invariants/ledger files (module test, empty database). Synthetic: the job queue.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  LedgerDailyCheckModule,
  createDailyCheckExecutor,
  type DailyCheckFiledDifference,
  type DailyCheckExecutor,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  DAY,
  HOLD_ADD_ACTION,
  NEXT_DAY,
  QUEUE,
  RUN_AT,
  SWITCH_KEY,
  TIMEOUT,
  capturedWorkerOptions,
  dailyJob,
  diffsOf,
  expectedSend,
  fakeQueue,
  holdsOf,
  memoryLogger,
  rootLogger,
  sendView,
  sourceOf,
  userAccount,
  withDatabase,
  workerContext,
  type UserAccount,
} from './kit.ts';

/** ① difference of one user account, as 01_user-balances.sql reports it. */
function balanceDiff(account: UserAccount): DailyCheckFiledDifference {
  return {
    file: '01_user-balances.sql',
    invariant: '01',
    scope: 'account',
    app_id: account.appId,
    account_id: account.accountId,
    detail: {
      check: 'balance_cache',
      sub_account: 'available',
      cache_present: true,
      cache_fen: '500',
      expected_cache_fen: '300',
      entries_sum_fen: '-300',
    },
  };
}

/** ② difference of one voucher (global), as 02_voucher-balanced.sql reports it. */
function voucherDiff(appId: string, voucherId: string): DailyCheckFiledDifference {
  return {
    file: '02_voucher-balanced.sql',
    invariant: '02',
    scope: 'global',
    app_id: appId,
    account_id: null,
    detail: {
      voucher_id: voucherId,
      uniq_key: 'fixture:unbalanced',
      accounting_date: DAY,
      entry_count: '2',
      expected_sum_fen: '0',
      actual_sum_fen: '7',
    },
  };
}

/** The executor on the ports app.module builds for the worker entry. */
async function assembled(clock: FixedClock) {
  const root = rootLogger();
  const options = await capturedWorkerOptions(clock, root.logger);
  const { logger } = memoryLogger();
  const dependencies = {
    clock,
    logger,
    holds: options.holds(clock, root.logger),
    autoSettlement: options.autoSettlement(clock, root.logger),
  };
  const executor: DailyCheckExecutor = createDailyCheckExecutor(dependencies);
  return { root, options, executor, another: () => createDailyCheckExecutor(dependencies) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The backend of this database waiting behind `blocker` (null when `settled` first or 10 s). */
async function waiterBehind(
  db: Kysely<DB>,
  blocker: number,
  settled: () => boolean,
): Promise<number | null> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const result = await sql<{ pid: number }>`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database()
        AND ${blocker}::integer = ANY(pg_blocking_pids(pid))`.execute(db);
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) return pid;
    if (settled()) return null;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

it(
  '[AC-B2-02q#20] 装配后的真实端口：账户级差异经 payout 端口写 1 条 withdraw_holds（ledger_mismatch、recon_diff:<id>、system、无期限）并记 withdraw_hold.add 审计；全局差异经 content 端口把 settle.auto.enabled 置 off（system 写、留历史）并在提交后告警',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const clock = new FixedClock(RUN_AT);
      const { root, executor } = await assembled(clock);
      const account = await userAccount(db, clock, APP);
      const voucher = randomUUID();
      const execution = await executor.execute(db, {
        accountingDate: DAY,
        differences: [balanceDiff(account), voucherDiff(APP, voucher)],
      });

      const diffs = await diffsOf(db, APP);
      expect(diffs.map((row) => row.ref_id)).toStrictEqual([
        `01:${account.accountId}`,
        `02:${voucher}`,
      ]);
      const holds = await holdsOf(db, APP);
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({
        app_id: APP,
        user_id: account.userId,
        reason: 'ledger_mismatch',
        source_ref: sourceOf(diffs[0]!.id),
        created_by: 'system',
        created_at: clock.now(),
        hold_until: null,
        released_at: null,
        released_by: null,
      });
      const audits = root.lines().filter((line) => line['action'] === HOLD_ADD_ACTION);
      expect(audits.map((line) => line['target'])).toStrictEqual([holds[0]!.id]);

      const item = await db
        .selectFrom('config_items')
        .selectAll()
        .where('app_id', '=', APP)
        .where('key', '=', SWITCH_KEY)
        .executeTakeFirst();
      expect(item).toMatchObject({ value: false, updated_by: 'system' });
      const versions = await db
        .selectFrom('config_item_versions')
        .selectAll()
        .where('app_id', '=', APP)
        .where('key', '=', SWITCH_KEY)
        .orderBy('version')
        .execute();
      expect(versions.at(-1)).toMatchObject({
        value: false,
        updated_by: 'system',
        updated_by_admin_id: null,
      });
      expect(versions.at(-1)?.reason ?? '').toMatch(/^ledger_daily_check:/u);
      const alerts = root
        .lines()
        .filter((line) => line['key'] === SWITCH_KEY && line['app_id'] === APP);
      expect(alerts.map((line) => line['to_value'])).toStrictEqual([false]);
      expect(execution.autoSettlementOff).toStrictEqual([APP]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02q#21] 锁序：冻结在差错单行之后取 users 行锁——users 行被他人锁住时，执行段已写入差错单行并在 users 行上等待；对方放锁后照常完成 1 条冻结',
  async () => {
    await withDatabase(createTestDatabase, async (db, observer) => {
      const clock = new FixedClock(RUN_AT);
      const { executor } = await assembled(clock);
      const account = await userAccount(db, clock, APP);

      const gate = deferred<void>();
      const ready = deferred<number>();
      const blocker = observer.transaction().execute(async (trx) => {
        const self = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx);
        await sql`SELECT id FROM app.users
          WHERE app_id = ${APP} AND id = ${account.userId} FOR UPDATE`.execute(trx);
        ready.resolve(self.rows[0]!.pid);
        await gate.promise;
      });
      const blockerPid = await ready.promise;
      const state = { settled: false };
      const run = executor
        .execute(db, { accountingDate: DAY, differences: [balanceDiff(account)] })
        .finally(() => {
          state.settled = true;
        });
      let waiter: number | null = null;
      let diffLocks = -1;
      try {
        waiter = await waiterBehind(db, blockerPid, () => state.settled);
        if (waiter !== null) {
          const locks = await sql<{ n: number }>`
            SELECT count(*)::int AS n FROM pg_locks l
            JOIN pg_class c ON c.oid = l.relation
            JOIN pg_namespace s ON s.oid = c.relnamespace
            WHERE l.pid = ${waiter}::integer AND l.granted AND s.nspname = 'app'
              AND c.relname = 'recon_diffs' AND l.mode = 'RowExclusiveLock'`.execute(db);
          diffLocks = locks.rows[0]?.n ?? 0;
        }
      } finally {
        gate.resolve();
        await blocker;
      }
      const execution = await run;
      expect(waiter, 'the hold did not wait on the users row lock').not.toBeNull();
      expect(diffLocks, 'the recon diff was not written before the users lock').toBe(1);
      const diffs = await diffsOf(db, APP);
      const holds = await holdsOf(db, APP);
      expect(holds.map((row) => [row.user_id, row.source_ref])).toStrictEqual([
        [account.userId, sourceOf(diffs[0]!.id)],
      ]);
      expect(execution.reconDiffs.map((d) => d.heldUserIds)).toStrictEqual([[account.userId]]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02q#22] 并发：两次执行同一天的同一批差异（真实端口）都完成、不死锁；只 1 张差错单、每人 1 条冻结，只有一方登记',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const clock = new FixedClock(RUN_AT);
      const { executor, another } = await assembled(clock);
      const first = await userAccount(db, clock, APP);
      const second = await userAccount(db, clock, APP);
      const differences = [balanceDiff(first), balanceDiff(second)];
      const results = await Promise.allSettled([
        executor.execute(db, { accountingDate: DAY, differences }),
        another().execute(db, { accountingDate: DAY, differences }),
      ]);
      expect(results.map((result) => result.status)).toStrictEqual(['fulfilled', 'fulfilled']);
      const diffs = await diffsOf(db, APP);
      expect(diffs).toHaveLength(2);
      const holds = await holdsOf(db, APP);
      expect(holds.map((row) => row.user_id).sort()).toStrictEqual(
        [first.userId, second.userId].sort(),
      );
      const inserted = results.flatMap((result) =>
        result.status === 'fulfilled' ? result.value.reconDiffs.filter((d) => d.inserted) : [],
      );
      expect(inserted).toHaveLength(2);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02q#23] worker 模块：有库有队列时只在 ledger-check 上注册 1 个处理器；处理器用真实不变量与装配的端口跑完一天并在事务内排下一天',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const clock = new FixedClock(RUN_AT);
      const root = rootLogger();
      const options = await capturedWorkerOptions(clock, root.logger);
      const queue = fakeQueue();
      const context = await workerContext(LedgerDailyCheckModule.forWorker(options), {
        clock,
        logger: root.logger,
        db,
        queue,
      });
      try {
        expect(queue.registered.map((item) => item.queue)).toStrictEqual([QUEUE]);
        await queue.registered[0]!.handler(dailyJob({ app_id: APP, accounting_date: DAY }));
        const next = queue.sent.filter((job) => job.payload['accounting_date'] === NEXT_DAY);
        expect(next.map(sendView)).toStrictEqual([expectedSend(APP, NEXT_DAY, 86_400)]);
        expect(next[0]!.inTransaction).toBe(true);
        // An empty database: every real invariant is clean or empty, nothing is registered.
        expect(await diffsOf(db, APP)).toStrictEqual([]);
      } finally {
        await context.close();
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02q#24] worker 模块：没有数据库时不注册处理器、启动不报错',
  async () => {
    const clock = new FixedClock(RUN_AT);
    const root = rootLogger();
    const options = await capturedWorkerOptions(clock, root.logger);
    const queue = fakeQueue();
    const context = await workerContext(LedgerDailyCheckModule.forWorker(options), {
      clock,
      logger: root.logger,
      queue,
    });
    try {
      expect(queue.registered).toStrictEqual([]);
      expect(queue.sent).toStrictEqual([]);
    } finally {
      await context.close();
    }
  },
  TIMEOUT,
);
