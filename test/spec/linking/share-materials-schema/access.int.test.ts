// B1-15v rule tests (规划/08 BR-ATTR-10; 编排裁定 D10-426): grants of app.share_materials. linking
// (couli_app) is the only writer and only inserts — a material is generated once per share and
// never rewritten or removed; couli_readonly reads it like every linking table; couli_payout and
// couli_maint have nothing to do with it.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  ROLES,
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
  sqlState,
  stored,
  type Harness,
  type Role,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

async function tablePrivilege(role: Role, privilege: string) {
  return (
    await sql<{ granted: boolean }>`SELECT
      has_table_privilege(${role}, ${TABLE}, ${privilege}) AS granted`.execute(h.app)
  ).rows;
}
async function columnPrivilege(role: Role, column: string, privilege: string) {
  return (
    await sql<{ granted: boolean }>`SELECT
      has_column_privilege(${role}, ${TABLE}, ${column}, ${privilege}) AS granted`.execute(h.app)
  ).rows;
}
const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const ALLOWED: Record<Role, string[]> = {
  couli_app: ['SELECT', 'INSERT'],
  couli_readonly: ['SELECT'],
  couli_payout: [],
  couli_maint: [],
};

it('[AC-B1-15v#4] couli_app 只有 SELECT、INSERT：不可改、不可删、不可清表（表级）', async () => {
  await ready(h.app);
  for (const privilege of [...PRIVILEGES, 'MAINTAIN']) {
    expect(await tablePrivilege('couli_app', privilege), privilege).toEqual([
      { granted: privilege === 'SELECT' || privilege === 'INSERT' },
    ]);
  }
});

it('[AC-B1-15v#4] 各角色逐列权限：couli_app 逐列可读可插、无一列可改；couli_readonly 只读；couli_payout、couli_maint 无权限', async () => {
  await ready(h.app);
  const names = (await columns(h.app)).map((c) => c.name);
  expect(names.sort()).toEqual(Object.keys(SHAPE).sort());
  for (const role of ROLES) {
    for (const privilege of PRIVILEGES) {
      expect(await tablePrivilege(role, privilege), `${role}/${privilege}`).toEqual([
        { granted: ALLOWED[role].includes(privilege) },
      ]);
    }
    for (const column of names) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
        expect(
          await columnPrivilege(role, column, privilege),
          `${role}/${column}/${privilege}`,
        ).toEqual([{ granted: ALLOWED[role].includes(privilege) }]);
      }
    }
  }
});

it('[AC-B1-15v#4] couli_app 写入的物料 couli_readonly 读到同一行；任何角色的改、删、清表都被拒绝，行不变', async () => {
  await ready(h.app);
  const row = await fresh(h.app);
  expect(await sqlState(insert(h.app, row))).toBe('ok');
  const before = await stored(h.app, row['link_id']);
  expect(before).toHaveLength(1);
  for (const role of ROLES) {
    const db = h.roles[role];
    if (ALLOWED[role].includes('SELECT'))
      expect(await stored(db, row['link_id']), role).toEqual(before);
    else expect(await sqlState(stored(db, row['link_id'])), role).toBe('42501');
    if (role !== 'couli_app') {
      const other = appId();
      expect(
        await sqlState(insert(db, material(other, row['link_id'] as string))),
        `${role}/INSERT`,
      ).toBe('42501');
    }
    for (const [column, value] of [
      ['share_url', 'https://s.click.taobao.com/rewritten'],
      ['tpwd', null],
      ['tpwd', '￥Rewrite1￥'],
    ] as const) {
      expect(
        await sqlState(
          sql`UPDATE app.share_materials SET ${sql.ref(column)} = ${value}
            WHERE link_id = ${row['link_id']}`.execute(db),
        ),
        `${role}/UPDATE ${column}`,
      ).toBe('42501');
    }
    expect(
      await sqlState(
        sql`DELETE FROM app.share_materials WHERE link_id = ${row['link_id']}`.execute(db),
      ),
      `${role}/DELETE`,
    ).toBe('42501');
    expect(await sqlState(sql`TRUNCATE app.share_materials`.execute(db)), `${role}/TRUNCATE`).toBe(
      '42501',
    );
    expect(await stored(h.app, row['link_id'])).toEqual(before);
  }
});

it('[AC-B1-15v#4] couli_app 重复生成同一 link 的物料只能靠冲突不写（ON CONFLICT DO NOTHING），不能改写已有物料', async () => {
  await ready(h.app);
  const row = await fresh(h.app);
  await insert(h.app, row);
  const before = await stored(h.app, row['link_id']);
  const result = await sql`INSERT INTO app.share_materials (app_id, link_id, share_url, tpwd)
    VALUES (${row['app_id']}, ${row['link_id']}, 'https://s.click.taobao.com/again', NULL)
    ON CONFLICT (link_id) DO NOTHING`.execute(h.app);
  expect(result.numAffectedRows).toBe(0n);
  expect(
    await sqlState(
      sql`INSERT INTO app.share_materials (app_id, link_id, share_url, tpwd)
        VALUES (${row['app_id']}, ${row['link_id']}, 'https://s.click.taobao.com/again', NULL)
        ON CONFLICT (link_id) DO UPDATE SET share_url = EXCLUDED.share_url`.execute(h.app),
    ),
  ).toBe('42501');
  expect(await stored(h.app, row['link_id'])).toEqual(before);
});
