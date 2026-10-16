import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  RESERVE,
  RULE,
  TABLES,
  TIMEOUT,
  UPDATE_COLUMNS,
  VERSION,
  admin,
  close,
  columns,
  insert,
  open,
  requireTables,
  reserveRow,
  ruleRow,
  sqlState,
  version,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open();
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-01d#12] couli_app 三表可读写入，比例和预留不可更新或删除', async () => {
  await requireTables(h.app);
  const parent = await version(h.app);
  for (const table of [RULE, RESERVE]) {
    const row = table === RULE ? ruleRow(parent) : reserveRow(parent);
    expect(await sqlState(insert(h.app, table, row))).toBe('ok');
    const field = table === RULE ? 'r_own_bp' : 'reserve_bp';
    expect(
      await sqlState(
        sql`UPDATE ${sql.table(`app.${table}`)} SET ${sql.ref(field)} = 1
      WHERE rule_version_id = ${parent['rule_version_id']}`.execute(h.app),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        sql`DELETE FROM ${sql.table(`app.${table}`)}
      WHERE rule_version_id = ${parent['rule_version_id']}`.execute(h.app),
      ),
    ).toBe('42501');
    const stored = await sql`SELECT * FROM ${sql.table(`app.${table}`)}
      WHERE rule_version_id = ${parent['rule_version_id']}`.execute(h.app);
    expect(stored.rows).toEqual([expect.objectContaining(row)]);
  }
  expect(
    await sqlState(
      sql`DELETE FROM app.commission_rule_versions
    WHERE rule_version_id = ${parent['rule_version_id']}`.execute(h.app),
    ),
  ).toBe('42501');
});

it('[AC-B2-01d#13] versions 只授台账六列 UPDATE，时间与开关等内容列不可修改', async () => {
  await requireTables(h.app);
  const parent = await version(h.app);
  const actor = await admin(h.app, String(parent['app_id']));
  const values: Record<string, unknown> = {
    status: 'published',
    publisher_id: actor,
    published_at: new Date('2031-12-02T00:00:00+08:00'),
    revoked_at: new Date('2031-12-03T00:00:00+08:00'),
    indirect_approver_id: actor,
    indirect_approved_at: new Date('2031-12-01T01:00:00+08:00'),
  };
  for (const field of UPDATE_COLUMNS) {
    expect(
      await sqlState(
        sql`UPDATE app.commission_rule_versions
      SET ${sql.ref(field)} = ${values[field]}
      WHERE rule_version_id = ${parent['rule_version_id']}`.execute(h.app),
      ),
      field,
    ).toBe('ok');
  }
  for (const field of ['effective_from', 'indirect_enabled']) {
    const value = field === 'effective_from' ? new Date('2033-01-01T00:00:00+08:00') : true;
    expect(
      await sqlState(
        sql`UPDATE app.commission_rule_versions
      SET ${sql.ref(field)} = ${value}
      WHERE rule_version_id = ${parent['rule_version_id']}`.execute(h.app),
      ),
      field,
    ).toBe('42501');
  }
  const stored = await sql`SELECT * FROM app.commission_rule_versions
    WHERE rule_version_id = ${parent['rule_version_id']}`.execute(h.app);
  expect(stored.rows).toEqual([
    expect.objectContaining({
      ...parent,
      indirect_enabled: false,
      ...values,
    }),
  ]);
  for (const { name } of await columns(h.app, VERSION)) {
    const grant = await sql<{ allowed: boolean }>`SELECT has_column_privilege(
      'couli_app', 'app.commission_rule_versions', ${name}, 'UPDATE') AS allowed`.execute(h.app);
    expect(grant.rows, name).toEqual([{ allowed: UPDATE_COLUMNS.includes(name) }]);
  }
});

it('[AC-B2-01d#14] couli_readonly 三表只有 SELECT，写入、更新、删除与额外写权限都被拒绝', async () => {
  await requireTables(h.app);
  const parent = await version(h.app);
  for (const table of TABLES) {
    const row = table === VERSION ? parent : table === RULE ? ruleRow(parent) : reserveRow(parent);
    if (table !== VERSION) expect(await sqlState(insert(h.app, table, row))).toBe('ok');
    const stored = await sql`SELECT * FROM ${sql.table(`app.${table}`)}
      WHERE rule_version_id = ${parent['rule_version_id']}`.execute(h.readonly);
    expect(stored.rows).toEqual([expect.objectContaining(row)]);
    expect(await sqlState(insert(h.readonly, table, row))).toBe('42501');
    expect(
      await sqlState(
        sql`UPDATE ${sql.table(`app.${table}`)} SET app_id = app_id
      WHERE rule_version_id = ${parent['rule_version_id']}`.execute(h.readonly),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        sql`DELETE FROM ${sql.table(`app.${table}`)}
      WHERE rule_version_id = ${parent['rule_version_id']}`.execute(h.readonly),
      ),
    ).toBe('42501');
    for (const role of ['couli_app', 'couli_readonly']) {
      for (const { name } of await columns(h.app, table)) {
        const allowed = role === 'couli_app' && table === VERSION && UPDATE_COLUMNS.includes(name);
        const result = await sql<{ allowed: boolean }>`SELECT has_column_privilege(
          ${role}, ${`app.${table}`}, ${name}, 'UPDATE') AS allowed`.execute(h.app);
        expect(result.rows, `${role}/${table}/${name}/UPDATE`).toEqual([{ allowed }]);
        const inserting = await sql<{ allowed: boolean }>`SELECT has_column_privilege(
          ${role}, ${`app.${table}`}, ${name}, 'INSERT') AS allowed`.execute(h.app);
        expect(inserting.rows, `${role}/${table}/${name}/INSERT`).toEqual([
          { allowed: role === 'couli_app' },
        ]);
      }
      for (const privilege of ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'UPDATE', 'INSERT']) {
        const allowed = role === 'couli_app' && privilege === 'INSERT';
        const result = await sql<{ allowed: boolean }>`SELECT has_table_privilege(
          ${role}, ${`app.${table}`}, ${privilege}) AS allowed`.execute(h.app);
        expect(result.rows, `${role}/${table}/${privilege}`).toEqual([{ allowed }]);
      }
    }
  }
});
