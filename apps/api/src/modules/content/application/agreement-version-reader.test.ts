import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import type { PublicAgreementRow } from '../infra/kysely-agreement-store.ts';
import {
  AgreementVersionReader,
  kyselyAgreementVersionSource,
} from './agreement-version-reader.ts';

const SHA = 'b'.repeat(64);
const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

async function fakeDb(rows: readonly object[]) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const queries: CompiledQuery[] = [];
  connection.executeQuery = async <R>(query: CompiledQuery) => {
    queries.push(query);
    return { rows: rows as R[] };
  };
  driver.acquireConnection = async () => connection;
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  handles.push(db);
  return { db, queries };
}

const ROW: PublicAgreementRow & { readonly requires_resign: boolean } = {
  type: 'labor_agreement',
  version: 2,
  min_version: 1,
  article_id: '0199f102-00ae-7000-8000-000000000001',
  article_version: 12,
  text_sha256: SHA,
  url: 'https://cdn.example.test/legal/labor-v2.html',
  published_at: '2031-03-01T01:02:03.456000Z',
  requires_resign: false,
};

it('[AC-F1-02ze] current version: one SELECT filtered by app and type, highest version first', async () => {
  const { db, queries } = await fakeDb([ROW]);
  const data = await new AgreementVersionReader(kyselyAgreementVersionSource(db)).read(
    'app_x',
    'labor_agreement',
    null,
  );
  expect(queries).toHaveLength(1);
  const sql = queries[0]!.sql;
  expect(sql).toMatch(/^select /);
  expect(sql).toContain('"app"."agreements"');
  expect(sql).toContain('"g"."app_id" = $1');
  expect(sql).toContain('"g"."type" = $2');
  expect(sql).not.toContain('"g"."version" =');
  expect(sql).toContain('order by "g"."version" desc');
  expect(sql).toContain('limit $3');
  expect(sql).toContain(`to_char(g.published_at AT TIME ZONE 'UTC'`);
  expect(sql).not.toMatch(/requires_resign|legal_|published_by|created_at|cache/);
  expect(queries[0]!.parameters).toEqual(['app_x', 'labor_agreement', 1]);
  expect(data).toEqual({
    type: 'labor_agreement',
    version: 2,
    min_version: 1,
    article_id: ROW.article_id,
    article_version: 12,
    text_sha256: SHA,
    url: ROW.url,
    published_at: ROW.published_at,
  });
});

it('[AC-F1-02ze] a given version filters on app, type and version together', async () => {
  const { db, queries } = await fakeDb([]);
  const reader = new AgreementVersionReader(kyselyAgreementVersionSource(db));
  expect(await reader.read('app_x', 'privacy', 3)).toBeNull();
  expect(queries).toHaveLength(1);
  expect(queries[0]!.sql).toContain(
    'where "g"."app_id" = $1 and "g"."type" = $2 and "g"."version" = $3',
  );
  expect(queries[0]!.sql).not.toContain('order by');
  expect(queries[0]!.parameters).toEqual(['app_x', 'privacy', 3, 1]);
});

it('[AC-F1-02ze] no cross-request cache: every read reaches the source', async () => {
  const source = vi.fn(async () => ROW);
  const reader = new AgreementVersionReader(source);
  await reader.read('app_x', 'labor_agreement', null);
  await reader.read('app_x', 'labor_agreement', null);
  await reader.read('app_x', 'labor_agreement', 2);
  expect(source.mock.calls).toEqual([
    ['app_x', 'labor_agreement', null],
    ['app_x', 'labor_agreement', null],
    ['app_x', 'labor_agreement', 2],
  ]);
});

it('[AC-F1-02ze] without a database handle every read rejects', async () => {
  await expect(new AgreementVersionReader(null).read('app_x', 'privacy', null)).rejects.toThrow(
    /need the database/,
  );
});
