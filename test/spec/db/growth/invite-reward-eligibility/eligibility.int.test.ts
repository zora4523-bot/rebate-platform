import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  QUALIFIED_AT,
  STATUSES,
  UPDATABLE,
  close,
  insert,
  open,
  read,
  ready,
  reward,
  update,
  type Harness,
  type Row,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
});
afterAll(async () => {
  await close(h);
});

it('[AC-CT-25d#1] 锁定天数为无默认值的必填 int4，具名下界约束已验证', async () => {
  await ready(h.app);
  const constraint = await sql<{
    name: string;
    kind: string;
    valid: boolean;
    columns: string[];
    definition: string;
  }>`SELECT c.conname::text AS name, c.contype::text AS kind, c.convalidated AS valid,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) k(num)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num) AS columns,
    pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c WHERE c.conrelid = to_regclass('app.invite_rewards')
      AND c.conname = 'invite_rewards_eligibility_days_check'`.execute(h.app);
  expect(constraint.rows).toEqual([
    {
      name: 'invite_rewards_eligibility_days_check',
      kind: 'c',
      valid: true,
      columns: ['eligibility_days'],
      definition: expect.stringMatching(/eligibility_days\s*>=\s*1\b/),
    },
  ]);
});

it('[AC-CT-25d#2] 漏写或 NULL 拒绝，零与负数由具名 CHECK 拒绝，失败不留下资格行', async () => {
  await ready(h.app);
  const row = await reward(h.app);
  const omitted = { ...row };
  delete omitted['eligibility_days'];
  for (const invalid of [omitted, { ...row, eligibility_days: null }]) {
    await expect(insert(h.app, 'invite_rewards', invalid)).rejects.toMatchObject({
      code: '23502',
      column: 'eligibility_days',
    });
    expect((await read(h.app, row)).rows).toEqual([]);
  }
  for (const days of [0, -1]) {
    await expect(
      insert(h.app, 'invite_rewards', { ...row, eligibility_days: days }),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'invite_rewards_eligibility_days_check',
    });
    expect((await read(h.app, row)).rows).toEqual([]);
  }
});

it('[AC-CT-25d#3] 每条资格显式锁定自己的天数与金额，数据库不加配置层上限', async () => {
  await ready(h.app);
  // 3651 is deliberately above the configuration limit; CT-25d §9.2 forbids a DB upper bound.
  for (const days of [1, 30, 3651]) {
    const row = { ...(await reward(h.app)), eligibility_days: days };
    await expect(insert(h.app, 'invite_rewards', row)).resolves.toMatchObject({
      rows: [expect.objectContaining(row)],
    });
    expect((await read(h.readonly, row)).rows).toEqual([
      expect.objectContaining({
        ...row,
        amount_fen: 100n,
        eligibility_days: days,
        qualified_at: QUALIFIED_AT,
      }),
    ]);
  }
});

it('[AC-CT-25d#4] app 无整表 UPDATE，天数不可改且原有列级更新权限完整保留', async () => {
  await ready(h.app);
  const row: Row = { ...(await reward(h.app)), eligibility_days: 7 };
  const saved = (await insert(h.app, 'invite_rewards', row)).rows;
  const table = await sql`SELECT
    has_table_privilege('couli_app', 'app.invite_rewards', 'UPDATE') AS can_update,
    has_column_privilege('couli_app', 'app.invite_rewards', 'eligibility_days', 'INSERT') AS can_insert,
    has_column_privilege('couli_app', 'app.invite_rewards', 'eligibility_days', 'UPDATE') AS can_change
  `.execute(h.app);
  expect(table.rows).toEqual([{ can_update: false, can_insert: true, can_change: false }]);
  const columns = await sql<{ column_name: string }>`SELECT column_name
    FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'invite_rewards'
      AND has_column_privilege('couli_app', 'app.invite_rewards', column_name, 'UPDATE')
    ORDER BY column_name`.execute(h.app);
  expect(columns.rows.map((column) => column.column_name)).toEqual([...UPDATABLE].sort());
  for (const days of [7, 30]) {
    await expect(update(h.app, row, { eligibility_days: days })).rejects.toMatchObject({
      code: '42501',
    });
    expect((await read(h.app, row)).rows).toEqual(saved);
  }
  for (const column of UPDATABLE) {
    const unchanged = await sql`UPDATE app.invite_rewards
      SET ${sql.ref(column)} = ${sql.ref(column)}
      WHERE app_id = ${row['app_id']} AND invitee_id = ${row['invitee_id']} RETURNING *`.execute(
      h.app,
    );
    expect(unchanged.rows, column).toEqual(saved);
  }
  expect((await update(h.app, row, { status: 'deferred', row_version: 1 })).rows).toEqual([
    expect.objectContaining({ ...row, status: 'deferred', row_version: 1 }),
  ]);
  expect((await update(h.app, row, { status: 'expired', row_version: 2 })).rows).toEqual([
    expect.objectContaining({ ...row, status: 'expired', row_version: 2 }),
  ]);
});

it('[AC-CT-25d#5] readonly 能读取锁定天数但不能插入或更新，拒绝后原行不变', async () => {
  await ready(h.app);
  const row = await reward(h.app);
  const saved = (await insert(h.app, 'invite_rewards', row)).rows;
  expect((await read(h.readonly, row)).rows).toEqual(saved);
  const another = await reward(h.app);
  await expect(insert(h.readonly, 'invite_rewards', another)).rejects.toMatchObject({
    code: '42501',
  });
  for (const changes of [{ eligibility_days: 1 }, { status: 'expired' }, { row_version: 1 }]) {
    await expect(update(h.readonly, row, changes)).rejects.toMatchObject({ code: '42501' });
  }
  expect((await read(h.app, row)).rows).toEqual(saved);
  expect((await read(h.app, another)).rows).toEqual([]);
});

it('[AC-CT-25d#6] 同名 status CHECK 已验证且恰含五值，expired 可无结果和原因', async () => {
  await ready(h.app);
  const constraints = await sql<{ valid: boolean; definition: string }>`SELECT
    convalidated AS valid, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = to_regclass('app.invite_rewards')
      AND conname = 'invite_rewards_status_check' AND contype = 'c'`.execute(h.app);
  expect(constraints.rows).toEqual([{ valid: true, definition: expect.any(String) }]);
  const values = Array.from(
    constraints.rows[0]!.definition.matchAll(/'([^']*)'/g),
    (match) => match[1],
  );
  expect(values.sort()).toEqual([...STATUSES].sort());
  for (const status of STATUSES) {
    const row = {
      ...(await reward(h.app)),
      status,
      inviter_result: status === 'processed' ? 'granted' : null,
      invitee_result: status === 'processed' ? 'granted' : null,
      inviter_skip_reason: null,
      invitee_skip_reason: null,
      void_reason: status === 'voided' ? 'relation_changed' : null,
    };
    await expect(insert(h.app, 'invite_rewards', row)).resolves.toMatchObject({
      rows: [expect.objectContaining(row)],
    });
    expect((await read(h.app, row)).rows).toEqual([expect.objectContaining(row)]);
  }
});

it('[AC-CT-25d#7] budget_exhausted 被拒，expired 仍受 voided 与原因配对约束', async () => {
  await ready(h.app);
  const row = await reward(h.app);
  await expect(
    insert(h.app, 'invite_rewards', { ...row, status: 'budget_exhausted' }),
  ).rejects.toMatchObject({ code: '23514', constraint: 'invite_rewards_status_check' });
  await expect(
    insert(h.app, 'invite_rewards', {
      ...row,
      status: 'expired',
      void_reason: 'relation_changed',
    }),
  ).rejects.toMatchObject({ code: '23514', constraint: 'invite_rewards_void_pair_check' });
  await expect(insert(h.app, 'invite_rewards', { ...row, status: 'voided' })).rejects.toMatchObject(
    { code: '23514', constraint: 'invite_rewards_void_pair_check' },
  );
  expect((await read(h.app, row)).rows).toEqual([]);
  const saved = (await insert(h.app, 'invite_rewards', { ...row, status: 'expired' })).rows;
  await expect(update(h.app, row, { status: 'budget_exhausted' })).rejects.toMatchObject({
    code: '23514',
    constraint: 'invite_rewards_status_check',
  });
  await expect(update(h.app, row, { void_reason: 'relation_changed' })).rejects.toMatchObject({
    code: '23514',
    constraint: 'invite_rewards_void_pair_check',
  });
  expect((await read(h.app, row)).rows).toEqual(saved);
});
