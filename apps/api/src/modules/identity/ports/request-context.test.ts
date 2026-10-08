// Unit tests of identity's request-identity ports without a database: the attr_code reader runs
// on a scripted Kysely driver that records every statement. The real SQL against PostgreSQL and
// the AppModule assembly are pinned by the rule tests (test/spec/identity/request-context).
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
import {
  createIdentityAttrCodeReader,
  createIdentityCallerContext,
  createIdentityViewerContext,
  type IdentityRequest,
} from './request-context.ts';

const USER = '019a0000-0000-7000-8000-000000000021';
const DEVICE = '019a0000-0000-7000-8000-000000000022';
const principal = { uid: USER, app_id: 'couli', sid: 's', device_id: DEVICE, scp: 'full' as const };

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

function scripted(reply: (statement: Statement) => readonly unknown[] | Error) {
  const statements: Statement[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const statement = { sql: compiled.sql, parameters: compiled.parameters };
      statements.push(statement);
      const rows = reply(statement);
      return rows instanceof Error ? Promise.reject(rows) : Promise.resolve({ rows: rows as R[] });
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

for (const [name, create] of [
  ['viewer', createIdentityViewerContext],
  ['caller', createIdentityCallerContext],
] as const) {
  it(`[AC-B1-02m#1] ${name}: the token principal wins over device and headers`, async () => {
    const request: IdentityRequest = {
      principal,
      verifiedDevice: { appId: 'couli_other', deviceId: 'other' },
      headers: { 'x-app-id': 'couli_other' },
    };
    await expect(create(request).current()).resolves.toEqual({
      appId: 'couli',
      userId: USER,
      deviceId: DEVICE,
    });
  });

  it(`[AC-B1-02m#2] ${name}: a verified device is a guest of its own app`, async () => {
    const request: IdentityRequest = {
      verifiedDevice: { appId: 'couli', deviceId: DEVICE },
      headers: { 'x-app-id': 'couli_other' },
    };
    await expect(create(request).current()).resolves.toEqual({
      appId: 'couli',
      userId: null,
      deviceId: DEVICE,
    });
  });

  it(`[AC-B1-02m#3] ${name}: otherwise a guest of X-App-Id; no app scope fails closed`, async () => {
    await expect(
      create({ headers: { 'x-app-id': 'couli', 'x-device-id': DEVICE } }).current(),
    ).resolves.toEqual({ appId: 'couli', userId: null, deviceId: null });
    await expect(create({ headers: {} }).current()).rejects.toThrow(/no app scope/);
    await expect(create({ headers: { 'x-app-id': '' } }).current()).rejects.toThrow();
    await expect(create({ headers: { 'x-app-id': ['couli', 'x'] } }).current()).rejects.toThrow();
    await expect(create({}).current()).rejects.toThrow();
  });

  it(`[AC-B1-02m#4] ${name}: each call reads the request as it is now`, async () => {
    const request: { principal?: typeof principal; headers: Record<string, string> } = {
      headers: { 'x-app-id': 'couli' },
    };
    const context = create(request);
    await expect(context.current()).resolves.toMatchObject({ userId: null });
    request.principal = principal;
    await expect(context.current()).resolves.toMatchObject({ userId: USER });
  });
}

it('[AC-B1-02m#5] attrCode reads users.attr_code by app and user, excluding deleted accounts', async () => {
  const { db, statements } = scripted(() => [{ attr_code: 'k3x9a0b2' }]);
  await expect(createIdentityAttrCodeReader(db).attrCode('couli', USER)).resolves.toBe('k3x9a0b2');
  expect(statements).toHaveLength(1);
  const [statement] = statements;
  expect(statement!.sql).toContain('from "app"."users"');
  expect(statement!.sql).toMatch(/"app_id" = \$1 and "id" = \$2 and "status" <> \$3/);
  expect(statement!.parameters).toEqual(['couli', USER, 'deleted']);
});

it('[AC-B1-02m#6] attrCode is null without a row or with an empty code, never the user id', async () => {
  for (const rows of [[], [{ attr_code: '' }], [{ attr_code: USER }]]) {
    const { db } = scripted(() => rows);
    const result = await createIdentityAttrCodeReader(db).attrCode('couli', USER);
    expect(result).toBeNull();
  }
});

it('[AC-B1-02m#7] attrCode treats a malformed user id as missing without querying', async () => {
  const { db, statements } = scripted(() => [{ attr_code: 'k3x9a0b2' }]);
  await expect(createIdentityAttrCodeReader(db).attrCode('couli', 'not-a-uuid')).resolves.toBe(
    null,
  );
  expect(statements).toHaveLength(0);
});

it('[AC-B1-02m#8] attrCode re-reads on every call (no per-user cache)', async () => {
  let deleted = false;
  const { db, statements } = scripted(() => (deleted ? [] : [{ attr_code: 'k3x9a0b2' }]));
  const reader = createIdentityAttrCodeReader(db);
  await expect(reader.attrCode('couli', USER)).resolves.toBe('k3x9a0b2');
  deleted = true;
  await expect(reader.attrCode('couli', USER)).resolves.toBeNull();
  expect(statements).toHaveLength(2);
});

it('[AC-B1-02m#9] attrCode rethrows a database failure unchanged', async () => {
  const failure = new Error('synthetic failure');
  const { db } = scripted(() => failure);
  await expect(createIdentityAttrCodeReader(db).attrCode('couli', USER)).rejects.toBe(failure);
});
