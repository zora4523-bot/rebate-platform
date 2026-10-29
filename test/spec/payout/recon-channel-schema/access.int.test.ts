// B2-07a rule tests (规划/08 BR-WDR-23; 编排裁定 D10-408): grants of app.recon_channel and
// app.payout_recon_runs. The worker's couli_app writes both (a rerun of the same bill day rewrites
// its rows), couli_payout only reads them; no role deletes or truncates.
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  MUTABLE,
  ROLES,
  SHAPES,
  TABLES,
  TIMEOUT,
  appId,
  close,
  columns,
  insert,
  open,
  ready,
  run,
  sample,
  sqlState,
  stored,
  update,
  type Harness,
  type Role,
  type ReconTable,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

async function tablePrivilege(role: Role, table: ReconTable, privilege: string) {
  return (
    await sql<{ granted: boolean }>`SELECT
      has_table_privilege(${role}, ${`app.${table}`}, ${privilege}) AS granted`.execute(h.app)
  ).rows;
}
async function columnPrivilege(role: Role, table: ReconTable, column: string, privilege: string) {
  return (
    await sql<{ granted: boolean }>`SELECT
      has_column_privilege(${role}, ${`app.${table}`}, ${column}, ${privilege}) AS granted`.execute(
      h.app,
    )
  ).rows;
}
const NEVER = ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];

for (const table of TABLES) {
  it(`[BR-WDR-23] ${table} couli_app 可读、可插入、可改重跑字段，不可删除或清表`, async () => {
    await ready(h.app);
    const names = (await columns(h.app, table)).map((c) => c.name);
    expect(names.sort()).toEqual(Object.keys(SHAPES[table]).sort());
    for (const privilege of ['SELECT', 'INSERT']) {
      expect(await tablePrivilege('couli_app', table, privilege), privilege).toEqual([
        { granted: true },
      ]);
    }
    for (const privilege of NEVER) {
      expect(await tablePrivilege('couli_app', table, privilege), privilege).toEqual([
        { granted: false },
      ]);
    }
    for (const column of names) {
      for (const privilege of ['SELECT', 'INSERT']) {
        expect(
          await columnPrivilege('couli_app', table, column, privilege),
          `${column}/${privilege}`,
        ).toEqual([{ granted: true }]);
      }
    }
    for (const column of MUTABLE[table]) {
      expect(await columnPrivilege('couli_app', table, column, 'UPDATE'), column).toEqual([
        { granted: true },
      ]);
    }
  });

  it(`[BR-WDR-23] ${table} couli_payout 只读，couli_readonly 只读，couli_maint 无权限（表级与逐列）`, async () => {
    await ready(h.app);
    const names = (await columns(h.app, table)).map((c) => c.name);
    for (const role of ['couli_payout', 'couli_readonly', 'couli_maint'] as const) {
      const readable = role !== 'couli_maint';
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', ...NEVER]) {
        expect(await tablePrivilege(role, table, privilege), `${role}/${privilege}`).toEqual([
          { granted: privilege === 'SELECT' && readable },
        ]);
      }
      for (const column of names) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          expect(
            await columnPrivilege(role, table, column, privilege),
            `${role}/${column}/${privilege}`,
          ).toEqual([{ granted: privilege === 'SELECT' && readable }]);
        }
      }
    }
  });

  it(`[BR-WDR-23] ${table} couli_app 写入后 couli_payout 读到同一行，其余角色的写入与所有删除被拒绝`, async () => {
    await ready(h.app);
    const row = sample(table, appId());
    expect(await sqlState(insert(h.app, table, row))).toBe('ok');
    const before = await stored(h.app, table, row['id']);
    expect(before).toHaveLength(1);
    const rewrite = MUTABLE[table][0] ?? '';
    for (const role of ROLES) {
      const db = h.roles[role];
      if (role === 'couli_maint')
        expect(await sqlState(stored(db, table, row['id'])), role).toBe('42501');
      else expect(await stored(db, table, row['id']), role).toEqual(before);
      if (role !== 'couli_app') {
        expect(await sqlState(insert(db, table, sample(table, appId()))), `${role}/INSERT`).toBe(
          '42501',
        );
        expect(
          await sqlState(update(db, table, row['id'], { [rewrite]: before[0]?.[rewrite] })),
          `${role}/UPDATE`,
        ).toBe('42501');
      }
      expect(
        await sqlState(
          sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE id = ${row['id']}`.execute(db),
        ),
        `${role}/DELETE`,
      ).toBe('42501');
      expect(
        await sqlState(sql`TRUNCATE ${sql.table(`app.${table}`)}`.execute(db)),
        `${role}/TRUNCATE`,
      ).toBe('42501');
      expect(await stored(h.app, table, row['id'])).toEqual(before);
    }
  });
}

it('[BR-WDR-23] couli_app 重跑同一账单日时按 (app_id, channel, bill_date) 覆盖运行登记：failed → succeeded', async () => {
  await ready(h.app);
  const app = appId();
  const first = run(app, { status: 'failed', bill_rows: 0, matched: 0, diffs: 0 });
  await insert(h.app, 'payout_recon_runs', first);
  const rerun = run(app, {
    started_at: new Date('2032-06-15T03:00:00Z'),
    finished_at: new Date('2032-06-15T03:04:00Z'),
  });
  await sql`INSERT INTO app.payout_recon_runs
    (id, app_id, channel, bill_date, status, started_at, finished_at, bill_rows, matched, diffs)
    VALUES (${rerun['id']}, ${app}, 'alipay', ${rerun['bill_date']}, 'succeeded',
      ${rerun['started_at']}, ${rerun['finished_at']}, 12, 11, 1)
    ON CONFLICT (app_id, channel, bill_date) DO UPDATE SET status = EXCLUDED.status,
      started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at,
      bill_rows = EXCLUDED.bill_rows, matched = EXCLUDED.matched, diffs = EXCLUDED.diffs,
      updated_at = now()`.execute(h.app);
  const rows = (
    await sql<{ id: string; status: string; bill_rows: number; matched: number; diffs: number }>`
      SELECT id, status, bill_rows, matched, diffs FROM app.payout_recon_runs
      WHERE app_id = ${app}`.execute(h.roles.couli_payout)
  ).rows;
  expect(rows).toEqual([
    { id: first['id'], status: 'succeeded', bill_rows: 12, matched: 11, diffs: 1 },
  ]);
});

it('[BR-WDR-23] couli_app 重跑同一账单日时改写对账明细的状态、金额与结果', async () => {
  await ready(h.app);
  const row = sample('recon_channel', appId(), { our_status: 'PAYING', result: 'paying_query' });
  await insert(h.app, 'recon_channel', row);
  expect(
    await sqlState(
      update(h.app, 'recon_channel', row['id'], {
        our_status: 'PAID_API',
        channel_status: 'SUCCESS',
        our_amount_fen: 10000n,
        channel_amount_fen: 10000n,
        result: 'matched',
        updated_at: new Date('2032-06-15T03:00:00Z'),
      }),
    ),
  ).toBe('ok');
  expect((await stored(h.roles.couli_payout, 'recon_channel', row['id']))[0]).toMatchObject({
    id: row['id'],
    our_status: 'PAID_API',
    result: 'matched',
  });
});
