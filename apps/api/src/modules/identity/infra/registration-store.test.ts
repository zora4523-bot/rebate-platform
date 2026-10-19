// Unit tests of insertUser without a database: Kysely runs on a scripted driver that records every
// statement. They pin where the ledger opens the account (BR-FUND-13, B2-02g): after the users row
// and the RELEASE of its savepoint, in the same transaction, never on a conflict answer, and a
// ledger failure is not mistaken for a users unique violation. The SQL itself runs against
// PostgreSQL in the rule tests (test/spec/ledger/accounts).
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
import { insertUser, type NewUser } from './registration-store.ts';

type Reply = (sql: string) => Error | undefined;

function setup(reply: Reply = () => undefined) {
  const statements: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled.sql);
      const failure = reply(compiled.sql);
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve({ rows: [] } as QueryResult<R>);
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
  return { db, statements };
}

const USER: NewUser = {
  id: '6f1d1c1e-0d55-4c0b-9a39-2f8a7e6b1c01',
  appId: 'couli',
  phoneCipher: Buffer.from('cipher'),
  phoneHmac: 'h'.repeat(64),
  nickname: 'n',
  avatar: 'a',
  inviteCode: 'ABCDEF',
  attrCode: 'attr',
  level: 'L1',
  registerMethod: 'sms',
  registeredChannel: null,
  now: new Date('2026-10-06T02:00:00.000Z'),
};

const isUsersInsert = (sql: string) => sql.startsWith('insert into "users"');
const isLedger = (sql: string) =>
  sql.includes('"ledger_accounts"') || sql.includes('"account_balances"');

it('[AC-B2-02g-UNIT#1] 插入成功：释放 users savepoint 之后在同一事务开户，账户再余额，带服务端身份参数', async () => {
  const { db, statements } = setup();
  expect(await db.transaction().execute((trx) => insertUser(trx, USER))).toBe('inserted');
  const users = statements.findIndex(isUsersInsert);
  const released = statements.indexOf('RELEASE SAVEPOINT identity_registration_user');
  const account = statements.findIndex((s) => s.startsWith('insert into "ledger_accounts"'));
  const balance = statements.findIndex((s) => s.startsWith('insert into "account_balances"'));
  expect(users).toBeGreaterThanOrEqual(0);
  expect(released).toBeGreaterThan(users);
  expect(account).toBeGreaterThan(released);
  expect(balance).toBeGreaterThan(account);
  expect(statements.filter(isLedger)).toHaveLength(2);
});

it('[AC-B2-02g-UNIT#2] users 唯一冲突回滚到 savepoint 返回冲突结果，不发任何账本语句', async () => {
  for (const [constraint, outcome] of [
    ['users_phone_hmac_key', 'phone_taken'],
    ['users_invite_code_key', 'invite_code_taken'],
    ['users_attr_code_key', 'attr_code_taken'],
  ] as const) {
    const { db, statements } = setup((sql) =>
      isUsersInsert(sql)
        ? Object.assign(new Error('duplicate'), { code: '23505', constraint })
        : undefined,
    );
    expect(await db.transaction().execute((trx) => insertUser(trx, USER))).toBe(outcome);
    expect(statements).toContain('ROLLBACK TO SAVEPOINT identity_registration_user');
    expect(statements.some(isLedger)).toBe(false);
  }
});

it('[AC-B2-02g-UNIT#3] 开户语句失败（即使形似 users 唯一冲突）原样上抛，不回答为冲突', async () => {
  const failure = Object.assign(new Error('ledger failed'), {
    code: '23505',
    constraint: 'users_phone_hmac_key',
  });
  const { db, statements } = setup((sql) =>
    sql.startsWith('insert into "ledger_accounts"') ? failure : undefined,
  );
  await expect(db.transaction().execute((trx) => insertUser(trx, USER))).rejects.toBe(failure);
  expect(statements).not.toContain('ROLLBACK TO SAVEPOINT identity_registration_user');
});

it('[AC-B2-02g-UNIT#4] 空 appId 在任何账本语句之前抛 LedgerError INVALID_INPUT', async () => {
  const { db, statements } = setup();
  await expect(
    db.transaction().execute((trx) => insertUser(trx, { ...USER, appId: '' })),
  ).rejects.toMatchObject({ name: 'LedgerError', code: 'INVALID_INPUT' });
  expect(statements.some(isLedger)).toBe(false);
});
