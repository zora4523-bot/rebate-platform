// Unit tests of readForfeitAmount (B1-03z, D10-432): no database; a fake Kysely driver answers the
// one SELECT and records it.
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
import { LedgerError } from './errors.ts';
import { readForfeitAmount } from './forfeit-amount-read.ts';

class FakeConnection implements DatabaseConnection {
  constructor(
    private readonly rows: readonly unknown[],
    private readonly queries: CompiledQuery[],
  ) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    this.queries.push(query);
    return { rows: this.rows } as QueryResult<R>;
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('streamQuery is not used');
  }
}

class FakeDriver implements Driver {
  constructor(private readonly connection: FakeConnection) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

function fakeDb(rows: readonly unknown[]): { db: Kysely<DB>; queries: CompiledQuery[] } {
  const queries: CompiledQuery[] = [];
  const connection = new FakeConnection(rows, queries);
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new FakeDriver(connection),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

const APP = 'couli';
const USER = '019a0000-0000-7000-8000-0000000000a1';
const VOUCHER = '019a0000-0000-7000-8000-0000000000c1';
const INPUT = { appId: APP, orderKey: 'taobao:5550001', userId: USER, role: 'self' };

it('[B1-03z] 按 {order_key}:PLATFORM:FORFEIT:{uid}:{role} 读该凭证记入 COMMISSION_REVENUE 的金额（贷方为负，取反；带维度后缀的科目也算），其他科目不计；只发一条 SELECT', async () => {
  const { db, queries } = fakeDb([
    {
      voucher_id: VOUCHER,
      amount_fen: 510n,
      owner_type: 'platform',
      subject: 'UNION_RECEIVABLE:taobao',
    },
    {
      voucher_id: VOUCHER,
      amount_fen: -500n,
      owner_type: 'platform',
      subject: 'COMMISSION_REVENUE',
    },
    {
      voucher_id: VOUCHER,
      amount_fen: -10n,
      owner_type: 'platform',
      subject: 'COMMISSION_REVENUE:taobao',
    },
  ]);
  expect(await readForfeitAmount(db, INPUT)).toBe(510n);
  expect(queries).toHaveLength(1);
  const query = queries[0]!;
  expect(query.sql).toMatch(/^select /);
  expect(query.sql).toContain('"app"."ledger_vouchers"');
  expect(query.parameters).toEqual([APP, `taobao:5550001:PLATFORM:FORFEIT:${USER}:self`]);
});

it('[B1-03z] 没有该凭证 → null；有凭证但没有 COMMISSION_REVENUE 分录 → 0', async () => {
  expect(await readForfeitAmount(fakeDb([]).db, INPUT)).toBeNull();
  expect(
    await readForfeitAmount(
      fakeDb([{ voucher_id: VOUCHER, amount_fen: null, owner_type: null, subject: null }]).db,
      INPUT,
    ),
  ).toBe(0n);
});

it('[B1-03z] 输入不合法（角色不在受益人枚举、空 orderKey / userId / appId）→ LedgerError INVALID_INPUT，不查库', async () => {
  for (const bad of [
    { ...INPUT, role: 'platform' },
    { ...INPUT, orderKey: '' },
    { ...INPUT, userId: '' },
    { ...INPUT, appId: '' },
  ]) {
    const { db, queries } = fakeDb([]);
    await expect(readForfeitAmount(db, bad)).rejects.toBeInstanceOf(LedgerError);
    expect(queries).toEqual([]);
  }
});
