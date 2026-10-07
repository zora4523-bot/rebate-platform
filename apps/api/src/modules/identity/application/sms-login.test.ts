// Unit tests of the SMS login service without a database (round 2 review items of B1-02j): Kysely
// runs on a scripted driver that answers each compiled statement and records it, to pin
//   - consent_records (login_page and login_merge) and login_logs written with created_at from the
//     same Clock instant as server_at, never the column's DEFAULT now();
//   - the expiries in the answer taken from what was actually issued (the JWT's exp claim and
//     refresh_tokens.expire_at), also when the Clock crosses a second between reads;
//   - the user-level consent lock taken before any user-level consent record is written or read;
//   - (round 3) the registration configuration read before the transaction opens, register() given
//     only that snapshot: no configuration read once the transaction has begun.
// The SQL itself runs against PostgreSQL in the rule tests (test/spec/identity/sms-login).
import type { DB } from '@couli/db';
import { decodeJwt } from 'jose';
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
import { createRootLogger, type Clock, type FieldCrypto } from '../../platform/index.ts';
import { createTokenKeyProvider, createTokenService } from './access-tokens.ts';
import type { RegistrationService } from './registration.ts';
import type { SmsConfigReader } from './sms-codes.ts';
import { createSmsLoginService, type SmsLoginCommand } from './sms-login.ts';

const USER_ID = '01920000-0000-7000-8000-000000000001';
const DEVICE_ID = '01920000-0000-7000-8000-000000000002';
const START_MS = Date.parse('2026-10-08T03:59:59.400Z');
const DEVICE_HASH = 'a'.repeat(64);

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

/** Each read moves 700 ms on: successive reads fall in different seconds. */
class SteppingClock implements Clock {
  private epochMs = START_MS;
  now(): Date {
    const instant = new Date(this.epochMs);
    this.epochMs += 700;
    return instant;
  }
}

/** Rows of an `insert into "t" ("a", "b") values ($1, $2), ($3, $4)` statement. */
function insertedRows(statement: Statement): Record<string, unknown>[] {
  const columns = /\(([^)]*)\) values/.exec(statement.sql)?.[1];
  if (columns === undefined) throw new Error('not an insert');
  const names = columns.split(',').map((column) => column.trim().replaceAll('"', ''));
  const rows: Record<string, unknown>[] = [];
  for (let start = 0; start < statement.parameters.length; start += names.length) {
    const row: Record<string, unknown> = {};
    names.forEach((name, index) => {
      row[name] = statement.parameters[start + index];
    });
    rows.push(row);
  }
  return rows;
}

function answer(statement: Statement, newUser: boolean): QueryResult<unknown> {
  const text = statement.sql;
  if (text.startsWith('select') && text.includes('from "users"')) {
    return { rows: newUser ? [] : [{ id: USER_ID, parent_bind_source: null }] };
  }
  if (
    text.startsWith('select') &&
    text.includes('from "consent_records"') &&
    statement.parameters.includes('device')
  ) {
    return {
      rows: [
        {
          id: '7',
          type: 'personalization',
          version: 1,
          accepted: true,
          client_at: new Date(START_MS - 60_000),
          server_at: new Date(START_MS - 60_000),
        },
      ],
    };
  }
  if (text.startsWith('select') && text.includes('from "devices"')) {
    return { rows: [{ row_version: 3, device_hash: DEVICE_HASH }] };
  }
  if (text.startsWith('update "devices"')) return { rows: [], numAffectedRows: 1n };
  return { rows: [] };
}

async function setup(
  overrides: {
    /** No account for the phone: the first-login branch calls registration.register. */
    newUser?: boolean;
    config?: SmsConfigReader;
    registration?: RegistrationService;
    /** begin / commit / rollback of the driver, in order with what the test pushes. */
    events?: string[];
  } = {},
) {
  const statements: Statement[] = [];
  const events = overrides.events ?? [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const statement = { sql: compiled.sql, parameters: compiled.parameters };
      statements.push(statement);
      return Promise.resolve(answer(statement, overrides.newUser === true) as QueryResult<R>);
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => void events.push('begin'),
    commitTransaction: async () => void events.push('commit'),
    rollbackTransaction: async () => void events.push('rollback'),
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
  const clock = new SteppingClock();
  const tokens = createTokenService({ clock, keys: await createTokenKeyProvider('test', null) });
  const crypto = {
    blindIndex: (value: string, context: string) => `hmac(${context}:${value.length})`,
  } as unknown as FieldCrypto;
  const service = createSmsLoginService({
    db,
    clock,
    crypto,
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
    versions: { minSupportedVersion: async () => null },
    sms: { verifyAndConsume: async () => ({ code: 0 }) },
    registration: overrides.registration ?? ({} as RegistrationService),
    ...(overrides.config === undefined ? {} : { config: overrides.config }),
    tokens,
  });
  const command: SmsLoginCommand = {
    body: {
      phone: '13912345678',
      code: '123456',
      legal_versions: { privacy: 3, agreement: 2 },
      consent_at: '2026-10-08T03:59:00.000Z',
    },
    app_id: 'couli',
    device_id: DEVICE_ID,
    platform: 'ios',
    channel: 'appstore',
    version: '3.0.0',
    client_ip: '192.0.2.7',
  };
  return { statements, login: () => service.login(command) };
}

function inserts(statements: readonly Statement[], table: string): Record<string, unknown>[] {
  return statements
    .filter((statement) => statement.sql.startsWith(`insert into "${table}"`))
    .flatMap(insertedRows);
}

it('[S1][BR-ID-12] 同意记录（login_page 与 login_merge）与登录记录显式写 created_at，与 server_at 同一 Clock 时刻', async () => {
  const { statements, login } = await setup();
  expect((await login()).code).toBe(0);
  const consents = inserts(statements, 'consent_records');
  expect(consents.map((row) => row.channel)).toEqual(['login_page', 'login_page', 'login_merge']);
  const signInAt = consents[0]?.server_at as Date;
  expect(signInAt).toBeInstanceOf(Date);
  for (const row of consents) {
    expect(row.created_at).toBeInstanceOf(Date);
    expect((row.created_at as Date).getTime()).toBe((row.server_at as Date).getTime());
    expect((row.server_at as Date).getTime()).toBe(signInAt.getTime());
  }
  const logs = inserts(statements, 'login_logs');
  expect(logs).toHaveLength(1);
  expect((logs[0]?.created_at as Date).getTime()).toBe(signInAt.getTime());
});

it('[S2][BR-ID-07] 响应里的到期时刻取实际签发值：access 取 JWT exp，refresh 取 refresh_tokens.expire_at，时钟跨秒也不漂移', async () => {
  const { statements, login } = await setup();
  const result = await login();
  if (result.code !== 0) throw new Error(`expected a login, got ${result.code}`);
  const { tokens } = result.data;
  const exp = decodeJwt(tokens.access_token).exp;
  expect(typeof exp).toBe('number');
  expect(tokens.access_expires_at).toBe(new Date((exp as number) * 1000).toISOString());
  const [refresh] = inserts(statements, 'refresh_tokens');
  expect(tokens.refresh_expires_at).toBe((refresh?.expire_at as Date).toISOString());
  // The Clock moved on between the consent writes and the issue: the old derivation drifted.
  const [consent] = inserts(statements, 'consent_records');
  const signInAt = (consent?.server_at as Date).getTime();
  expect(Math.floor(signInAt / 1000) * 1000 + 2 * 60 * 60 * 1000).not.toBe(
    Date.parse(tokens.access_expires_at),
  );
  expect(signInAt + 30 * 24 * 60 * 60 * 1000).not.toBe(Date.parse(tokens.refresh_expires_at));
});

it('[S1][BR-ID-12] login_merge 前取用户级事务锁：锁在任何用户级同意记录的写与读之前，键含 app_id 与 user_id', async () => {
  const { statements, login } = await setup();
  expect((await login()).code).toBe(0);
  const lockAt = statements.findIndex((statement) =>
    statement.sql.includes('pg_advisory_xact_lock'),
  );
  expect(lockAt).toBeGreaterThan(-1);
  expect(statements[lockAt]?.parameters).toEqual([
    `identity.consent_records.user:couli:${USER_ID}`,
  ]);
  const firstConsent = statements.findIndex((statement) =>
    statement.sql.includes('"consent_records"'),
  );
  expect(firstConsent).toBeGreaterThan(lockAt);
  expect(
    statements.filter((statement) => statement.sql.includes('pg_advisory_xact_lock')),
  ).toHaveLength(1);
});

it('[S1][BR-ID-05] 首次登录：注册配置在事务开始前一次读齐，事务开始后读取器零调用，register 只拿到快照', async () => {
  const events: string[] = [];
  const config: SmsConfigReader = {
    configValue: async (appId, key) => {
      events.push(`config:${appId}:${key}`);
      return key === 'risk.device_register_limit' ? { value: 1, version: 4 } : null;
    },
  };
  const seen: unknown[] = [];
  const registration: RegistrationService = {
    async register(_trx, command) {
      events.push('register');
      expect(command.device_hash).toBe(DEVICE_HASH);
      for (const key of [
        'level.default',
        'risk.merge_tombstone_dedupe',
        'risk.device_register_limit',
      ]) {
        seen.push(await command.config?.configValue(command.app_id, key));
      }
      return { code: 0, user_id: USER_ID, invite_code: 'ABCDEF', attr_code: 'abcdefgh' };
    },
  };
  const { login } = await setup({ newUser: true, config, registration, events });
  const result = await login();
  expect(result.code).toBe(0);
  if (result.code === 0) expect(result.data.is_new_user).toBe(true);
  const begin = events.indexOf('begin');
  expect(begin).toBeGreaterThan(0);
  expect(events.slice(0, begin)).toEqual([
    'config:couli:level.default',
    'config:couli:risk.merge_tombstone_dedupe',
    'config:couli:risk.device_register_limit',
  ]);
  expect(events.slice(begin).filter((event) => event.startsWith('config:'))).toEqual([]);
  expect(events.slice(begin)).toEqual(['begin', 'register', 'commit']);
  expect(seen).toEqual([null, null, { value: 1, version: 4 }]);
});

it('[S1] 已有账号登录也只在事务前读配置；未注入读取器时 register 不收到 config（沿用注册服务默认）', async () => {
  const events: string[] = [];
  const config: SmsConfigReader = {
    configValue: async (_appId, key) => {
      events.push(`config:${key}`);
      return null;
    },
  };
  const existing = await setup({ config, events });
  expect((await existing.login()).code).toBe(0);
  const begin = events.indexOf('begin');
  expect(events.slice(begin).filter((event) => event.startsWith('config:'))).toEqual([]);

  let received: unknown = 'not called';
  const registration: RegistrationService = {
    async register(_trx, command) {
      received = command.config;
      return { code: 0, user_id: USER_ID, invite_code: 'ABCDEF', attr_code: 'abcdefgh' };
    },
  };
  const plain = await setup({ newUser: true, registration });
  expect((await plain.login()).code).toBe(0);
  expect(received).toBeUndefined();
});
