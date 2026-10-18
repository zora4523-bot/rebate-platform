// Unit tests of completeLogin's lock order around the first App login review (BR-INV-09, B1-11f
// review r1 S1), without a database: Kysely runs on a scripted driver that records each compiled
// statement. A review candidate (landing-bound, App platform, no login_logs, review assembled)
// takes its users row lock (FOR NO KEY UPDATE) before the consent advisory lock, the order of the
// OAuth lookup; nobody else takes the row lock. The SQL runs against PostgreSQL in the rule tests
// (test/spec/growth/landing-review).
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
import { FixedClock, type FieldCrypto } from '../../platform/index.ts';
import { createTokenKeyProvider, createTokenService } from './access-tokens.ts';
import { completeLogin, type FirstAppLoginReview, type LoginCommand } from './login-completion.ts';

const APP = 'couli';
const USER_ID = '01920000-0000-7000-8000-000000000001';
const DEVICE_ID = '01920000-0000-7000-8000-000000000002';
const NOW = '2026-10-18T03:04:05.000Z';

async function setup(world: { loginLogs?: boolean } = {}) {
  const statements: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(compiled);
      const text = compiled.sql;
      let rows: unknown[] = [];
      if (text.startsWith('select') && text.includes('from "login_logs"')) {
        rows = world.loginLogs === true ? [{ id: '1' }] : [];
      } else if (text.startsWith('select') && text.includes('from "users"')) {
        rows = [{ id: USER_ID }];
      } else if (text.startsWith('select') && text.includes('from "devices"')) {
        rows = [{ row_version: 3, device_hash: 'a'.repeat(64) }];
      } else if (text.startsWith('update "devices"')) {
        return Promise.resolve({ rows: [], numAffectedRows: 1n });
      }
      return Promise.resolve({ rows: rows as R[] });
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
  const clock = new FixedClock(NOW);
  const tokens = createTokenService({ clock, keys: await createTokenKeyProvider('test', null) });
  const crypto = {
    blindIndex: (value: string, context: string) => `hmac(${context}:${value})`,
  } as unknown as FieldCrypto;
  const review = vi.fn<FirstAppLoginReview['review']>(async () => {});
  const login = (
    source: string | null,
    platform: LoginCommand['platform'] = 'ios',
    withReview = true,
  ) => {
    const command: LoginCommand = {
      app_id: APP,
      device_id: DEVICE_ID,
      platform,
      client_ip: '192.0.2.7',
      body: { legal_versions: { privacy: 3, agreement: 2 }, consent_at: NOW },
    };
    return db.transaction().execute((trx) =>
      completeLogin(trx, command, { id: USER_ID, parent_bind_source: source }, 'full', 'sms', {
        clock,
        crypto,
        tokens,
        ...(withReview ? { firstAppLoginReview: { review } } : {}),
      }),
    );
  };
  const index = (pattern: RegExp) => statements.findIndex((s) => pattern.test(s.sql));
  const rowLocks = () => statements.filter((s) => /for no key update$/.test(s.sql));
  return { statements, review, login, index, rowLocks, db };
}

it('[AC-B1-11f#10] 复核候选：users 行锁（FOR NO KEY UPDATE）先于同意锁，复核在首条登录记录之后', async () => {
  const f = await setup();
  await f.login('landing');
  const rowLock = f.index(/^select "id" from "users" where .* for no key update$/);
  const consentLock = f.index(/pg_advisory_xact_lock/);
  const loginLog = f.index(/^insert into "login_logs"/);
  expect(rowLock).toBeGreaterThanOrEqual(0);
  expect(consentLock).toBeGreaterThan(rowLock);
  expect(f.statements[rowLock]!.parameters).toEqual([APP, USER_ID]);
  expect(f.statements[consentLock]!.parameters).toEqual([
    `identity.consent_records.user:${APP}:${USER_ID}`,
  ]);
  expect(f.rowLocks()).toHaveLength(1);
  expect(loginLog).toBeGreaterThan(consentLock);
  expect(f.review).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    app_id: APP,
    user_id: USER_ID,
    device_id_hash: `hmac(login_logs.device_id:${DEVICE_ID})`,
  });
  await f.db.destroy();
});

it.each([
  { case: 'register 来源', source: 'register', platform: 'ios', review: true, logs: false },
  { case: '无上级', source: null, platform: 'android', review: true, logs: false },
  { case: 'H5 平台', source: 'landing', platform: 'h5', review: true, logs: false },
  { case: '已有登录记录', source: 'landing', platform: 'ios', review: true, logs: true },
  { case: '未装配复核', source: 'landing', platform: 'ios', review: false, logs: false },
] as const)('[AC-B1-11f#13] 非候选（$case）：不取 users 行锁、不复核', async (c) => {
  const f = await setup({ loginLogs: c.logs });
  await f.login(c.source, c.platform, c.review);
  expect(f.rowLocks()).toEqual([]);
  expect(f.index(/pg_advisory_xact_lock/)).toBeGreaterThanOrEqual(0);
  expect(f.review).not.toHaveBeenCalled();
  await f.db.destroy();
});
