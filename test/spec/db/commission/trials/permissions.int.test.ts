import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  ROLES,
  TIMEOUT,
  close,
  fixture,
  insert,
  open,
  ready,
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

it('[AC-B2-03o#12] app 可插入和读取报告，UPDATE 与 DELETE 均拒绝且原报告保留', async () => {
  await ready(h.app);
  const row = await fixture(h.app);
  expect(await sqlState(insert(h.app, row))).toBe('ok');
  const before = await stored(h.app, row['trial_id']);
  expect(before).toEqual([expect.objectContaining({ trial_id: row['trial_id'] })]);
  expect(
    await sqlState(
      sql`UPDATE app.commission_rule_trials SET report = '{}'::jsonb
    WHERE trial_id = ${row['trial_id']}`.execute(h.app),
    ),
  ).toBe('42501');
  expect(
    await sqlState(
      sql`DELETE FROM app.commission_rule_trials
    WHERE trial_id = ${row['trial_id']}`.execute(h.app),
    ),
  ).toBe('42501');
  expect(await stored(h.app, row['trial_id'])).toEqual(before);
});

it('[AC-B2-03o#13] readonly 可读报告，INSERT、UPDATE、DELETE 全部拒绝', async () => {
  await ready(h.app);
  const row = await fixture(h.app);
  expect(await sqlState(insert(h.app, row))).toBe('ok');
  const db = h.roles.couli_readonly;
  const before = await stored(h.app, row['trial_id']);
  expect(await stored(db, row['trial_id'])).toEqual(before);
  expect(await sqlState(insert(db, { ...row, trial_id: randomUUID() }))).toBe('42501');
  expect(
    await sqlState(
      sql`UPDATE app.commission_rule_trials SET sample_count = 0
    WHERE trial_id = ${row['trial_id']}`.execute(db),
    ),
  ).toBe('42501');
  expect(
    await sqlState(
      sql`DELETE FROM app.commission_rule_trials
    WHERE trial_id = ${row['trial_id']}`.execute(db),
    ),
  ).toBe('42501');
  expect(await stored(h.app, row['trial_id'])).toEqual(before);
});

for (const role of ['couli_payout', 'couli_maint'] as const) {
  it(`[AC-B2-03o#14] ${role} SELECT、INSERT、UPDATE、DELETE 均返回 42501`, async () => {
    await ready(h.app);
    const row = await fixture(h.app);
    expect(await sqlState(insert(h.app, row))).toBe('ok');
    const before = await stored(h.app, row['trial_id']);
    const db = h.roles[role];
    expect(await sqlState(stored(db, row['trial_id']))).toBe('42501');
    expect(await sqlState(insert(db, { ...row, trial_id: randomUUID() }))).toBe('42501');
    expect(
      await sqlState(
        sql`UPDATE app.commission_rule_trials SET sample_count = 0
      WHERE trial_id = ${row['trial_id']}`.execute(db),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        sql`DELETE FROM app.commission_rule_trials
      WHERE trial_id = ${row['trial_id']}`.execute(db),
      ),
    ).toBe('42501');
    expect(await stored(h.app, row['trial_id'])).toEqual(before);
  });
}

it('[AC-B2-03o#15] 四角色有效权限精确限定，无额外表级或列级授权', async () => {
  await ready(h.app);
  for (const role of ROLES) {
    const allowed =
      role === 'couli_app' ? ['SELECT', 'INSERT'] : role === 'couli_readonly' ? ['SELECT'] : [];
    for (const privilege of [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
      'MAINTAIN',
    ]) {
      const table = await sql<{ granted: boolean }>`SELECT
        has_table_privilege(${role}, 'app.commission_rule_trials', ${privilege}) AS granted`.execute(
        h.app,
      );
      expect(table.rows, `${role}/${privilege}`).toEqual([
        { granted: allowed.includes(privilege) },
      ]);
      if (['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].includes(privilege)) {
        const column = await sql<{ granted: boolean }>`SELECT
          has_any_column_privilege(${role}, 'app.commission_rule_trials', ${privilege}) AS granted`.execute(
          h.app,
        );
        expect(column.rows, `${role}/column/${privilege}`).toEqual([
          { granted: allowed.includes(privilege) },
        ]);
      }
    }
  }
});
