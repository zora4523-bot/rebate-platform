// Contract addendum (code review round 3, path B), against a real PostgreSQL: see the header of
// connection-params.test.ts. With every accepted query parameter on both URLs, both handles of
// every entry read int8 and int8[] — bound as parameters, including 9007199254740993, −1 and
// −9007199254740993 — as exact BigInt values (ADR-0001 §4.2 第 3 项; AGENTS.md §4 第 1 条), the
// URL's options reach the session, and a URL with `binary=false` or `binary=true` is refused before
// any pool exists. Top-level it() only (规划/11 §4.3).
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@couli/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createDbHandles,
  loadConnectionConfig,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  ENTRIES,
  configErrorOf,
  configErrorProblems,
  describeError,
  envFor,
  memoryLogger,
  type Entry,
  type VarName,
} from './kit.ts';

const QUERY_MESSAGE =
  'query parameters may only be sslmode (disable, prefer, require, verify-ca or verify-full), sslrootcert, options, password or sslpassword, each at most once';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

const ACCEPTED_QUERY = `sslmode=disable&options=${encodeURIComponent('-c statement_timeout=7000')}`;

function envWith(entry: Entry, query: string): Record<string, string> {
  const role = entry === 'payout' ? 'couli_payout' : 'couli_app';
  return envFor(entry, {
    DATABASE_URL: `${database.urlFor(role)}?${query}`,
    DATABASE_READ_URL: `${database.urlFor('couli_readonly')}?${query}`,
    REDIS_URL: 'redis://127.0.0.1:1/0',
  });
}

async function amounts(db: Kysely<DB>): Promise<unknown> {
  const big = '9007199254740993';
  const result = await sql<{ one: unknown; list: unknown; timeout: string }>`
    SELECT ${big}::int8 AS one,
           ARRAY[${big}::int8, ${'-1'}::int8, ${'-9007199254740993'}::int8] AS list,
           current_setting('statement_timeout') AS timeout
  `.execute(db);
  return result.rows;
}

for (const entry of ENTRIES) {
  const handles = entry === 'admin' ? ['db', 'dbRead'] : ['db'];
  it(`[ADR-0001 §4.2 #3; 路径 B 契约补充] ${entry}：两个库带全部可接受的查询参数时（${handles.join('、')}）以参数绑定读 int8 与 int8[] 得到确切的 BigInt（9007199254740993、-1、-9007199254740993），options 生效；带 binary=false 或 binary=true 的连接串在建池前就被拒绝`, async () => {
    const { logger, lines } = memoryLogger(entry);
    let seen: unknown;
    try {
      const made = createDbHandles(loadConnectionConfig(entry, envWith(entry, ACCEPTED_QUERY)), {
        logger,
      });
      const read: Record<string, unknown> = { db: await amounts(made.db) };
      if (made.dbRead !== null) read['dbRead'] = await amounts(made.dbRead);
      await made.close();
      const vars: VarName[] =
        entry === 'admin' ? ['DATABASE_URL', 'DATABASE_READ_URL'] : ['DATABASE_URL'];
      const refusals = vars.flatMap((name) =>
        ['binary=false', 'binary=true'].map((query) => {
          const env = envWith(entry, ACCEPTED_QUERY);
          env[name] = `${env[name] ?? ''}&${query}`;
          const error = configErrorOf(() => loadConnectionConfig(entry, env));
          return typeof error === 'string'
            ? [error]
            : configErrorProblems(error, [`${name}: ${QUERY_MESSAGE}`]);
        }),
      );
      seen = { read, refusals, lines };
    } catch (error) {
      seen = describeError(error);
    }
    const row = [
      {
        one: 9007199254740993n,
        list: [9007199254740993n, -1n, -9007199254740993n],
        timeout: '7s',
      },
    ];
    expect(seen).toStrictEqual({
      read: Object.fromEntries(handles.map((name) => [name, row])),
      refusals: handles.flatMap(() => [[], []]),
      lines: [],
    });
  });
}
