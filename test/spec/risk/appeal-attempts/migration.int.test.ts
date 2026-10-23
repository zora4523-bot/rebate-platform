// B1-03v §9.2 item 1: app.user_risk_state and app.appeals gain penalty_started_at (timestamptz,
// nullable, no default); an appeal that is not on an account never carries one; couli_app may
// write exactly the columns it needs (user_risk_state: UPDATE of the new column; appeals: the
// table-level INSERT it already has — the value is copied at insert and never updated).
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedUser } from '../../identity/registration/kit.ts';
import { closeKit, openKit, type Kit } from '../appeals/service-kit.ts';
import { requirePenaltyColumns } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
});

const AT = new Date('2026-10-20T02:00:00.000Z');
const DEADLINE = new Date('2026-10-27T16:00:00.000Z');

async function user() {
  const appId = `penalty_${randomUUID().replaceAll('-', '')}`;
  return { appId, userId: await seedUser(kit.db, appId) };
}

function insertAppeal(row: {
  appId: string;
  userId: string | null;
  type: 'account' | 'order' | 'blocked_request';
  penalty: Date | null;
  request?: 'withdraw' | 'register' | undefined;
}) {
  const request = row.type === 'blocked_request' ? (row.request ?? 'withdraw') : null;
  return sql`
    INSERT INTO app.appeals
      (id, app_id, user_id, target_type, request_type, target_id, related_phone_hmac,
       prev_risk_state, status, content, deadline_at, penalty_started_at)
    VALUES (${randomUUID()}, ${row.appId}, ${row.userId}, ${row.type}, ${request},
      ${row.type === 'account' ? row.userId : randomUUID()},
      ${request === 'register' ? 'ab'.repeat(32) : null},
      ${row.type === 'account' ? 'frozen' : null}, 'processing', '迁移校验', ${DEADLINE},
      ${row.penalty})
  `.execute(kit.db);
}

it('[AC-B1-03v#1] 两表各有 penalty_started_at：timestamptz、可空、无默认值', async () => {
  await requirePenaltyColumns(kit.db);
});

it('[AC-B1-03v#2] 不写该列时两表都存 NULL；账户申诉可存处罚时刻', async () => {
  await requirePenaltyColumns(kit.db);
  const { appId, userId } = await user();
  await sql`
    INSERT INTO app.user_risk_state (user_id, app_id, state, reason, reason_category, changed_by, changed_at)
    VALUES (${userId}, ${appId}, 'banned', 'fixture', 'other', 'fixture', ${AT})
  `.execute(kit.db);
  const state = await sql<{ penalty_started_at: Date | null }>`
    SELECT penalty_started_at FROM app.user_risk_state WHERE user_id = ${userId}
  `.execute(kit.db);
  expect(state.rows).toEqual([{ penalty_started_at: null }]);
  await sql`
    INSERT INTO app.appeals
      (id, app_id, user_id, target_type, target_id, prev_risk_state, status, content, deadline_at)
    VALUES (${randomUUID()}, ${appId}, ${userId}, 'account', ${userId}, 'banned', 'processing',
      '存量申诉', ${DEADLINE})
  `.execute(kit.db);
  await sql`UPDATE app.appeals SET status = 'upheld', closed_at = ${AT}, handler_id = 'h'
    WHERE app_id = ${appId}`.execute(kit.db);
  await insertAppeal({ appId, userId, type: 'account', penalty: AT });
  const appeals = await sql<{ status: string; penalty_started_at: Date | null }>`
    SELECT status, penalty_started_at FROM app.appeals WHERE app_id = ${appId} ORDER BY status
  `.execute(kit.db);
  expect(appeals.rows).toEqual([
    { status: 'processing', penalty_started_at: AT },
    { status: 'upheld', penalty_started_at: null },
  ]);
});

for (const [type, request] of [
  ['order', undefined],
  ['blocked_request', 'withdraw'],
  ['blocked_request', 'register'],
] as const) {
  it(`[AC-B1-03v#3] ${type}${request ? `/${request}` : ''} 申诉的 penalty_started_at 必为空（CHECK）`, async () => {
    await requirePenaltyColumns(kit.db);
    const { appId, userId } = await user();
    const owner = request === 'register' ? null : userId;
    await expect(
      insertAppeal({ appId, userId: owner, type, request, penalty: AT }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertAppeal({ appId, userId: owner, type, request, penalty: null }),
    ).resolves.toBeDefined();
    const rows = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM app.appeals WHERE app_id = ${appId}
    `.execute(kit.db);
    expect(rows.rows).toEqual([{ n: '1' }]);
  });
}

it('[AC-B1-03v#4] 账户申诉可空也可带处罚时刻（存量与新单）', async () => {
  await requirePenaltyColumns(kit.db);
  const { appId, userId } = await user();
  await expect(
    insertAppeal({ appId, userId, type: 'account', penalty: null }),
  ).resolves.toBeDefined();
  await sql`UPDATE app.appeals SET status = 'upheld', closed_at = ${AT}, handler_id = 'h'
    WHERE app_id = ${appId}`.execute(kit.db);
  await expect(
    insertAppeal({ appId, userId, type: 'account', penalty: AT }),
  ).resolves.toBeDefined();
});

/** Columns of `table` the role may UPDATE (column-level grants: no table-level UPDATE exists). */
async function updatable(role: string, table: 'appeals' | 'user_risk_state') {
  const result = await sql<{ name: string }>`
    SELECT a.attname::text AS name
    FROM pg_attribute a
    WHERE a.attrelid = ${`app.${table}`}::text::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND has_column_privilege(${role}::name, a.attrelid, a.attnum, 'UPDATE')
    ORDER BY a.attname
  `.execute(kit.db);
  return result.rows.map((row) => row.name);
}

async function columnPrivileges(role: string, table: 'appeals' | 'user_risk_state') {
  const result = await sql<{ can_select: boolean; can_insert: boolean; can_update: boolean }>`
    SELECT
      has_column_privilege(${role}::name, ${`app.${table}`}::text, 'penalty_started_at', 'SELECT')
        AS can_select,
      has_column_privilege(${role}::name, ${`app.${table}`}::text, 'penalty_started_at', 'INSERT')
        AS can_insert,
      has_column_privilege(${role}::name, ${`app.${table}`}::text, 'penalty_started_at', 'UPDATE')
        AS can_update
  `.execute(kit.db);
  return result.rows[0];
}

async function tablePrivileges(role: string, table: 'appeals' | 'user_risk_state') {
  const result = await sql<Record<string, boolean>>`
    SELECT has_table_privilege(${role}::name, ${`app.${table}`}::text, 'SELECT') AS can_select,
           has_table_privilege(${role}::name, ${`app.${table}`}::text, 'INSERT') AS can_insert,
           has_table_privilege(${role}::name, ${`app.${table}`}::text, 'UPDATE') AS can_update,
           has_table_privilege(${role}::name, ${`app.${table}`}::text, 'DELETE') AS can_delete,
           has_table_privilege(${role}::name, ${`app.${table}`}::text, 'TRUNCATE') AS can_truncate
  `.execute(kit.db);
  return result.rows[0];
}

it('[AC-B1-03v#5] couli_app 授权：风控状态新列可更新，申诉新列只随建单写入，别的列不放宽', async () => {
  await requirePenaltyColumns(kit.db);
  expect(await columnPrivileges('couli_app', 'user_risk_state')).toEqual({
    can_select: true,
    can_insert: true,
    can_update: true,
  });
  expect(await columnPrivileges('couli_app', 'appeals')).toEqual({
    can_select: true,
    can_insert: true,
    can_update: false,
  });
  for (const table of ['appeals', 'user_risk_state'] as const) {
    expect(await tablePrivileges('couli_app', table), table).toEqual({
      can_select: true,
      can_insert: true,
      can_update: false,
      can_delete: false,
      can_truncate: false,
    });
  }
  expect(await updatable('couli_app', 'user_risk_state')).toEqual(
    [
      'changed_at',
      'changed_by',
      'frozen_until',
      'penalty_started_at',
      'reason',
      'reason_category',
      'row_version',
      'state',
      'updated_at',
    ].sort(),
  );
  expect(await updatable('couli_app', 'appeals')).toEqual(
    ['closed_at', 'handler_id', 'row_version', 'status', 'updated_at'].sort(),
  );
});

it('[AC-B1-03v#6] 其他角色：readonly 只读、payout 读不到新列、maint 无权限', async () => {
  await requirePenaltyColumns(kit.db);
  for (const table of ['appeals', 'user_risk_state'] as const) {
    expect(await columnPrivileges('couli_readonly', table), `readonly/${table}`).toEqual({
      can_select: true,
      can_insert: false,
      can_update: false,
    });
    for (const role of ['couli_payout', 'couli_maint']) {
      expect(await columnPrivileges(role, table), `${role}/${table}`).toEqual({
        can_select: false,
        can_insert: false,
        can_update: false,
      });
    }
  }
});

it('[AC-B1-03v#7] couli_app 能经 UPDATE 写风控状态新列，不能改申诉新列', async () => {
  await requirePenaltyColumns(kit.db);
  const { appId, userId } = await user();
  await sql`
    INSERT INTO app.user_risk_state (user_id, app_id, state, reason, reason_category, changed_by, changed_at)
    VALUES (${userId}, ${appId}, 'frozen', 'fixture', 'other', 'fixture', ${AT})
  `.execute(kit.db);
  const updated = await sql`
    UPDATE app.user_risk_state SET penalty_started_at = ${AT} WHERE user_id = ${userId}
  `.execute(kit.db);
  expect(updated.numAffectedRows).toBe(1n);
  await insertAppeal({ appId, userId, type: 'account', penalty: AT });
  await expect(
    sql`UPDATE app.appeals SET penalty_started_at = NULL WHERE app_id = ${appId}`.execute(kit.db),
  ).rejects.toMatchObject({ code: '42501' });
});
