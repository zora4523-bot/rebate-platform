// B2-05m rule tests (规划/08 BR-WDR-26; D10-467 ④、D10-475 ②(c); db/AGENTS.md rule 4): grants on
// app.withdrawals.review_overdue_at, after 0075's column ownership. Only couli_app — the worker that
// runs the payout-overdue queue, in the same process as payout-review — may UPDATE it; its other
// column-level UPDATE grants stay as 0075 left them. couli_payout and couli_readonly read it (their
// table-level SELECT) and may not write it; couli_maint has nothing. Writing it alone touches no other
// column: row_version / updated_at are the task's choice, the schema does not force them.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  APP_UPDATE,
  COLUMN,
  JUDGED_AT,
  PAYOUT_UPDATE,
  ROLES,
  SHAPE,
  TIMEOUT,
  close,
  open,
  ready,
  seed,
  sqlState,
  stored,
  update,
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
      has_table_privilege(${role}, 'app.withdrawals', ${privilege}) AS granted`.execute(h.app)
  ).rows;
}
async function columnPrivilege(role: Role, column: string, privilege: string) {
  return (
    await sql<{ granted: boolean }>`SELECT
      has_column_privilege(${role}, 'app.withdrawals', ${column}, ${privilege}) AS granted`.execute(
      h.app,
    )
  ).rows;
}
// Column-level UPDATE each role holds after B2-05m, over the columns main has plus the new one.
const UPDATE_AFTER: Record<Role, string[]> = {
  couli_app: [...APP_UPDATE, COLUMN],
  couli_payout: PAYOUT_UPDATE,
  couli_readonly: [],
  couli_maint: [],
};
const TABLE_LEVEL: Record<Role, string[]> = {
  couli_app: ['SELECT', 'INSERT'],
  couli_payout: ['SELECT'],
  couli_readonly: ['SELECT'],
  couli_maint: [],
};
const NEVER = ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];

it('[BR-WDR-26] review_overdue_at 列级 UPDATE 只授给 couli_app；couli_payout / couli_readonly 只读，couli_maint 无权', async () => {
  await ready(h.app);
  expect(await columnPrivilege('couli_app', COLUMN, 'UPDATE')).toEqual([{ granted: true }]);
  for (const role of ['couli_payout', 'couli_readonly', 'couli_maint'] as const) {
    expect(await columnPrivilege(role, COLUMN, 'UPDATE'), `${role}/UPDATE`).toEqual([
      { granted: false },
    ]);
    expect(await columnPrivilege(role, COLUMN, 'INSERT'), `${role}/INSERT`).toEqual([
      { granted: false },
    ]);
    expect(await columnPrivilege(role, COLUMN, 'SELECT'), `${role}/SELECT`).toEqual([
      { granted: role !== 'couli_maint' },
    ]);
  }
  for (const role of ROLES) {
    expect(await columnPrivilege(role, COLUMN, 'REFERENCES'), `${role}/REFERENCES`).toEqual([
      { granted: false },
    ]);
  }
  // couli_app 读、插入该列来自表级 SELECT / INSERT（插入可不带该列，见 shape）。
  for (const privilege of ['SELECT', 'INSERT']) {
    expect(await columnPrivilege('couli_app', COLUMN, privilege), privilege).toEqual([
      { granted: true },
    ]);
  }
});

it('[BR-WDR-26] 各角色列级 UPDATE 清单 = 0075 原样（couli_app 只多 review_overdue_at），表级权限不变', async () => {
  await ready(h.app);
  for (const role of ROLES) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', ...NEVER]) {
      expect(await tablePrivilege(role, privilege), `${role}/${privilege}`).toEqual([
        { granted: TABLE_LEVEL[role].includes(privilege) },
      ]);
    }
    for (const column of Object.keys(SHAPE)) {
      expect(await columnPrivilege(role, column, 'UPDATE'), `${role}/${column}/UPDATE`).toEqual([
        { granted: UPDATE_AFTER[role].includes(column) },
      ]);
    }
  }
});

it('[BR-WDR-26] couli_app 写入判定时刻后 couli_payout / couli_readonly 读到同一值；它们与 couli_maint 改该列被拒（42501），值不变', async () => {
  await ready(h.app);
  const row = await seed(h.app);
  expect(await sqlState(update(h.app, row['id'], { [COLUMN]: JUDGED_AT }))).toBe('ok');
  const before = await stored(h.app, row['id']);
  expect(before).toHaveLength(1);
  expect((before[0]?.[COLUMN] as Date).getTime()).toBe(JUDGED_AT.getTime());
  for (const role of ['couli_payout', 'couli_readonly'] as const) {
    expect(await stored(h.roles[role], row['id']), role).toEqual(before);
  }
  expect(await sqlState(stored(h.roles.couli_maint, row['id'])), 'couli_maint/SELECT').toBe(
    '42501',
  );
  const later = new Date(JUDGED_AT.getTime() + 5 * 60_000);
  for (const role of ['couli_payout', 'couli_readonly', 'couli_maint'] as const) {
    for (const value of [later, null]) {
      expect(
        await sqlState(update(h.roles[role], row['id'], { [COLUMN]: value })),
        `${role}/UPDATE ${String(value)}`,
      ).toBe('42501');
    }
    expect(await stored(h.app, row['id'])).toEqual(before);
  }
});

it('[BR-WDR-26] couli_payout 不能借既有列级 UPDATE 顺带写 review_overdue_at（同一语句含 row_version 也被拒）', async () => {
  await ready(h.app);
  const row = await seed(h.app);
  const before = await stored(h.app, row['id']);
  expect(
    await sqlState(
      update(h.roles.couli_payout, row['id'], { row_version: 1, [COLUMN]: JUDGED_AT }),
    ),
  ).toBe('42501');
  expect(await stored(h.app, row['id'])).toEqual(before);
  // 同一行上 couli_payout 既有的列级写权照旧（只改 row_version 可以）。
  expect(await sqlState(update(h.roles.couli_payout, row['id'], { row_version: 1 }))).toBe('ok');
});

it('[BR-WDR-26] 只改 review_overdue_at 不动其他列：row_version、updated_at、status 原样（schema 不强制版本号，由任务层决定）', async () => {
  await ready(h.app);
  const row = await seed(h.app, { status: 'APPROVED', reviewed_at: JUDGED_AT, row_version: 1 });
  const before = (await stored(h.app, row['id']))[0];
  expect(before).toBeDefined();
  expect(await sqlState(update(h.app, row['id'], { [COLUMN]: JUDGED_AT }))).toBe('ok');
  const after = (await stored(h.app, row['id']))[0];
  expect(after).toEqual({ ...before, [COLUMN]: JUDGED_AT });
  // 任务层若与 CAS 一起写（row_version + 1、updated_at），couli_app 同样可以。
  expect(
    await sqlState(
      update(h.app, row['id'], { [COLUMN]: JUDGED_AT, row_version: 2, updated_at: JUDGED_AT }),
    ),
  ).toBe('ok');
  expect((await stored(h.roles.couli_readonly, row['id']))[0]).toMatchObject({
    row_version: 2,
    status: 'APPROVED',
  });
});
