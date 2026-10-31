// B1-05p rule tests (规划/04 §3.2; 编排裁定 D10-452 ②): grants of app.product_pools and app.pool_items.
// catalog (couli_app) is the only writer and needs all four statements: the console adds and deletes
// items and takes them on and off the shelf. couli_readonly reads; couli_payout and couli_maint have
// nothing to do with these tables. Neither table is append-only: no guard trigger.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  ITEMS,
  POOLS,
  ROLES,
  SHAPES,
  TABLES,
  TIMEOUT,
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
  update,
  type Harness,
  type Role,
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

async function tablePrivilege(role: Role, table: Table, privilege: string) {
  return (
    await sql<{ granted: boolean }>`SELECT
      has_table_privilege(${role}, ${table}, ${privilege}) AS granted`.execute(h.app)
  ).rows;
}
async function columnPrivilege(role: Role, table: Table, column: string, privilege: string) {
  return (
    await sql<{ granted: boolean }>`SELECT
      has_column_privilege(${role}, ${table}, ${column}, ${privilege}) AS granted`.execute(h.app)
  ).rows;
}
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const ALLOWED: Record<Role, string[]> = {
  couli_app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  couli_readonly: ['SELECT'],
  couli_payout: [],
  couli_maint: [],
};

it('[BR-PROD-08] 各角色表级权限：couli_app 增删改查，couli_readonly 只读，couli_payout、couli_maint 无；清表、MAINTAIN 谁都没有', async () => {
  await ready(h.app);
  for (const table of TABLES) {
    for (const role of ROLES) {
      for (const privilege of [...PRIVILEGES, 'MAINTAIN']) {
        expect(
          await tablePrivilege(role, table, privilege),
          `${table}/${role}/${privilege}`,
        ).toEqual([{ granted: ALLOWED[role].includes(privilege) }]);
      }
    }
  }
});

it('[BR-PROD-08] 各角色逐列权限与表级一致：没有只放一部分列的授权', async () => {
  await ready(h.app);
  for (const table of TABLES) {
    const names = (await columns(h.app, table)).map((c) => c.name);
    expect(names.sort()).toEqual(Object.keys(SHAPES[table]).sort());
    for (const role of ROLES) {
      for (const column of names) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          expect(
            await columnPrivilege(role, table, column, privilege),
            `${table}/${role}/${column}/${privilege}`,
          ).toEqual([{ granted: ALLOWED[role].includes(privilege) }]);
        }
      }
    }
  }
});

it('[BR-PROD-08] couli_app 能建池、改池、上下架、改条目、删条目、删空池', async () => {
  await ready(h.app);
  const { owner, pooled } = await seedPool(h.app);
  const entry = item(owner, pooled);
  expect(await sqlState(insert(h.app, ITEMS, entry))).toBe('ok');
  const renamed = { name: '改名', status: 'disabled', revision: 1n };
  expect(await sqlState(update(h.app, POOLS, poolKey(pooled), renamed))).toBe('ok');
  expect((await stored(h.app, POOLS, poolKey(pooled)))[0]).toMatchObject(renamed);
  const offline = { status: 'offline', sort: 3, invalid_reason: '联盟复核未通过' };
  expect(await sqlState(update(h.app, ITEMS, itemKey(entry), offline))).toBe('ok');
  expect((await stored(h.app, ITEMS, itemKey(entry)))[0]).toMatchObject(offline);
  expect(await sqlState(remove(h.app, ITEMS, itemKey(entry)))).toBe('ok');
  expect(await stored(h.app, ITEMS, itemKey(entry))).toEqual([]);
  expect(await sqlState(remove(h.app, POOLS, poolKey(pooled)))).toBe('ok');
  expect(await stored(h.app, POOLS, poolKey(pooled))).toEqual([]);
});

it('[BR-PROD-08] 两张表都不是只追加表：没有业务触发器', async () => {
  await ready(h.app);
  for (const table of TABLES) {
    const found = await sql<{ name: string }>`SELECT tgname::text AS name FROM pg_trigger
      WHERE tgrelid = to_regclass(${table}) AND NOT tgisinternal`.execute(h.app);
    expect(found.rows, table).toEqual([]);
  }
});

it('[BR-PROD-08] couli_readonly 读到 couli_app 写入的同一行；其余角色不可读；除 couli_app 外的写入都被拒绝，任何角色都不能清表，行不变', async () => {
  await ready(h.app);
  const { owner, pooled } = await seedPool(h.app);
  const entry = item(owner, pooled);
  await insert(h.app, ITEMS, entry);
  const targets: [Table, Row][] = [
    [POOLS, poolKey(pooled)],
    [ITEMS, itemKey(entry)],
  ];
  const before = await Promise.all(targets.map(([table, key]) => stored(h.app, table, key)));
  for (const role of ROLES) {
    const db = h.roles[role];
    for (const [index, [table, key]] of targets.entries()) {
      if (ALLOWED[role].includes('SELECT'))
        expect(await stored(db, table, key), `${role}/${table}`).toEqual(before[index]);
      else expect(await sqlState(stored(db, table, key)), `${role}/${table}`).toBe('42501');
      if (role !== 'couli_app') {
        const row = table === POOLS ? pool(owner) : item(owner, pooled);
        expect(await sqlState(insert(db, table, row)), `${role}/${table}/INSERT`).toBe('42501');
        expect(
          await sqlState(update(db, table, key, { status: 'disabled' })),
          `${role}/${table}/UPDATE`,
        ).toBe('42501');
        expect(await sqlState(remove(db, table, key)), `${role}/${table}/DELETE`).toBe('42501');
      }
      expect(
        await sqlState(sql`TRUNCATE ${sql.table(table)}`.execute(db)),
        `${role}/${table}/TRUNCATE`,
      ).toBe('42501');
      expect(await stored(h.app, table, key)).toEqual(before[index]);
    }
  }
});
