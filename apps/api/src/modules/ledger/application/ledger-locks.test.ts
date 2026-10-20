// Unit tests of the B2-02n fail-closed fixes without a database. Kysely runs on a scripted
// driver that models what matters here: a ROLLBACK TO SAVEPOINT undoes both the row locks and the
// transaction-local setting written after that savepoint, RELEASE keeps them. The real
// PostgreSQL behaviour is covered by the rule tests in test/spec/ledger/hardening.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createDailyCheck } from './daily-check.ts';
import { LedgerError } from './errors.ts';
import { createLedger } from './reverse.ts';
import type { PostingVoucher } from './ledger.ts';

const APP = 'unit-app';
const USER = randomUUID();
const ACCOUNT = randomUUID();
const PLATFORM = randomUUID();

interface Frame {
  readonly name: string;
  readonly setting: string | null;
  readonly locks: ReadonlySet<string>;
  readonly vouchers: ReadonlySet<string>;
}

function setup() {
  const events: string[] = [];
  const statements: string[] = [];
  let setting: string | null = null;
  let locks = new Set<string>();
  let vouchers = new Set<string>();
  const frames: Frame[] = [];
  const balance = {
    app_id: APP,
    account_id: ACCOUNT,
    user_id: USER,
    available_fen: 0n,
    frozen_fen: 0n,
    version: 0n,
    negative_since: null,
  };
  const result = <R>(rows: unknown[], affected?: bigint): QueryResult<R> =>
    (affected === undefined ? { rows } : { rows, numAffectedRows: affected }) as QueryResult<R>;

  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = compiled.sql;
      const params = compiled.parameters;
      statements.push(text);
      let match = /^SAVEPOINT (\S+)/.exec(text);
      if (match) {
        frames.push({
          name: match[1]!,
          setting,
          locks: new Set(locks),
          vouchers: new Set(vouchers),
        });
        return Promise.resolve(result([]));
      }
      match = /^ROLLBACK TO SAVEPOINT (\S+)/.exec(text);
      if (match) {
        const at = frames.map((f) => f.name).lastIndexOf(match[1]!);
        const frame = frames[at]!;
        frames.length = at + 1;
        setting = frame.setting;
        locks = new Set(frame.locks);
        vouchers = new Set(frame.vouchers);
        return Promise.resolve(result([]));
      }
      match = /^RELEASE SAVEPOINT (\S+)/.exec(text);
      if (match) {
        frames.length = frames.map((f) => f.name).lastIndexOf(match[1]!);
        return Promise.resolve(result([]));
      }
      if (text.includes('set_config(')) {
        setting = `${setting ?? ''} ${String(params[2])}`;
        return Promise.resolve(result([]));
      }
      if (text.includes('current_setting(')) {
        return Promise.resolve(result([{ tokens: setting }]));
      }
      if (text.includes('from "account_balances" as "ab"')) {
        const wanted = params.includes(USER) || params.includes(ACCOUNT);
        if (text.includes('for update')) {
          events.push(text.includes('nowait') ? 'relock' : 'lock');
          if (wanted) locks.add(ACCOUNT);
        }
        return Promise.resolve(result(wanted ? [{ ...balance }] : []));
      }
      if (text.includes('from "ledger_accounts"')) {
        if (text.includes('"subject"') && params.includes('platform')) {
          return Promise.resolve(result([{ id: PLATFORM, subject: 'UNION_RECEIVABLE:taobao' }]));
        }
        return Promise.resolve(result(params.includes(ACCOUNT) ? [{ id: ACCOUNT }] : []));
      }
      if (text.includes('from "ledger_vouchers"')) {
        const key = params.find((p) => typeof p === 'string' && vouchers.has(p));
        return Promise.resolve(result(key === undefined ? [] : [{ id: randomUUID() }]));
      }
      if (text.startsWith('insert into "ledger_vouchers"')) {
        events.push('voucher');
        for (const p of params) if (typeof p === 'string' && p.startsWith('POST:')) vouchers.add(p);
        return Promise.resolve(result([], 1n));
      }
      if (text.startsWith('insert into "ledger_entries"')) {
        events.push('entries');
        return Promise.resolve(result([], 2n));
      }
      if (text.startsWith('update "account_balances"')) {
        events.push('balance');
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
  const ledger = createLedger({ clock: new FixedClock('2032-06-15T08:00:00.000Z') });
  return { db, events, statements, ledger, held: () => new Set(locks) };
}

function voucher(userAmount: bigint): PostingVoucher {
  const line = {
    sub_account: 'available' as const,
    ledger_type: 'REBATE_CREDIT',
    sub_type: null,
  };
  return {
    appId: APP,
    uniqKey: `POST:${randomUUID()}`,
    bizType: 'TEST_POSTING',
    bizId: randomUUID(),
    operator: 'system',
    memo: null,
    orderKey: null,
    beneficiaryUserId: null,
    role: null,
    voucherKind: null,
    entries: [
      {
        ...line,
        account: { ownerType: 'user', accountId: ACCOUNT },
        amount_fen: userAmount,
        income_type: 'SERVICE_FEE',
      },
      {
        ...line,
        account: { ownerType: 'platform', subject: 'UNION_RECEIVABLE:taobao' },
        amount_fen: -userAmount,
        income_type: null,
      },
    ],
  };
}

it('[AC-B2-02n-UNIT#1] 调用方回滚到保存点后 post 与 reverse 报 NOT_LOCKED，不重新取锁也不写入', async () => {
  const { db, events, ledger, held } = setup();
  await db.transaction().execute(async (trx) => {
    await sql`SAVEPOINT caller`.execute(trx);
    await ledger.lockBalances(trx, { appId: APP, userIds: [USER] });
    await sql`ROLLBACK TO SAVEPOINT caller`.execute(trx);
    expect(held().size).toBe(0);
    const attempt = ledger.post(trx, voucher(-100n));
    await expect(attempt).rejects.toBeInstanceOf(LedgerError);
    await expect(attempt).rejects.toMatchObject({ code: 'NOT_LOCKED' });
    expect(events).toEqual(['lock']);
    expect(held().size).toBe(0);

    // Relocking explicitly restores posting in the same transaction.
    await ledger.lockBalances(trx, { appId: APP, userIds: [USER] });
    expect((await ledger.post(trx, voucher(-100n))).kind).toBe('posted');
    expect(events).toEqual(['lock', 'lock', 'relock', 'voucher', 'entries', 'balance']);
  });
});

it('[AC-B2-02n-UNIT#2] post 被拒、ledger 自己的保存点回滚后，此前 lockBalances 的锁仍有效', async () => {
  const { db, events, ledger } = setup();
  await db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId: APP, userIds: [USER] });
    // +100 user-side amount leaves available at -100: refused inside post's own savepoint.
    await expect(ledger.post(trx, voucher(100n))).rejects.toMatchObject({
      code: 'NEGATIVE_BALANCE',
    });
    expect((await ledger.post(trx, voucher(-100n))).kind).toBe('posted');
    expect((await ledger.post(trx, voucher(-50n))).kind).toBe('posted');
    expect(events.filter((e) => e === 'lock')).toEqual(['lock']);
    expect(events.filter((e) => e === 'voucher')).toHaveLength(2);
  });
});

it('[AC-B2-02n-UNIT#3] RELEASE SAVEPOINT 后锁仍有效，post 照常成功', async () => {
  const { db, ledger } = setup();
  await db.transaction().execute(async (trx) => {
    await sql`SAVEPOINT caller`.execute(trx);
    await ledger.lockBalances(trx, { appId: APP, userIds: [USER] });
    await sql`RELEASE SAVEPOINT caller`.execute(trx);
    expect((await ledger.post(trx, voucher(-100n))).kind).toBe('posted');
  });
});

it('[AC-B2-02n-UNIT#4] 一个事务的锁登记不会被另一个事务对象沿用', async () => {
  const { db, ledger } = setup();
  await db
    .transaction()
    .execute((trx) => ledger.lockBalances(trx, { appId: APP, userIds: [USER] }));
  await db.transaction().execute(async (trx) => {
    await expect(ledger.post(trx, voucher(-100n))).rejects.toMatchObject({ code: 'NOT_LOCKED' });
  });
});

it('[AC-B2-02n-UNIT#5] 不变量集合为空时日终校验 DAILY_CHECK_FAILED、记一条失败日志、不执行任何语句', async () => {
  const { db, statements } = setup();
  const logs: Record<string, unknown>[] = [];
  const runner = createDailyCheck({
    clock: new FixedClock('2032-06-15T17:00:00.000Z'),
    logger: { warn: () => undefined, error: (fields) => void logs.push(fields) },
    invariants: { load: async () => [] },
  });
  const attempt = runner.runDailyCheck(db, { accountingDate: '2032-06-14' });
  await expect(attempt).rejects.toBeInstanceOf(LedgerError);
  await expect(attempt).rejects.toMatchObject({ code: 'DAILY_CHECK_FAILED' });
  expect(logs).toEqual([
    expect.objectContaining({
      event: 'ledger_daily_check_failed',
      accounting_date: '2032-06-14',
    }),
  ]);
  expect(statements).toEqual([]);
});
