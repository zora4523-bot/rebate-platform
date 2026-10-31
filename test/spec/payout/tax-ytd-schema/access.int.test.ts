// B2-08a rule tests (规划/08 BR-WDR-20; 规划/04 §3.2 tax_ytd「写者 payout」; db/AGENTS.md rule 4):
// grants of app.tax_ytd. couli_app reads, inserts and rewrites only the running totals and
// updated_at; the identity of a row (user, year, income type, identity hmac) is never rewritten.
// couli_payout and couli_readonly only read; couli_maint has nothing; no role deletes or truncates.
import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  FROZEN,
  MUTABLE,
  ROLES,
  SHAPE,
  TIMEOUT,
  YEAR,
  appId,
  close,
  columns,
  fresh,
  hmac,
  insert,
  ledger,
  member,
  open,
  ready,
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
      has_table_privilege(${role}, 'app.tax_ytd', ${privilege}) AS granted`.execute(h.app)
  ).rows;
}
async function columnPrivilege(role: Role, column: string, privilege: string) {
  return (
    await sql<{ granted: boolean }>`SELECT
      has_column_privilege(${role}, 'app.tax_ytd', ${column}, ${privilege}) AS granted`.execute(
      h.app,
    )
  ).rows;
}
const NEVER = ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];

it('[BR-WDR-20] tax_ytd couli_app 可读、可插入，只可改三个累计与 updated_at（列级），不可删除或清表', async () => {
  await ready(h.app);
  const names = (await columns(h.app)).map((c) => c.name);
  expect(names.sort()).toEqual(Object.keys(SHAPE).sort());
  expect([...MUTABLE, ...FROZEN].sort()).toEqual(names);
  for (const privilege of ['SELECT', 'INSERT']) {
    expect(await tablePrivilege('couli_app', privilege), privilege).toEqual([{ granted: true }]);
  }
  // UPDATE is granted per column, never on the whole table.
  for (const privilege of ['UPDATE', ...NEVER]) {
    expect(await tablePrivilege('couli_app', privilege), privilege).toEqual([{ granted: false }]);
  }
  for (const column of names) {
    for (const privilege of ['SELECT', 'INSERT']) {
      expect(
        await columnPrivilege('couli_app', column, privilege),
        `${column}/${privilege}`,
      ).toEqual([{ granted: true }]);
    }
    expect(await columnPrivilege('couli_app', column, 'UPDATE'), `${column}/UPDATE`).toEqual([
      { granted: MUTABLE.includes(column) },
    ]);
  }
});

it('[BR-WDR-20] tax_ytd couli_payout 只读，couli_readonly 只读，couli_maint 无权限（表级与逐列）', async () => {
  await ready(h.app);
  const names = (await columns(h.app)).map((c) => c.name);
  for (const role of ['couli_payout', 'couli_readonly', 'couli_maint'] as const) {
    const readable = role !== 'couli_maint';
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', ...NEVER]) {
      expect(await tablePrivilege(role, privilege), `${role}/${privilege}`).toEqual([
        { granted: privilege === 'SELECT' && readable },
      ]);
    }
    for (const column of names) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
        expect(
          await columnPrivilege(role, column, privilege),
          `${role}/${column}/${privilege}`,
        ).toEqual([{ granted: privilege === 'SELECT' && readable }]);
      }
    }
  }
});

it('[BR-WDR-20] tax_ytd couli_app 写入后 couli_payout / couli_readonly 读到同一行，它们的写入与所有角色的删除、清表被拒绝', async () => {
  await ready(h.app);
  const row = await fresh(h.app);
  expect(await sqlState(insert(h.app, row))).toBe('ok');
  const before = await stored(h.app, row['id']);
  expect(before).toHaveLength(1);
  for (const role of ROLES) {
    const db = h.roles[role];
    if (role === 'couli_maint') expect(await sqlState(stored(db, row['id'])), role).toBe('42501');
    else expect(await stored(db, row['id']), role).toEqual(before);
    if (role !== 'couli_app') {
      const other = ledger(String(row['app_id']), String(row['user_id']), { year: YEAR + 1 });
      expect(await sqlState(insert(db, other)), `${role}/INSERT`).toBe('42501');
      for (const column of MUTABLE) {
        expect(
          await sqlState(update(db, row['id'], { [column]: before[0]?.[column] })),
          `${role}/UPDATE ${column}`,
        ).toBe('42501');
      }
    }
    expect(
      await sqlState(sql`DELETE FROM app.tax_ytd WHERE id = ${row['id']}`.execute(db)),
      `${role}/DELETE`,
    ).toBe('42501');
    expect(await sqlState(sql`TRUNCATE app.tax_ytd`.execute(db)), `${role}/TRUNCATE`).toBe('42501');
    expect(await stored(h.app, row['id'])).toEqual(before);
  }
});

it('[BR-WDR-20] tax_ytd couli_app 改不了一行的身份：user_id、year、income_type、identity_hmac、app_id、id、created_at 都是 42501', async () => {
  await ready(h.app);
  const row = await fresh(h.app);
  await insert(h.app, row);
  const before = await stored(h.app, row['id']);
  const app = String(row['app_id']);
  const rewrites: Record<string, unknown> = {
    id: randomUUID(),
    app_id: appId(),
    user_id: await member(h.app, app),
    year: YEAR + 1,
    income_type: 'SERVICE_FEE',
    identity_hmac: hmac(),
    created_at: new Date('2032-01-01T00:00:00Z'),
  };
  expect(Object.keys(rewrites).sort()).toEqual([...FROZEN].sort());
  for (const [column, value] of Object.entries(rewrites)) {
    expect(await sqlState(update(h.app, row['id'], { [column]: value })), column).toBe('42501');
  }
  expect(await stored(h.app, row['id'])).toEqual(before);
});

it('[BR-WDR-20] tax_ytd couli_app 改写三个累计与 updated_at，couli_payout 读到新值；累计改成负数被拒绝', async () => {
  await ready(h.app);
  const row = await fresh(h.app);
  await insert(h.app, row);
  const touched = new Date('2032-10-20T02:00:00Z');
  expect(
    await sqlState(
      update(h.app, row['id'], {
        cum_income_fen: 30000n,
        cum_withheld_fen: 1200n,
        continuous_months: 2,
        updated_at: touched,
      }),
    ),
  ).toBe('ok');
  expect((await stored(h.roles.couli_payout, row['id']))[0]).toMatchObject({
    id: row['id'],
    identity_hmac: row['identity_hmac'],
    cum_income_fen: 30000n,
    cum_withheld_fen: 1200n,
    continuous_months: 2,
    updated_at: touched,
  });
  for (const [column, negative] of [
    ['cum_income_fen', -1n],
    ['cum_withheld_fen', -1n],
    ['continuous_months', -1],
  ] as const) {
    expect(await sqlState(update(h.app, row['id'], { [column]: negative })), column).toBe('23514');
  }
});

it('[BR-WDR-20] couli_app 可按唯一键 upsert 累加：会员 10 月提 ¥100、¥200 均已到账 → cum_income 合计 30000 分，同一行', async () => {
  await ready(h.app);
  const app = appId();
  const user = await member(h.app, app);
  const identity = hmac();
  const ids: string[] = [];
  for (const amount of [10000n, 20000n]) {
    const row = ledger(app, user, {
      identity_hmac: identity,
      cum_income_fen: amount,
      continuous_months: 1,
    });
    ids.push(String(row['id']));
    await sql`INSERT INTO app.tax_ytd
      (id, app_id, user_id, year, income_type, identity_hmac, cum_income_fen, cum_withheld_fen,
        continuous_months)
      VALUES (${row['id']}, ${app}, ${user}, ${YEAR}, 'SERVICE_FEE', ${identity}, ${amount}, 0,
        1)
      ON CONFLICT (app_id, user_id, year, income_type, identity_hmac) DO UPDATE SET
        cum_income_fen = app.tax_ytd.cum_income_fen + EXCLUDED.cum_income_fen,
        cum_withheld_fen = app.tax_ytd.cum_withheld_fen + EXCLUDED.cum_withheld_fen,
        updated_at = now()`.execute(h.app);
  }
  const rows = (
    await sql<{ id: string; cum_income_fen: bigint; cum_withheld_fen: bigint }>`
      SELECT id, cum_income_fen, cum_withheld_fen FROM app.tax_ytd
      WHERE app_id = ${app} AND user_id = ${user}`.execute(h.roles.couli_readonly)
  ).rows;
  expect(rows).toEqual([{ id: ids[0], cum_income_fen: 30000n, cum_withheld_fen: 0n }]);
});
