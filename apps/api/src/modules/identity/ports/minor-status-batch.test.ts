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
import { createMinorStatusBatchReader } from './minor-status-batch.ts';

const APP = 'couli';
const A = '019a0000-0000-7000-8000-000000000001';
const B = '019a0000-0000-7000-8000-000000000002';
const C = '019a0000-0000-7000-8000-000000000003';
/** 2026-10-30 12:00 +08:00. */
const AT = new Date('2026-10-30T04:00:00.000Z');

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

/** A reversible fake cipher: `<context>|<plaintext>`; any other context fails to decrypt. */
function fakeCrypto(): { crypto: FieldCrypto; contexts: string[] } {
  const contexts: string[] = [];
  const crypto = {
    currentKeyVersion: 1,
    encrypt: (plaintext: string, context: string) => `${context}|${plaintext}`,
    decrypt: (ciphertext: string, context: string) => {
      contexts.push(context);
      const prefix = `${context}|`;
      if (!ciphertext.startsWith(prefix)) throw new Error(`cannot decrypt ${ciphertext}`);
      return ciphertext.slice(prefix.length);
    },
  } as unknown as FieldCrypto;
  return { crypto, contexts };
}

function cipher(birth: string, context = 'realname.birth_date'): Buffer {
  return Buffer.from(`${context}|${birth}`);
}

it('[AC-B1-03zc] empty request runs no query and decrypts nothing', async () => {
  const fake = fakeCrypto();
  const caller = stubDb();
  const reader = createMinorStatusBatchReader({ crypto: fake.crypto });
  await expect(reader.read(caller.db, { appId: APP, userIds: [], at: AT })).resolves.toEqual(
    new Set(),
  );
  expect(caller.queries).toEqual([]);
  expect(fake.contexts).toEqual([]);
});

it('[AC-B1-03zc] one users join realname select on the caller executor, deduplicated IDs, no lock', async () => {
  const caller = stubDb();
  const reader = createMinorStatusBatchReader({ crypto: fakeCrypto().crypto });
  await reader.read(caller.db, { appId: APP, userIds: [B, A, B], at: AT });
  expect(caller.queries).toHaveLength(1);
  expect(caller.queries[0]!.sql).toBe(
    'select "app"."users"."id", "app"."realname"."birth_date_cipher" from "app"."users"' +
      ' inner join "app"."realname" on "app"."realname"."user_id" = "app"."users"."id"' +
      ' and "app"."realname"."app_id" = "app"."users"."app_id"' +
      ' where "app"."users"."app_id" = $1 and "app"."users"."id" = ANY($2)' +
      ' and "app"."realname"."status" = $3 and "app"."realname"."verified_at" <= $4',
  );
  expect(caller.queries[0]!.parameters).toEqual([APP, [B, A], 'verified', AT]);
});

it('[AC-B1-03zc] only users under 18 at `at` are returned, decrypting the birth date domain only', async () => {
  const fake = fakeCrypto();
  const caller = stubDb([
    { id: A, birth_date_cipher: cipher('2010-05-15') },
    { id: B, birth_date_cipher: cipher('1996-05-15') },
    { id: C, birth_date_cipher: cipher('2008-10-30') },
  ]);
  const reader = createMinorStatusBatchReader({ crypto: fake.crypto });
  // C turns 18 at 2026-10-31 00:00 +08:00 = 2026-10-30T16:00Z.
  await expect(reader.read(caller.db, { appId: APP, userIds: [A, B, C], at: AT })).resolves.toEqual(
    new Set([A, C]),
  );
  await expect(
    reader.read(caller.db, {
      appId: APP,
      userIds: [A, B, C],
      at: new Date('2026-10-30T16:00:00.000Z'),
    }),
  ).resolves.toEqual(new Set([A]));
  expect(new Set(fake.contexts)).toEqual(new Set(['realname.birth_date']));
});

it.each([
  ['empty cipher', Buffer.alloc(0)],
  ['null cipher', null],
  ['undecryptable', cipher('2010-05-15', 'realname.id_no')],
  ['invalid date', cipher('2010-02-30')],
  ['not a date', cipher('synthetic-birth')],
])(
  '[AC-B1-03zc] a broken verified record (%s) rejects without leaking the birth date',
  async (_label, birthCipher) => {
    const caller = stubDb([
      { id: A, birth_date_cipher: cipher('2010-05-15') },
      { id: B, birth_date_cipher: birthCipher },
    ]);
    const reader = createMinorStatusBatchReader({ crypto: fakeCrypto().crypto });
    const error = await reader.read(caller.db, { appId: APP, userIds: [A, B], at: AT }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'identity: unreadable birth date on a verified realname record',
    );
    expect((error as Error).cause).toBeUndefined();
    expect(String((error as Error).stack)).not.toContain('2010');
  },
);

it('[AC-B1-03zc] an invalid instant is refused before any query', async () => {
  const caller = stubDb();
  const reader = createMinorStatusBatchReader({ crypto: fakeCrypto().crypto });
  await expect(
    reader.read(caller.db, { appId: APP, userIds: [A], at: new Date(Number.NaN) }),
  ).rejects.toThrow('identity: invalid instant for the minor-status read');
  expect(caller.queries).toEqual([]);
});
