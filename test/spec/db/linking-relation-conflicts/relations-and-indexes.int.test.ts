import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { connect, foreignKeys, newAccount, newUser, sqlState } from '../linking-bindings/kit.ts';
import { TABLE, TIMEOUT, accepted, fixture, insert, requireShape, stored } from './kit.ts';

let database: TestDatabase;
let app: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = createDb({ connectionString: database.urlFor('couli_app'), max: 2 });
  connect(app);
}, TIMEOUT);

afterAll(async () => {
  if (app) await destroyDb(app);
  if (database) await database.drop();
}, TIMEOUT);

it(
  '[AC-B1-06y#10] validated foreign keys retain same-app users and accounts without cascades',
  async () => {
    await requireShape();
    const keys = await foreignKeys(TABLE);
    for (const [target, source] of [
      ['users', 'user_id'],
      ['union_accounts', 'union_account_id'],
    ]) {
      expect(
        keys.some((key) => {
          const pairs = key.source.map((name, index) => `${name}:${key.referenced[index]}`);
          return (
            key.target === target &&
            pairs.includes('app_id:app_id') &&
            pairs.includes(`${source}:id`)
          );
        }),
        target,
      ).toBe(true);
    }
    for (const key of keys) {
      expect(key.validated, key.target).toBe(true);
      expect(['a', 'r'], `${key.target} ON DELETE`).toContain(key.on_delete);
      expect(['a', 'r'], `${key.target} ON UPDATE`).toContain(key.on_update);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#11] missing users and accounts are rejected by foreign keys',
  async () => {
    await requireShape();
    const row = await fixture();
    for (const column of ['user_id', 'union_account_id']) {
      expect(
        await sqlState(
          insert(app, {
            ...row,
            id: randomUUID(),
            [column]: randomUUID(),
          }),
        ),
        column,
      ).toBe('23503');
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#12] existing users and accounts from another app cannot be referenced',
  async () => {
    await requireShape();
    const own = await accepted(app);
    const other = await accepted(app, { app_id: 'couli_fixture_other' });
    for (const [base, foreign] of [
      [own, other],
      [other, own],
    ]) {
      expect(base).toBeDefined();
      expect(foreign).toBeDefined();
      for (const column of ['user_id', 'union_account_id'] as const) {
        expect(
          await sqlState(
            insert(app, {
              ...base!,
              id: randomUUID(),
              [column]: foreign![column],
            }),
          ),
          `${base!.app_id} ${column}`,
        ).toBe('23503');
      }
    }
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#13] valid unrelated users and accounts in the same app can log separate conflicts',
  async () => {
    await requireShape();
    const row = await accepted(app);
    const second = {
      ...row,
      id: randomUUID(),
      user_id: await newUser(),
      union_account_id: await newAccount(),
    };
    expect(await sqlState(insert(app, second))).toBe('no error');
    expect(await stored(app, second.id)).toEqual([expect.objectContaining(second)]);
    // A log permits repeated attempts, even for the same subject, kind and timestamp.
    const repeated = { ...row, id: randomUUID() };
    expect(await sqlState(insert(app, repeated))).toBe('no error');
    expect(await stored(app, repeated.id)).toEqual([expect.objectContaining(repeated)]);
  },
  TIMEOUT,
);

async function indexes() {
  const result = await sql<{ name: string; keys: string[]; predicate: string | null }>`
    SELECT ci.relname AS name,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
        WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS keys,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid
    WHERE i.indrelid = to_regclass('app.union_binding_conflicts')
      AND i.indisvalid AND i.indisready AND i.indexprs IS NULL
  `.execute(app);
  return result.rows;
}

it(
  '[AC-B1-06y#14] current-conflict lookup has the specified unresolved-only index',
  async () => {
    await requireShape();
    expect(
      (await indexes()).some(
        (index) =>
          index.keys.join(',') === 'app_id,user_id,platform' &&
          index.predicate?.replace(/[\s()"]/g, '').toLowerCase() === 'resolved_atisnull',
      ),
    ).toBe(true);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06y#15] historical lookup has a nonpartial index including occurrence time',
  async () => {
    await requireShape();
    expect(
      (await indexes()).some(
        (index) =>
          index.keys.join(',') === 'app_id,user_id,platform,occurred_at' &&
          index.predicate === null,
      ),
    ).toBe(true);
  },
  TIMEOUT,
);
