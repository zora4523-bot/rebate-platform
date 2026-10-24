// Unit tests of identity's own sections of a personal information copy without a database: Kysely
// runs on a scripted driver. The SQL runs against PostgreSQL in the rule tests
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
import type { PersonalDataCopyOwnerReads } from './personal-data-copy-sources.ts';
import { createPersonalDataCopySources } from './personal-data-copy-sources.ts';

const SUBJECT = { appId: 'app_unit', userId: '3f0c6a52-2b1e-4c55-9d3a-6c1d2f8e9a10' };
const CREATED_AT = new Date('2026-07-16T04:00:00.000Z');
const VERIFIED_AT = new Date('2026-10-04T04:00:00.000Z');

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

/** A cipher the fake decrypt reads back: the context and the value. */
function cipher(context: string, value: string): Buffer {
  return Buffer.from(`${context}|${value}`, 'utf8');
}

const crypto = {
  decrypt(text: string, context: string): string {
    const [written, value] = text.split('|');
    if (written !== context || value === undefined) throw new Error('fixture: wrong context');
    return value;
  },
};

function unused(): PersonalDataCopyOwnerReads {
  const fail = () => Promise.reject(new Error('not used'));
  return { orders: fail, ledger: fail, withdrawals: fail, agent: fail, invite: fail };
}

it('[AC-B1-27f-UNIT#6] 账号资料：手机号按 users.phone 解密给全号，第三方登录方式只取未撤销的绑定', async () => {
  const { db, statements } = scripted({
    users: [
      {
        nickname: 'nick',
        phone_cipher: cipher('users.phone', '13800138000'),
        created_at: CREATED_AT,
      },
    ],
    user_oauth: [{ provider: 'apple' }, { provider: 'wechat' }],
  });
  const sources = createPersonalDataCopySources({ crypto, ...unused() });
  expect(await sources.account(db, SUBJECT)).toEqual({
    nickname: 'nick',
    phone: '13800138000',
    login_providers: ['apple', 'wechat'],
    registered_at: CREATED_AT,
  });
  expect(statements[1]?.sql).toContain('"revoked_at" is null');
});

it('[AC-B1-27f-UNIT#7] 实名：已核验的只给脱敏姓名与身份证号；失败或 none（含保留税务的）不解密、不出值', async () => {
  const verified = scripted({
    realname: [
      {
        status: 'verified',
        name_cipher: cipher('realname.name', '张小三'),
        id_no_cipher: cipher('realname.id_no', '11010119900307123X'),
        verified_at: VERIFIED_AT,
      },
    ],
  });
  const sources = createPersonalDataCopySources({ crypto, ...unused() });
  expect(await sources.realname(verified.db, SUBJECT)).toEqual({
    status: 'verified',
    masked_name: '**三',
    masked_id_no: `1${'*'.repeat(16)}X`,
    verified_at: VERIFIED_AT,
  });
  for (const status of ['failed', 'none'] as const) {
    const other = scripted({
      realname: [
        {
          status,
          name_cipher: status === 'none' ? cipher('realname.name', '张小三') : null,
          id_no_cipher: status === 'none' ? cipher('realname.id_no', '11010119900307123X') : null,
          verified_at: null,
        },
      ],
    });
    expect(await sources.realname(other.db, SUBJECT), status).toEqual({
      status,
      masked_name: null,
      masked_id_no: null,
      verified_at: null,
    });
  }
});

it('[AC-B1-27f-UNIT#8] 同意记录只取 subject_type user 的本人记录', async () => {
  const { db, statements } = scripted({ consent_records: [] });
  const sources = createPersonalDataCopySources({ crypto, ...unused() });
  expect(await sources.consents(db, SUBJECT)).toEqual([]);
  expect(statements[0]?.parameters).toEqual([SUBJECT.appId, 'user', SUBJECT.userId]);
});
