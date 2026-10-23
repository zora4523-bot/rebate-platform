// B1-22i / BR-ATTR-02 / D10-221 A：唯一性不含联盟账号；只限制 active。
// 连接仅取自集成 globalSetup 的一次性数据库，始终使用 couli_app。
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AT, insertRow, pidScenes, sqlState } from '../kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
}, 180_000);

afterAll(async () => {
  if (db) await destroyDb(db);
  if (database) await database.drop();
}, 60_000);

type Platform = 'taobao' | 'jd' | 'pdd';

async function pid(appId: string, platform: Platform, values: Record<string, unknown> = {}) {
  return insertRow(db, 'union_pids', {
    app_id: appId,
    platform,
    site_id: platform === 'taobao' ? 'synthetic-site' : null,
    status: 'pending',
    hjy_ignore_confirmed_at: AT,
    hjy_ignore_evidence_path: 'fixtures/hjy/confirmed.png',
    created_at: AT,
    updated_at: AT,
    ...values,
  });
}

async function stored(row: Record<string, unknown>) {
  return (
    await sql<Record<string, unknown>>`
      SELECT * FROM app.union_pids WHERE app_id = ${row['app_id']} AND id = ${row['id']}
    `.execute(db)
  ).rows;
}

function activate(connection: Kysely<DB>, row: Record<string, unknown>) {
  return sql`
    UPDATE app.union_pids SET status = 'active'
    WHERE app_id = ${row['app_id']} AND id = ${row['id']}
    RETURNING id
  `.execute(connection);
}

it('[AC-B1-22i#1] 恰有一个有效的 active 部分唯一索引，键仅为 app/platform/pid_scene', async () => {
  const indexes = await sql<{
    name: string;
    keys: string[];
    predicate: string | null;
    definition: string;
    valid: boolean;
    ready: boolean;
    unique: boolean;
  }>`
    SELECT c.relname AS name, i.indisunique AS unique,
      i.indisvalid AS valid, i.indisready AS ready,
      ARRAY(SELECT pg_get_indexdef(i.indexrelid, key_number, true)
        FROM generate_series(1, i.indnkeyatts) AS key_number ORDER BY key_number) AS keys,
      pg_get_expr(i.indpred, i.indrelid) AS predicate,
      pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'app.union_pids'::regclass
  `.execute(db);
  const matching = indexes.rows.filter(
    (index) =>
      index.unique &&
      JSON.stringify(index.keys) === JSON.stringify(['app_id', 'platform', 'pid_scene']) &&
      index.predicate?.replaceAll(/::text|[()\s"]/g, '') === "status='active'",
  );
  expect(matching).toHaveLength(1);
  expect(matching[0]).toMatchObject({ valid: true, ready: true });
  expect(matching[0]!.name).toMatch(/^union_pids_/);
  expect(matching[0]!.definition).toMatch(/^CREATE UNIQUE INDEX /);
});

for (const platform of ['taobao', 'jd', 'pdd'] as const) {
  for (const sameAccount of [true, false]) {
    for (const operation of ['insert', 'update'] as const) {
      it(`[AC-B1-22i#2] ${platform}/${sameAccount ? '同' : '跨'}账号/${operation}: 第二条同场景 active 返回 23505 且不改已有行`, async () => {
        const appId = `pid-unique-${randomUUID()}`;
        const existing = await pid(appId, platform, { status: 'active' });
        const target = await pid(appId, platform, {
          ...(sameAccount ? { union_account_id: existing['union_account_id'] } : {}),
          // 淘宝媒体位不同也不能绕过场景唯一性。
          ...(platform === 'taobao' ? { site_id: 'another-site' } : {}),
        });
        expect(target['union_account_id'] === existing['union_account_id']).toBe(sameAccount);
        const code = await sqlState(
          operation === 'update'
            ? activate(db, target)
            : pid(appId, platform, {
                union_account_id: target['union_account_id'],
                site_id: target['site_id'],
                status: 'active',
              }),
        );
        expect(code).toBe('23505');
        expect(await stored(existing)).toEqual([existing]);
        expect(await stored(target)).toEqual([target]);
        const count = await sql<{ count: number }>`
          SELECT count(*)::integer AS count FROM app.union_pids WHERE app_id = ${appId}
        `.execute(db);
        expect(count.rows).toEqual([{ count: 2 }]);
      });
    }
  }

  it(`[AC-B1-22i#3] ${platform}: 多条 pending/retired 与不同场景、平台、app 可共存，退休后可换位`, async () => {
    const appId = `pid-boundary-${randomUUID()}`;
    for (const scene of pidScenes()) {
      const existing = await pid(appId, platform, { pid_scene: scene, status: 'active' });
      for (const status of ['pending', 'retired']) {
        for (let i = 0; i < 2; i += 1) {
          const inactive = await pid(appId, platform, {
            pid_scene: scene,
            status,
            union_account_id: existing['union_account_id'],
          });
          expect(inactive['status']).toBe(status);
        }
      }
      for (const otherPlatform of ['taobao', 'jd', 'pdd'] as const) {
        if (otherPlatform === platform) continue;
        expect(
          (await pid(appId, otherPlatform, { pid_scene: scene, status: 'active' }))['status'],
        ).toBe('active');
      }
      const foreign = await pid(`${appId}-foreign`, platform, {
        pid_scene: scene,
        status: 'active',
      });
      expect(foreign['status']).toBe('active');
      const replacement = await pid(appId, platform, { pid_scene: scene });
      await sql`UPDATE app.union_pids SET status = 'retired' WHERE id = ${existing['id']}`.execute(
        db,
      );
      expect(await sqlState(activate(db, replacement))).toBe('no error');
      expect((await stored(existing))[0]?.['status']).toBe('retired');
      expect((await stored(replacement))[0]?.['status']).toBe('active');
      // 正向边界之后仍须拒绝第二条；旧实现也必须在本用例中先红。
      expect(await sqlState(pid(appId, platform, { pid_scene: scene, status: 'active' }))).toBe(
        '23505',
      );
    }
  });

  for (const sameAccount of [true, false]) {
    it(`[AC-B1-22i#4] ${platform}/${sameAccount ? '同' : '跨'}账号: 并发事务启用同场景不同推广位只能提交一个`, async () => {
      const appId = `pid-race-${randomUUID()}`;
      const first = await pid(appId, platform);
      const second = await pid(appId, platform, {
        ...(sameAccount ? { union_account_id: first['union_account_id'] } : {}),
      });
      const start = Promise.withResolvers<void>();
      let ready = 0;
      // 两个独立事务均取得连接后才同时尝试 UPDATE；不拿应用锁，也不靠延时制造竞争。
      const results = await Promise.all(
        [first, second].map((row) =>
          sqlState(
            db.transaction().execute(async (trx) => {
              await sql`SET LOCAL statement_timeout = '10s'`.execute(trx);
              ready += 1;
              if (ready === 2) start.resolve();
              await start.promise;
              const updated = await activate(trx, row);
              expect(updated.rows).toHaveLength(1);
            }),
          ),
        ),
      );
      expect([...results].sort()).toEqual(['23505', 'no error']);
      for (const [i, row] of [first, second].entries()) {
        expect(await stored(row)).toEqual([
          { ...row, status: results[i] === 'no error' ? 'active' : 'pending' },
        ]);
      }
    }, 30_000);
  }
}
