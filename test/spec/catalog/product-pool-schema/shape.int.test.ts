// B1-05p rule tests (规划/04 §3.2; 规划/08 BR-PROD-08 ③、BR-PROD-05; 编排裁定 D10-452 ②): columns, types,
// NOT NULL, defaults, primary keys, the composite foreign key, CHECKs, the read index and App
// isolation of app.product_pools and app.pool_items, on a migrated test database.
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  END_AT,
  FEN_COLUMNS,
  ITEMS,
  ITEM_SHAPE,
  ITEM_STATUSES,
  POOLS,
  POOL_SHAPE,
  POOL_STATUSES,
  QUOTED_AT,
  SHAPES,
  START_AT,
  TABLES,
  TIMEOUT,
  admin,
  close,
  columns,
  insert,
  item,
  itemKey,
  open,
  pool,
  poolKey,
  ready,
  remove,
  seedPool,
  sqlState,
  stored,
  tenant,
  update,
  type Harness,
  type Row,
  type Table,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

async function expectShape(table: Table): Promise<void> {
  await ready(h.app);
  const found = await columns(h.app, table);
  expect(found.map((c) => c.name).sort()).toEqual(Object.keys(SHAPES[table]).sort());
  for (const [name, [type, nullable, default_expr]] of Object.entries(SHAPES[table])) {
    expect(found, name).toContainEqual({ name, type, nullable, default_expr });
  }
}
async function primaryKey(table: Table) {
  return (
    await sql<{ keys: string[] }>`SELECT
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS keys
      FROM pg_constraint c WHERE c.conrelid = to_regclass(${table}) AND c.contype = 'p'`.execute(
      h.app,
    )
  ).rows;
}
interface ForeignKey {
  target: string;
  keys: string[];
  refs: string[];
  on_delete: string;
  on_update: string;
  validated: boolean;
}
async function foreignKeys(table: Table): Promise<ForeignKey[]> {
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
      WHERE c.conrelid = to_regclass(${table}) AND c.contype = 'f'`.execute(h.app)
  ).rows;
}

it('[BR-PROD-08] product_pools 列名、类型、可空性和默认值逐一匹配：revision 为 bigint 缺省 0，只有时间戳用库时钟', async () => {
  await expectShape(POOLS);
});

it('[BR-PROD-08] pool_items 列名、类型、可空性和默认值逐一匹配：金额 bigint 分，sort 为 integer 缺省 0，image、start_at、end_at、invalid_reason 可空', async () => {
  await expectShape(ITEMS);
});

it('[BR-PROD-08] 两张表的必填列都拒绝 NULL', async () => {
  await ready(h.app);
  const { owner, pooled } = await seedPool(h.app);
  for (const [name, [, nullable]] of Object.entries(POOL_SHAPE)) {
    if (!nullable)
      expect(await sqlState(insert(h.app, POOLS, pool(owner, { [name]: null }))), name).toBe(
        '23502',
      );
  }
  for (const [name, [, nullable]] of Object.entries(ITEM_SHAPE)) {
    if (!nullable)
      expect(
        await sqlState(insert(h.app, ITEMS, item(owner, pooled, { [name]: null }))),
        name,
      ).toBe('23502');
  }
  expect(await stored(h.app, ITEMS, poolKey(pooled))).toEqual([]);
});

it('[BR-PROD-08] 缺省值：revision、sort 为 0，可空列为 NULL，created_at、updated_at 由库填写', async () => {
  await ready(h.app);
  const owner = await tenant(h.app);
  const row = pool(owner);
  expect(await sqlState(insert(h.app, POOLS, row))).toBe('ok');
  const saved = await stored(h.app, POOLS, poolKey(row));
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ ...row, revision: 0n });
  expect(saved[0]?.['created_at']).toBeInstanceOf(Date);
  expect(saved[0]?.['updated_at']).toBeInstanceOf(Date);

  const entry = item(owner, row);
  expect(await sqlState(insert(h.app, ITEMS, entry))).toBe('ok');
  const entries = await stored(h.app, ITEMS, itemKey(entry));
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    ...entry,
    image: null,
    sort: 0,
    start_at: null,
    end_at: null,
    invalid_reason: null,
  });
  expect(entries[0]?.['created_at']).toBeInstanceOf(Date);
  expect(entries[0]?.['updated_at']).toBeInstanceOf(Date);
});

it('[BR-PROD-08] 取值原样往返：图片、有效期、下架原因照存，金额超出 2^53 不丢精度', async () => {
  await ready(h.app);
  const { owner, pooled } = await seedPool(h.app);
  const big = 9_007_199_254_740_993n;
  const entry = item(owner, pooled, {
    platform: 'pdd',
    product_key: 'pdd:AbC-1_x',
    raw_item_id: 'AbC-1_x',
    image: 'https://img.example.test/a.jpg',
    price_fen: big,
    coupon_fen: 0n,
    final_price_fen: big,
    quoted_at: QUOTED_AT,
    status: 'offline',
    sort: 7,
    start_at: START_AT,
    end_at: END_AT,
    invalid_reason: '联盟复核未通过',
  });
  expect(await sqlState(insert(h.app, ITEMS, entry))).toBe('ok');
  expect((await stored(h.app, ITEMS, itemKey(entry)))[0]).toMatchObject(entry);
  const row = pool(owner, { revision: big });
  expect(await sqlState(insert(h.app, POOLS, row))).toBe('ok');
  expect((await stored(h.app, POOLS, poolKey(row)))[0]).toMatchObject(row);
});

it('[BR-PROD-08] 有效期两端各自可空：只有 start_at、只有 end_at 都能写入', async () => {
  await ready(h.app);
  const { owner, pooled } = await seedPool(h.app);
  for (const values of [
    { start_at: START_AT, end_at: null },
    { start_at: null, end_at: END_AT },
    { start_at: null, end_at: null },
  ]) {
    const entry = item(owner, pooled, values);
    expect(await sqlState(insert(h.app, ITEMS, entry))).toBe('ok');
    expect((await stored(h.app, ITEMS, itemKey(entry)))[0]).toMatchObject(values);
  }
});

it('[BR-PROD-08] product_pools 主键为 (app_id, pool_id)：同一 App 同一 pool_id 第二次插入失败，原行不变', async () => {
  await ready(h.app);
  expect(await primaryKey(POOLS)).toEqual([{ keys: ['app_id', 'pool_id'] }]);
  const { owner, pooled } = await seedPool(h.app);
  const before = await stored(h.app, POOLS, poolKey(pooled));
  expect(await sqlState(insert(h.app, POOLS, pool(owner, { ...pooled, name: '另一个池' })))).toBe(
    '23505',
  );
  expect(await stored(h.app, POOLS, poolKey(pooled))).toEqual(before);
});

it('[BR-PROD-08] ③ pool_items 主键为 (app_id, pool_id, product_key)：同池同商品直接重复插入失败，池内仍只有 1 条', async () => {
  await ready(h.app);
  expect(await primaryKey(ITEMS)).toEqual([{ keys: ['app_id', 'pool_id', 'product_key'] }]);
  const { owner, pooled } = await seedPool(h.app);
  const entry = item(owner, pooled, { sort: 1 });
  expect(await sqlState(insert(h.app, ITEMS, entry))).toBe('ok');
  const before = await stored(h.app, ITEMS, poolKey(pooled));
  for (const values of [{ sort: 2 }, { raw_item_id: 'other' }, { status: 'offline' }]) {
    expect(await sqlState(insert(h.app, ITEMS, { ...entry, ...values }))).toBe('23505');
  }
  expect(await stored(h.app, ITEMS, poolKey(pooled))).toEqual(before);
});

it('[BR-PROD-08] ③ 重复入库按唯一键覆盖 sort、start_at、end_at：池内仍只有 1 条，created_at 和创建人不变', async () => {
  await ready(h.app);
  const { owner, pooled } = await seedPool(h.app);
  const entry = item(owner, pooled, { sort: 1, start_at: START_AT, end_at: END_AT });
  await insert(h.app, ITEMS, entry);
  const [before] = await stored(h.app, ITEMS, itemKey(entry));
  const again: Row = {
    ...entry,
    sort: 2,
    start_at: new Date('2032-08-01T00:00:00Z'),
    end_at: new Date('2032-08-08T00:00:00Z'),
    created_by: await admin(h.app, owner.app_id),
  };
  await sql`INSERT INTO app.pool_items
    (${sql.join(Object.keys(again).map((name) => sql.ref(name)))})
    VALUES (${sql.join(Object.values(again))})
    ON CONFLICT (app_id, pool_id, product_key) DO UPDATE SET sort = EXCLUDED.sort,
      start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at`.execute(h.app);
  const after = await stored(h.app, ITEMS, poolKey(pooled));
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({
    sort: 2,
    start_at: again['start_at'],
    end_at: again['end_at'],
    created_by: before?.['created_by'],
    created_at: before?.['created_at'],
  });
});

it('[BR-PROD-08] ③ 唯一键含 pool_id 与 product_key：同池不同商品、同一商品进不同池各成一条', async () => {
  await ready(h.app);
  const { owner, pooled } = await seedPool(h.app);
  const other = pool(owner);
  await insert(h.app, POOLS, other);
  const entry = item(owner, pooled);
  expect(await sqlState(insert(h.app, ITEMS, entry))).toBe('ok');
  expect(await sqlState(insert(h.app, ITEMS, item(owner, pooled)))).toBe('ok');
  expect(await sqlState(insert(h.app, ITEMS, { ...entry, pool_id: other['pool_id'] }))).toBe('ok');
  expect(await stored(h.app, ITEMS, poolKey(pooled))).toHaveLength(2);
  expect(await stored(h.app, ITEMS, poolKey(other))).toHaveLength(1);
});

it('[BR-PROD-08] pool_items 复合外键 (app_id, pool_id) 引用 product_pools；两张表的外键都不级联', async () => {
  await ready(h.app);
  const found = await foreignKeys(ITEMS);
  const toPools = found.filter((fk) => fk.target === POOLS);
  expect(toPools, JSON.stringify(found)).toHaveLength(1);
  expect(toPools[0]).toMatchObject({
    keys: ['app_id', 'pool_id'],
    refs: ['app_id', 'pool_id'],
    validated: true,
  });
  for (const table of TABLES) {
    for (const fk of await foreignKeys(table)) {
      // db/AGENTS.md rule 7: foreign keys stay, cascades are forbidden (NO ACTION or RESTRICT only).
      expect(['a', 'r'], `${table} ON DELETE ${JSON.stringify(fk)}`).toContain(fk.on_delete);
      expect(['a', 'r'], `${table} ON UPDATE ${JSON.stringify(fk)}`).toContain(fk.on_update);
    }
  }
});

it('[BR-PROD-08] 条目必须落在本 App 已有的池里：不存在的池、别的 App 的池都插入失败', async () => {
  await ready(h.app);
  const { owner, pooled } = await seedPool(h.app);
  const missing = item(owner, pool(owner));
  expect(await sqlState(insert(h.app, ITEMS, missing))).toBe('23503');
  expect(await stored(h.app, ITEMS, poolKey(missing))).toEqual([]);
  const other = await tenant(h.app);
  const foreign = item(other, pooled);
  expect(await sqlState(insert(h.app, ITEMS, foreign))).toBe('23503');
  expect(await stored(h.app, ITEMS, poolKey(foreign))).toEqual([]);
  expect(await stored(h.app, ITEMS, poolKey(pooled))).toEqual([]);
});

it('[BR-PROD-08] 有条目的池不能删、不能改 pool_id，条目不被连带；条目删光后池才能删', async () => {
  await ready(h.app);
  const { owner, pooled } = await seedPool(h.app);
  const entry = item(owner, pooled);
  await insert(h.app, ITEMS, entry);
  const before = await stored(h.app, ITEMS, poolKey(pooled));
  expect(await sqlState(remove(h.app, POOLS, poolKey(pooled)))).toBe('23503');
  expect(await sqlState(update(h.app, POOLS, poolKey(pooled), { pool_id: randomUUID() }))).toBe(
    '23503',
  );
  expect(await stored(h.app, ITEMS, poolKey(pooled))).toEqual(before);
  expect(await stored(h.app, POOLS, poolKey(pooled))).toHaveLength(1);
  expect(await sqlState(remove(h.app, ITEMS, itemKey(entry)))).toBe('ok');
  expect(await sqlState(remove(h.app, POOLS, poolKey(pooled)))).toBe('ok');
  expect(await stored(h.app, POOLS, poolKey(pooled))).toEqual([]);
});

it('[BR-PROD-08] product_pools 的 CHECK：name 不为空串，status 只取 active / disabled，revision 不为负', async () => {
  await ready(h.app);
  const owner = await tenant(h.app);
  expect(await sqlState(insert(h.app, POOLS, pool(owner, { name: '' })))).toBe('23514');
  for (const status of POOL_STATUSES) {
    expect(await sqlState(insert(h.app, POOLS, pool(owner, { status }))), status).toBe('ok');
  }
  for (const status of ['', 'ACTIVE', 'Active', 'online', 'offline', 'deleted']) {
    expect(await sqlState(insert(h.app, POOLS, pool(owner, { status }))), status).toBe('23514');
  }
  expect(await sqlState(insert(h.app, POOLS, pool(owner, { revision: -1n })))).toBe('23514');
  expect(await sqlState(insert(h.app, POOLS, pool(owner, { revision: 0n })))).toBe('ok');
});

it('[BR-PROD-08] pool_items 的 CHECK：product_key、raw_item_id 不为空串，status 只取 online / offline', async () => {
  await ready(h.app);
  const { owner, pooled } = await seedPool(h.app);
  for (const column of ['product_key', 'raw_item_id']) {
    expect(
      await sqlState(insert(h.app, ITEMS, item(owner, pooled, { [column]: '' }))),
      column,
    ).toBe('23514');
  }
  for (const status of ITEM_STATUSES) {
    expect(await sqlState(insert(h.app, ITEMS, item(owner, pooled, { status }))), status).toBe(
      'ok',
    );
  }
  for (const status of ['', 'ONLINE', 'Offline', 'active', 'disabled', 'pending']) {
    expect(await sqlState(insert(h.app, ITEMS, item(owner, pooled, { status }))), status).toBe(
      '23514',
    );
  }
});

it('[BR-PROD-08] pool_items 三个金额不为负，0 可写入', async () => {
  await ready(h.app);
  const { owner, pooled } = await seedPool(h.app);
  for (const column of FEN_COLUMNS) {
    expect(
      await sqlState(insert(h.app, ITEMS, item(owner, pooled, { [column]: -1n }))),
      column,
    ).toBe('23514');
    expect(
      await sqlState(insert(h.app, ITEMS, item(owner, pooled, { [column]: 0n }))),
      column,
    ).toBe('ok');
  }
});

it('[BR-PROD-08] 有效期两端都有值时 end_at 必须晚于 start_at：相等、更早都拒绝，晚 1 毫秒可写入', async () => {
  await ready(h.app);
  const { owner, pooled } = await seedPool(h.app);
  const span = (end_at: Date) => item(owner, pooled, { start_at: START_AT, end_at });
  expect(await sqlState(insert(h.app, ITEMS, span(START_AT)))).toBe('23514');
  expect(await sqlState(insert(h.app, ITEMS, span(new Date(START_AT.getTime() - 1))))).toBe(
    '23514',
  );
  expect(await sqlState(insert(h.app, ITEMS, span(new Date(START_AT.getTime() + 1))))).toBe('ok');
});

it('[BR-PROD-08] CHECK 对 UPDATE 同样生效：非法取值改不进去，行不变', async () => {
  await ready(h.app);
  const { owner, pooled } = await seedPool(h.app);
  const entry = item(owner, pooled, { start_at: START_AT, end_at: END_AT });
  await insert(h.app, ITEMS, entry);
  const pools = await stored(h.app, POOLS, poolKey(pooled));
  const items = await stored(h.app, ITEMS, itemKey(entry));
  const cases: [Table, Row, Row][] = [
    [POOLS, poolKey(pooled), { name: '' }],
    [POOLS, poolKey(pooled), { status: 'archived' }],
    [POOLS, poolKey(pooled), { revision: -1n }],
    [ITEMS, itemKey(entry), { status: 'pending' }],
    [ITEMS, itemKey(entry), { price_fen: -1n }],
    [ITEMS, itemKey(entry), { coupon_fen: -1n }],
    [ITEMS, itemKey(entry), { final_price_fen: -1n }],
    [ITEMS, itemKey(entry), { end_at: START_AT }],
    [ITEMS, itemKey(entry), { start_at: END_AT }],
    [ITEMS, itemKey(entry), { raw_item_id: '' }],
  ];
  for (const [table, key, values] of cases) {
    expect(
      await sqlState(update(h.app, table, key, values)),
      `${table}/${Object.keys(values).join()}`,
    ).toBe('23514');
  }
  expect(await stored(h.app, POOLS, poolKey(pooled))).toEqual(pools);
  expect(await stored(h.app, ITEMS, itemKey(entry))).toEqual(items);
});

it('[BR-PROD-08] 池内读路径有 btree 索引 (app_id, pool_id, sort, product_key)，全表、升序、非唯一', async () => {
  await ready(h.app);
  const found = await sql<{
    keys: string[];
    method: string;
    unique: boolean;
    valid: boolean;
    ready: boolean;
    predicate: string | null;
    directions: number[];
  }>`SELECT ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
      WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS keys,
    am.amname::text AS method, i.indisunique AS unique, i.indisvalid AS valid,
    i.indisready AS ready, pg_get_expr(i.indpred, i.indrelid) AS predicate,
    ARRAY(SELECT (v::integer & 1) FROM unnest(i.indoption) WITH ORDINALITY o(v, n) ORDER BY n)
      AS directions
    FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid JOIN pg_am am ON am.oid = idx.relam
    WHERE i.indrelid = to_regclass(${ITEMS})`.execute(h.app);
  const keys = ['app_id', 'pool_id', 'sort', 'product_key'];
  const matches = found.rows.filter((r) => r.keys.join() === keys.join());
  expect(matches, JSON.stringify(found.rows)).toHaveLength(1);
  expect(matches[0]).toEqual({
    keys,
    method: 'btree',
    unique: false,
    valid: true,
    ready: true,
    predicate: null,
    directions: [0, 0, 0, 0],
  });
});

it('[BR-PROD-08] app_id 不串：同一 pool_id、同一 product_key 在两个 App 各自独立，改删互不影响', async () => {
  await ready(h.app);
  const first = await tenant(h.app);
  const second = await tenant(h.app);
  const pool_id = randomUUID();
  const product_key = 'tb:K1';
  const poolA = pool(first, { pool_id, name: '甲 App 的池' });
  const poolB = pool(second, { pool_id, name: '乙 App 的池', status: 'disabled' });
  expect(await sqlState(insert(h.app, POOLS, poolA))).toBe('ok');
  expect(await sqlState(insert(h.app, POOLS, poolB))).toBe('ok');
  const itemA = item(first, poolA, { product_key, sort: 1 });
  const itemB = item(second, poolB, { product_key, sort: 2 });
  expect(await sqlState(insert(h.app, ITEMS, itemA))).toBe('ok');
  expect(await sqlState(insert(h.app, ITEMS, itemB))).toBe('ok');
  const poolsB = await stored(h.app, POOLS, poolKey(poolB));
  const itemsB = await stored(h.app, ITEMS, itemKey(itemB));

  await update(h.app, POOLS, poolKey(poolA), { name: '甲 App 改名' });
  await update(h.app, ITEMS, itemKey(itemA), { sort: 9, status: 'offline' });
  expect(await stored(h.app, POOLS, poolKey(poolB))).toEqual(poolsB);
  expect(await stored(h.app, ITEMS, itemKey(itemB))).toEqual(itemsB);
  expect(await sqlState(remove(h.app, ITEMS, itemKey(itemA)))).toBe('ok');
  expect(await sqlState(remove(h.app, POOLS, poolKey(poolA)))).toBe('ok');
  expect(await stored(h.app, POOLS, poolKey(poolB))).toEqual(poolsB);
  expect(await stored(h.app, ITEMS, itemKey(itemB))).toEqual(itemsB);
});
