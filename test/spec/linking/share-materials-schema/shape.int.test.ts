// B1-15v rule tests (规划/08 BR-ATTR-10; 编排裁定 D10-426): columns, types, NOT NULL, empty-string
// CHECKs, primary key and the foreign key to app.links of app.share_materials, on a migrated test
// database.
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  SHAPE,
  TABLE,
  TIMEOUT,
  appId,
  close,
  columns,
  fresh,
  insert,
  material,
  open,
  ready,
  seedLink,
  sqlState,
  stored,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

interface ForeignKey {
  target: string;
  keys: string[];
  refs: string[];
  on_delete: string;
  on_update: string;
  validated: boolean;
}
async function foreignKeys(): Promise<ForeignKey[]> {
  return (
    await sql<ForeignKey>`SELECT n.nspname::text || '.' || r.relname::text AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS keys,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord) AS refs,
      c.confdeltype::text AS on_delete, c.confupdtype::text AS on_update,
      c.convalidated AS validated
      FROM pg_constraint c JOIN pg_class r ON r.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.conrelid = to_regclass(${TABLE}) AND c.contype = 'f'`.execute(h.app)
  ).rows;
}

it('[AC-B1-15v#1] share_materials 列名、类型、可空性和默认值逐一匹配：只有 app_id、link_id、share_url、tpwd、created_at', async () => {
  await ready(h.app);
  const found = await columns(h.app);
  expect(found.map((c) => c.name).sort()).toEqual(Object.keys(SHAPE).sort());
  for (const [name, [type, nullable, default_expr]] of Object.entries(SHAPE)) {
    expect(found, name).toContainEqual({ name, type, nullable, default_expr });
  }
});

it('[AC-B1-15v#1] 必填列拒绝 NULL；取值原样写入，created_at 不传时由库填写', async () => {
  await ready(h.app);
  const row = await fresh(h.app);
  for (const [name, [, nullable]] of Object.entries(SHAPE)) {
    if (!nullable)
      expect(await sqlState(insert(h.app, { ...row, [name]: null })), name).toBe('23502');
  }
  expect(await sqlState(insert(h.app, row))).toBe('ok');
  const saved = await stored(h.app, row['link_id']);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject(row);
  expect(saved[0]?.['created_at']).toBeInstanceOf(Date);
});

it('[AC-B1-15v#1] tpwd 可空：没有口令的平台只存短链', async () => {
  await ready(h.app);
  const app = appId();
  for (const platform of ['jd', 'pdd', 'taobao']) {
    const row = material(app, await seedLink(h.app, app, platform), { tpwd: null });
    expect(await sqlState(insert(h.app, row)), platform).toBe('ok');
    expect((await stored(h.app, row['link_id']))[0], platform).toMatchObject({ tpwd: null });
  }
});

it('[AC-B1-15v#2] 主键为 link_id：同一 link 的物料只生成一次，第二次插入因主键冲突失败', async () => {
  await ready(h.app);
  const pk = await sql<{ keys: string[] }>`SELECT
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS keys
    FROM pg_constraint c WHERE c.conrelid = to_regclass(${TABLE}) AND c.contype = 'p'`.execute(
    h.app,
  );
  expect(pk.rows).toEqual([{ keys: ['link_id'] }]);
  const row = await fresh(h.app);
  expect(await sqlState(insert(h.app, row))).toBe('ok');
  const before = await stored(h.app, row['link_id']);
  const again = { ...row, share_url: 'https://s.click.taobao.com/second', tpwd: '￥Second99￥' };
  expect(await sqlState(insert(h.app, again))).toBe('23505');
  expect(await sqlState(insert(h.app, { ...again, tpwd: null }))).toBe('23505');
  expect(await stored(h.app, row['link_id'])).toEqual(before);
});

it('[AC-B1-15v#2] link_id 外键引用 app.links(link_id)，不级联：不存在的 link 插入失败', async () => {
  await ready(h.app);
  const found = await foreignKeys();
  const toLinks = found.filter((fk) => fk.target === 'app.links' && fk.keys.includes('link_id'));
  expect(toLinks, JSON.stringify(found)).toHaveLength(1);
  for (const fk of toLinks) {
    expect(fk.refs[fk.keys.indexOf('link_id')], JSON.stringify(fk)).toBe('link_id');
    expect(fk.validated).toBe(true);
    // db/AGENTS.md rule 7: foreign keys stay, cascades are forbidden (NO ACTION or RESTRICT only).
    expect(['a', 'r'], 'ON DELETE').toContain(fk.on_delete);
    expect(['a', 'r'], 'ON UPDATE').toContain(fk.on_update);
  }
  const app = appId();
  const missing = material(app, randomUUID());
  expect(await sqlState(insert(h.app, missing))).toBe('23503');
  expect(await stored(h.app, missing['link_id'])).toEqual([]);
  expect(await sqlState(insert(h.app, material(app, await seedLink(h.app, app))))).toBe('ok');
});

it('[AC-B1-15v#3] share_url 不得为空串；tpwd 为 NULL 或非空串', async () => {
  await ready(h.app);
  expect(await sqlState(insert(h.app, await fresh(h.app, { share_url: '' })))).toBe('23514');
  expect(await sqlState(insert(h.app, await fresh(h.app, { tpwd: '' })))).toBe('23514');
  expect(await sqlState(insert(h.app, await fresh(h.app, { tpwd: null })))).toBe('ok');
  expect(await sqlState(insert(h.app, await fresh(h.app)))).toBe('ok');
});

it('[AC-B1-15v#3] 短链与口令原样往返：口令符号、大小写与长短链不被改写', async () => {
  await ready(h.app);
  for (const values of [
    { share_url: 'https://s.click.taobao.com/t?e=m%3D2%26s%3DAbC', tpwd: '(AbCdEfGh123)' },
    { share_url: 'https://u.jd.com/AbCdE1', tpwd: null },
    { share_url: `https://p.pinduoduo.com/${'x'.repeat(800)}`, tpwd: null },
    { share_url: 'https://m.tb.cn/h.5abcdef', tpwd: '￥Ab1Cd2Ef3Gh￥ https://m.tb.cn/h.5abcdef' },
  ]) {
    const row = await fresh(h.app, values);
    expect(await sqlState(insert(h.app, row)), values.share_url).toBe('ok');
    expect((await stored(h.app, row['link_id']))[0], values.share_url).toMatchObject(values);
  }
});
