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
import { FixedClock } from '../../platform/index.ts';
import type { PublicAgreementRow } from '../infra/kysely-agreement-store.ts';
import {
  PublicAgreementReader,
  createAgreementReader,
  kyselyPublicAgreementSource,
} from './agreement-reader.ts';

const START = '2031-05-06T07:08:09.000Z';
const SHA = 'a'.repeat(64);
const handles: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((db) => db.destroy()));
});

async function fakeDb(rows: readonly Record<string, unknown>[]) {
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

it('[AC-F1-02n#u3] 端口每次一条按 version 倒序 LIMIT 1 的查询，映射六字段', async () => {
  const at = new Date('2031-01-02T03:04:05.678Z');
  const { db, queries } = await fakeDb([
    { version: 4, min_version: 3, url: 'https://x.test/a', text_sha256: SHA, published_at: at },
  ]);
  const reader = createAgreementReader({ db });
  const expected = {
    version: 4,
    min_version: 3,
    resign_from_version: 3,
    text_url: 'https://x.test/a',
    text_sha256: SHA,
    published_at: at,
  };
  expect(await reader.currentAgreement('app_a', 'labor_agreement')).toEqual(expected);
  expect(await reader.currentAgreement('app_a', 'labor_agreement')).toEqual(expected);
  expect(queries).toHaveLength(2);
  expect(queries[0]!.sql).toMatch(/"app"\."agreements"/);
  expect(queries[0]!.sql).toMatch(/order by "version" desc limit \$3$/);
  expect(queries[0]!.parameters).toEqual(['app_a', 'labor_agreement', 1]);
});

it('[AC-F1-02n#u4] 端口无行返回 null', async () => {
  const { db } = await fakeDb([]);
  expect(await createAgreementReader({ db }).currentAgreement('app_a', 'privacy')).toBeNull();
});

it('[AC-F1-02n#u5] 公共读只查 privacy 与 agreement，每类取最大 version', async () => {
  const { db, queries } = await fakeDb([]);
  expect(await kyselyPublicAgreementSource(db)('app_b')).toEqual([]);
  expect(queries[0]!.sql).toMatch(/select distinct on \("g"\."type"\)/);
  expect(queries[0]!.sql).toMatch(/order by "g"\."type", "g"\."version" desc$/);
  expect(queries[0]!.parameters).toEqual(['app_b', 'privacy', 'agreement']);
});

function row(type: string, version: number): PublicAgreementRow {
  return {
    type,
    version,
    min_version: 1,
    article_id: '0199f102-0000-7000-8000-000000000001',
    article_version: version,
    text_sha256: SHA,
    url: `https://x.test/${type}/${version}`,
    published_at: '2031-01-01T00:00:00.000000Z',
  };
}

it('[AC-F1-02n#u6] GET 读按 app_id 缓存 60 秒，忽略劳务协议，缺类为 null', async () => {
  const clock = new FixedClock(START);
  let version = 1;
  const source = vi.fn(async (appId: string) =>
    appId === 'a' ? [row('privacy', version), row('labor_agreement', 9)] : [],
  );
  const reader = new PublicAgreementReader(source, clock);
  const first = await reader.read('a');
  expect(first.agreement).toBeNull();
  expect(first.privacy).toMatchObject({ type: 'privacy', version: 1 });
  expect(Object.keys(first)).toEqual(['privacy', 'agreement']);
  expect(await reader.read('b')).toEqual({ privacy: null, agreement: null });
  version = 2;
  clock.advanceMs(59_999);
  expect((await reader.read('a')).privacy?.version).toBe(1);
  clock.advanceMs(1);
  expect((await reader.read('a')).privacy?.version).toBe(2);
  expect(source).toHaveBeenCalledTimes(3);
});

it('[AC-F1-02n#u7] 无数据库时 GET 读拒绝', async () => {
  const reader = new PublicAgreementReader(null, new FixedClock(START));
  await expect(reader.read('a')).rejects.toThrow(/need the database/);
});
