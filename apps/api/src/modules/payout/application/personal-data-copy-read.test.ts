// Unit tests of the withdrawal records section of a personal information copy without a database:
// Kysely runs on a scripted driver. The SQL runs against PostgreSQL in the rule tests
// (test/spec/identity/data-copies-content).
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
import { createPersonalDataCopyWithdrawalsReader } from './personal-data-copy-read.ts';

const SUBJECT = { appId: 'app_unit', userId: '3f0c6a52-2b1e-4c55-9d3a-6c1d2f8e9a10' };
const CREATED_AT = new Date('2026-10-20T00:00:00.000Z');
const PAID_AT = new Date('2026-10-20T00:20:00.000Z');

/** Answers each statement with the rows of the first table name it mentions. */
function scripted(answers: Readonly<Record<string, readonly unknown[]>>) {
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled);
      const table = Object.keys(answers).find((name) => compiled.sql.includes(`"${name}"`));
      return Promise.resolve({ rows: table === undefined ? [] : answers[table] } as QueryResult<R>);
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

function row(id: string, method: string, account: string, paidAt: Date | null) {
  return {
    id,
    status: paidAt === null ? 'PENDING_REVIEW' : 'PAID_API',
    amount_fen: 10000n,
    fee_fen: 100n,
    tax_fen: 0n,
    net_fen: 9900n,
    payout_method: method,
    payout_channel: method,
    payee_account_cipher: Buffer.from(`cipher:${account}`, 'utf8'),
    created_at: CREATED_AT,
    paid_at: paidAt,
  };
}

it('[AC-B1-27f-UNIT#4] 提现记录：收款账号解密后按方式脱敏，只取本人、不选收款人姓名与后台人员列', async () => {
  const { db, statements } = scripted({
    withdrawals: [
      row('w-alipay', 'alipay', 'zhangsan@example.com', null),
      row('w-card', 'bank_card', '6222021234567890123', PAID_AT),
      row('w-phone', 'alipay', '13800138000', null),
    ],
  });
  const methods: string[] = [];
  const read = createPersonalDataCopyWithdrawalsReader({
    decrypt: (cipher, method) => {
      methods.push(method);
      return cipher.toString('utf8').replace(/^cipher:/, '');
    },
  });
  const rows = await read(db, SUBJECT);
  expect(rows.map((item) => item.masked_account)).toEqual([
    'zh***@example.com',
    '尾号 0123',
    '138****8000',
  ]);
  expect(methods).toEqual(['alipay', 'bank_card', 'alipay']);
  expect(rows[1]).toEqual({
    withdrawal_id: 'w-card',
    status: 'PAID_API',
    amount_fen: 10000n,
    fee_fen: 100n,
    tax_fen: 0n,
    net_fen: 9900n,
    payout_channel: 'bank_card',
    masked_account: '尾号 0123',
    created_at: CREATED_AT,
    paid_at: PAID_AT,
  });
  expect(statements).toHaveLength(1);
  const [statement] = statements;
  expect(statement?.parameters).toEqual([SUBJECT.appId, SUBJECT.userId]);
  expect(statement?.sql).not.toMatch(/payee_name|payee_hmac|reviewer|executor|manual_|resolver/);
  expect(statement?.sql).not.toMatch(/\bfor\s+(update|share)\b/i);
});

it('[AC-B1-27f-UNIT#5] 提现方式不在约束内时报错，不输出未脱敏的账号', async () => {
  const { db } = scripted({ withdrawals: [row('w-x', 'cash', 'zhangsan@example.com', null)] });
  const read = createPersonalDataCopyWithdrawalsReader({ decrypt: () => 'zhangsan@example.com' });
  await expect(read(db, SUBJECT)).rejects.toThrow('payout: unknown payout method');
});
