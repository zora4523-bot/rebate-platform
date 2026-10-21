import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { expect, it } from 'vitest';
import { createOrderSourceReader } from '../../../../apps/api/src/modules/linking/index.ts';
import { built, type CodeReader } from './kit.ts';

function fixture() {
  const queries: { sql: string; parameters: readonly unknown[] }[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => void queries.push({ sql: event.query.sql, parameters: event.query.parameters }),
  });
  return { db, queries };
}

it('[AC-B1-08s#13] 公开读口装配零查询、每次有效短码仅一条 SELECT，无命中返回 null、不缓存', async () => {
  const f = fixture();
  try {
    const reader = (await built(() => createOrderSourceReader(f.db))) as unknown as CodeReader;
    expect(typeof reader.linkByCode).toBe('function');
    expect(f.queries).toEqual([]);
    for (const lk of ['a1b2c3', '0', 'z'.repeat(16), 'a1b2c3']) {
      expect(
        await built(() => reader.linkByCode({ appId: 'app-a', platform: 'pdd', lk })),
      ).toBeNull();
    }
    expect(f.queries).toHaveLength(4);
    for (const query of f.queries) {
      expect(query.sql).toMatch(/^select .* from "app"\."links" where /);
      const where = query.sql.split(' where ')[1]!;
      for (const column of ['app_id', 'platform', 'lk']) expect(where).toContain(`"${column}" = $`);
      expect(where).not.toContain('user_id');
      expect(query.parameters).toEqual(expect.arrayContaining(['app-a', 'pdd']));
    }
    expect(f.queries.map((q) => q.parameters.find((p) => p !== 'app-a' && p !== 'pdd'))).toEqual([
      'a1b2c3',
      '0',
      'z'.repeat(16),
      'a1b2c3',
    ]);
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-08s#14] 非法短码直接 null、不发 SQL，也不执行注入文本', async () => {
  const f = fixture();
  try {
    const reader = (await built(() => createOrderSourceReader(f.db))) as unknown as CodeReader;
    expect(typeof reader.linkByCode).toBe('function');
    for (const lk of ['', 'ABC123', 'a'.repeat(17), 'a_b', 'a\n', "a' OR '1'='1", '中文']) {
      expect(
        await built(() => reader.linkByCode({ appId: 'app-a', platform: 'jd', lk })),
      ).toBeNull();
    }
    expect(f.queries).toEqual([]);
  } finally {
    await f.db.destroy();
  }
});
