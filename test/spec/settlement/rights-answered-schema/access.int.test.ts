// B2-04lb rule tests (money r1 S0; 编排裁定 D10-483): grants of app.order_rights after answered_at.
// settlement's writer couli_app may UPDATE answered_at; nothing else widens: table-level grants
// stay as on main (couli_app SELECT / INSERT / UPDATE, couli_readonly SELECT, couli_payout and
// couli_maint nothing), and every role's column grants on answered_at match its table grants.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  ANSWERED_AT,
  ROLES,
  TIMEOUT,
  close,
  columns,
  insert,
  open,
  orderKey,
  ready,
  rights,
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

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];

/** Table-level grants on app.order_rights as on main. */
const MAIN: Record<Role, readonly string[]> = {
  couli_app: ['SELECT', 'INSERT', 'UPDATE'],
  couli_payout: [],
  couli_readonly: ['SELECT'],
  couli_maint: [],
};

async function tablePrivilege(role: Role, privilege: string) {
  return (
    await sql<{ granted: boolean }>`SELECT
      has_table_privilege(${role}, 'app.order_rights', ${privilege}) AS granted`.execute(h.app)
  ).rows;
}
async function columnPrivilege(role: Role, column: string, privilege: string) {
  return (
    await sql<{ granted: boolean }>`SELECT
      has_column_privilege(${role}, 'app.order_rights', ${column}, ${privilege}) AS granted`.execute(
      h.app,
    )
  ).rows;
}

it('[AC-B2-04lb#30] D10-483 couli_app 对 answered_at 有 UPDATE（并可读）；不得删除或清表', async () => {
  await ready(h.app);
  for (const privilege of ['SELECT', 'UPDATE']) {
    expect(await columnPrivilege('couli_app', 'answered_at', privilege), privilege).toEqual([
      { granted: true },
    ]);
  }
  for (const privilege of ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
    expect(await tablePrivilege('couli_app', privilege), privilege).toEqual([{ granted: false }]);
  }
});

it('[AC-B2-04lb#31] D10-483 不扩权：各角色对 app.order_rights 的表级授权与主干一致，对每一列（含 answered_at）的列级授权与其表级授权一致', async () => {
  await ready(h.app);
  const names = (await columns(h.app)).map((c) => c.name);
  expect(names).toContain('answered_at');
  for (const role of ROLES) {
    for (const privilege of PRIVILEGES) {
      expect(await tablePrivilege(role, privilege), `${role}/${privilege}`).toEqual([
        { granted: MAIN[role].includes(privilege) },
      ]);
    }
    for (const column of names) {
      for (const privilege of COLUMN_PRIVILEGES) {
        expect(
          await columnPrivilege(role, column, privilege),
          `${role}/${column}/${privilege}`,
        ).toEqual([{ granted: MAIN[role].includes(privilege) }]);
      }
    }
  }
});

it('[AC-B2-04lb#32] D10-483 couli_app 写入的 answered_at：couli_readonly 读到同一值、不能改；couli_payout 与 couli_maint 读写都被拒绝', async () => {
  await ready(h.app);
  const { appId, orderId } = await orderKey(h.app);
  const row = rights(appId, orderId);
  await insert(h.app, row);
  expect(await sqlState(update(h.app, row['id'], { answered_at: ANSWERED_AT }))).toBe('ok');
  const saved = await stored(h.app, row['id']);
  expect(saved).toEqual([expect.objectContaining({ answered_at: ANSWERED_AT })]);

  expect(await stored(h.roles.couli_readonly, row['id'])).toEqual(saved);
  const later = new Date(ANSWERED_AT.getTime() + 1);
  for (const role of ['couli_readonly', 'couli_payout', 'couli_maint'] as const) {
    expect(
      await sqlState(update(h.roles[role], row['id'], { answered_at: later })),
      `${role}/UPDATE`,
    ).toBe('42501');
    if (role !== 'couli_readonly') {
      expect(await sqlState(stored(h.roles[role], row['id'])), `${role}/SELECT`).toBe('42501');
    }
  }
  expect(await stored(h.app, row['id'])).toEqual(saved);
});
