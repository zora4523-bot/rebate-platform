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
import type { FieldCrypto } from '../../platform/index.ts';
import { createMaskedPhoneReader } from './masked-phones.ts';

const APP = 'couli';
const A = '019a0000-0000-7000-8000-000000000001';
const B = '019a0000-0000-7000-8000-000000000002';

/** A Kysely whose driver records each compiled statement and answers with the given rows. */
function stubDb(rows: readonly Record<string, unknown>[] = []): {
  db: Kysely<DB>;
  queries: CompiledQuery[];
} {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(query);
      return { rows: rows as R[] };
    },
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
}

// Only decrypt is used: the "cipher" is the context and the plaintext joined by a bar.
const crypto = {
  decrypt: (ciphertext: string, context: string) => {
    const [ctx, plain] = ciphertext.split('|');
    if (ctx !== context) throw new Error('wrong context');
    return plain!;
  },
} as unknown as FieldCrypto;

it('[AC-B1-10j#24] 按 app_id 与去重 id 一次查询，只返回 3+4 脱敏串；无手机号为 null', async () => {
  const phone = ['138', '0000', '5678'].join('');
  const { db, queries } = stubDb([
    { id: A, phone_cipher: Buffer.from(`users.phone|${phone}`) },
    { id: B, phone_cipher: null },
  ]);
  const result = await createMaskedPhoneReader(db, crypto).maskedPhones(APP, [A, B, A]);
  expect([...result]).toEqual([
    [A, '138****5678'],
    [B, null],
  ]);
  expect(JSON.stringify([...result])).not.toContain(phone);
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toContain('"app"."users"');
  expect(queries[0]!.parameters).toEqual([APP, [A, B]]);
});

it('[AC-B1-10j#24] 空请求不查询；有手机号而无字段密钥时失败而不是返回明文或 null', async () => {
  const empty = stubDb();
  expect((await createMaskedPhoneReader(empty.db, crypto).maskedPhones(APP, [])).size).toBe(0);
  expect(empty.queries).toEqual([]);
  const { db } = stubDb([
    { id: A, phone_cipher: Buffer.from(`users.phone|${['138', '0000', '5678'].join('')}`) },
  ]);
  await expect(createMaskedPhoneReader(db, null).maskedPhones(APP, [A])).rejects.toThrow(
    'field cipher',
  );
});
