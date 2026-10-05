import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createSuperVerifier } from './verify-super.ts';

const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

// RFC 6238 Appendix B 公开测试种子（ASCII "12345678901234567890"），非密钥；运行时按 RFC 4648 编成 Base32。
const RFC_KEY = rfc4648Base32(Buffer.from('12345678901234567890', 'ascii'));
function rfc4648Base32(bytes: Buffer): string {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  return (bits.match(/.{1,5}/g) ?? [])
    .map((g) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(g.padEnd(5, '0'), 2)])
    .join('');
}
const ACTIVE = 'unit-fixture-enabled';
const LOWER = '019a0000-0000-7000-8000-00000000000a';

// Real Kysely SQL compilation with an in-memory driver; no socket or database. The SELECT gets
// one super row; each UPDATE (the default PG replay store) reports `affected` rows.
async function fixture(affected: bigint[]) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    if (query.sql.startsWith('select')) {
      const row = {
        is_super: true,
        status: ACTIVE,
        totp_bound_at: new Date(0),
        totp_secret_cipher: Buffer.from('cipher', 'utf8'),
      };
      return { rows: [row] as R[] };
    }
    return { rows: [] as R[], numAffectedRows: affected.shift() ?? 0n };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  }).withSchema('app');
  handles.push(db);
  const contexts: string[] = [];
  const crypto = {
    decrypt: (_cipher: string, context: string) => {
      contexts.push(context);
      return RFC_KEY;
    },
  };
  const verifier = createSuperVerifier({
    db,
    clock: new FixedClock(new Date(59_000)), // step 1, RFC code 287082
    crypto,
    activeStatus: ACTIVE,
  });
  return { verifier, queries, contexts };
}

it('[AC-F1-06b-SUPER-UNIT#1] upper-case admin id is handled in canonical lower case end to end', async () => {
  const f = await fixture([1n]);
  const result = await f.verifier.verify({
    appId: 'couli',
    adminId: LOWER.toUpperCase(),
    code: '287082',
  });
  expect(result).toEqual({ appId: 'couli', adminId: LOWER });
  expect(f.contexts).toEqual([`admin_users.totp_secret:couli:${LOWER}`]);
  expect(f.queries).toHaveLength(2);
  expect(f.queries[0]?.parameters).toEqual(['couli', LOWER]);
  // The default replay store is the durable one: a conditional UPDATE of totp_last_step.
  expect(f.queries[1]?.sql).toMatch(/^update "app"\."admin_users" set "totp_last_step" = \$1 /);
  expect(f.queries[1]?.parameters).toEqual([1n, 'couli', LOWER, 1n]);
});

it('[AC-F1-06b-SUPER-UNIT#2] default store refusal (no row updated) is a replay and returns null', async () => {
  const f = await fixture([0n]);
  expect(await f.verifier.verify({ appId: 'couli', adminId: LOWER, code: '287082' })).toBeNull();
});
