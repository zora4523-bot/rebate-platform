import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  AT,
  NEXT,
  TABLES,
  UPDATABLE,
  SHAPES_NOW,
  close,
  expectForm,
  insert,
  open,
  ready,
  references,
  reward,
  update,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
});
afterAll(async () => {
  await close(h);
});

it('[AC-CT-25b#18] app 仅 SELECT/INSERT 与指定列 UPDATE，readonly 仅 SELECT，无整表 UPDATE', async () => {
  await ready(h.app);
  // CT-25e: columns after CT-25d (F1-02zt：过渡已收紧); eligibility_days is insertable but not
  // in UPDATABLE.
  await expectForm(h.app);
  const shapes = SHAPES_NOW;
  for (const table of TABLES) {
    for (const role of ['couli_app', 'couli_readonly']) {
      for (const privilege of [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
      ]) {
        const allowed = privilege === 'SELECT' || (privilege === 'INSERT' && role === 'couli_app');
        const result = await sql`SELECT
          has_table_privilege(${role}, to_regclass(${`app.${table}`}), ${privilege}) AS allowed,
          has_table_privilege(${role}, to_regclass(${`app.${table}`}), ${`${privilege} WITH GRANT OPTION`}) AS grantable`.execute(
          h.app,
        );
        expect(result.rows, `${role} ${table} ${privilege}`).toEqual([
          { allowed, grantable: false },
        ]);
      }
      for (const column of Object.keys(shapes[table])) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          const allowed =
            privilege === 'SELECT' ||
            (role === 'couli_app' &&
              (privilege === 'INSERT' ||
                (privilege === 'UPDATE' && UPDATABLE[table].includes(column))));
          const result = await sql`SELECT
            has_column_privilege(${role}, to_regclass(${`app.${table}`}), ${column}, ${privilege}) AS allowed,
            has_column_privilege(${role}, to_regclass(${`app.${table}`}), ${column}, ${`${privilege} WITH GRANT OPTION`}) AS grantable`.execute(
            h.app,
          );
          expect(result.rows, `${role} ${table}.${column} ${privilege}`).toEqual([
            { allowed, grantable: false },
          ]);
        }
      }
    }
    const publicPrivileges = await sql`SELECT acl.privilege_type FROM pg_class c
      CROSS JOIN LATERAL aclexplode(c.relacl) acl
      WHERE c.oid = to_regclass(${`app.${table}`}) AND acl.grantee = 0
      UNION ALL SELECT acl.privilege_type FROM pg_attribute a
      CROSS JOIN LATERAL aclexplode(a.attacl) acl
      WHERE a.attrelid = to_regclass(${`app.${table}`}) AND acl.grantee = 0`.execute(h.app);
    expect(publicPrivileges.rows).toEqual([]);
  }
}, 30_000);

it('[AC-CT-25b#19] 逐列实测更新权限，禁止改资格身份、金额、绑定来源/IP 与预算键', async () => {
  await ready(h.app);
  // CT-25e: columns after CT-25d (F1-02zt：过渡已收紧).
  await expectForm(h.app);
  const shapes = SHAPES_NOW;
  const row = await reward(h.app);
  const stored = {
    invite_rewards: await insert(h.app, 'invite_rewards', row),
    invite_reward_budgets: await insert(h.app, 'invite_reward_budgets', {
      app_id: row['app_id'],
      period: 'total',
      updated_at: AT,
    }),
  };
  for (const table of TABLES) {
    for (const column of Object.keys(shapes[table])) {
      // A no-op on a real row isolates authorization from CHECK, FK and uniqueness errors.
      const change =
        sql`UPDATE ${sql.table(`app.${table}`)} SET ${sql.ref(column)} = ${sql.ref(column)}
        WHERE app_id = ${row['app_id']} RETURNING *`.execute(h.app);
      if (UPDATABLE[table].includes(column)) {
        expect((await change).rows).toEqual([stored[table]]);
      } else {
        await expect(change).rejects.toMatchObject({ code: '42501' });
      }
    }
    const selected = await sql`SELECT * FROM ${sql.table(`app.${table}`)}
      WHERE app_id = ${row['app_id']}`.execute(h.readonly);
    expect(selected.rows).toEqual([stored[table]]);
  }
});

it('[AC-CT-25b#20] 两表拒绝 app 删除/清空与 readonly 全部写入，失败后保留原记录', async () => {
  await ready(h.app);
  const row = await reward(h.app);
  const data = {
    invite_rewards: row,
    invite_reward_budgets: { app_id: row['app_id'], period: 'total', updated_at: AT },
  };
  for (const table of TABLES) {
    const saved = await insert(h.app, table, data[table]);
    await expect(insert(h.readonly, table, data[table])).rejects.toMatchObject({ code: '42501' });
    for (const db of [h.app, h.readonly]) {
      await expect(
        sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE app_id = ${row['app_id']}`.execute(db),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        sql`TRUNCATE TABLE ${sql.table(`app.${table}`)}`.execute(db),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      sql`UPDATE ${sql.table(`app.${table}`)} SET row_version = row_version + 1
      WHERE app_id = ${row['app_id']}`.execute(h.readonly),
    ).rejects.toMatchObject({ code: '42501' });
    const selected = await sql`SELECT * FROM ${sql.table(`app.${table}`)}
      WHERE app_id = ${row['app_id']}`.execute(h.app);
    expect(selected.rows).toEqual([saved]);
  }
});

it('[AC-CT-25b#21] 允许实际更新触发信息、双方结果/凭证、作废原因、计数和版本', async () => {
  await ready(h.app);
  const row = await reward(h.app);
  await insert(h.app, 'invite_rewards', row);
  const refs = await references(h.app, String(row['app_id']));
  const fields = {
    trigger_order_id: refs.order,
    triggered_at: AT,
    status: 'processed',
    inviter_result: 'granted',
    invitee_result: 'granted',
    inviter_voucher_id: refs.voucher,
    invitee_voucher_id: refs.voucher,
    granted_at: NEXT,
    row_version: 1,
  };
  expect((await update(h.app, 'invite_rewards', row['app_id'], fields)).rows).toEqual([
    expect.objectContaining(fields),
  ]);
  for (const side of ['inviter', 'invitee']) {
    const skipped = await reward(h.app);
    await insert(h.app, 'invite_rewards', skipped);
    const changes = { [`${side}_result`]: 'skipped', [`${side}_skip_reason`]: 'same_ip' };
    expect((await update(h.app, 'invite_rewards', skipped['app_id'], changes)).rows).toEqual([
      expect.objectContaining(changes),
    ]);
  }
  const voided = await reward(h.app);
  await insert(h.app, 'invite_rewards', voided);
  expect(
    (
      await update(h.app, 'invite_rewards', voided['app_id'], {
        status: 'voided',
        void_reason: 'relation_changed',
        row_version: 1,
      })
    ).rows,
  ).toEqual([
    expect.objectContaining({ status: 'voided', void_reason: 'relation_changed', row_version: 1 }),
  ]);
  await insert(h.app, 'invite_reward_budgets', {
    app_id: row['app_id'],
    period: 'total',
    updated_at: AT,
  });
  const counters = { reserved_fen: 200n, granted_fen: 100n, row_version: 1, updated_at: NEXT };
  expect((await update(h.app, 'invite_reward_budgets', row['app_id'], counters)).rows).toEqual([
    expect.objectContaining(counters),
  ]);
});
