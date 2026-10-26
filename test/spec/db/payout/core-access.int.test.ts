import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { AT, ROLES, TIMEOUT, close, insert, open, sqlState, type Harness } from './kit.ts';
import {
  COMPLETION_COLUMNS,
  SHAPES,
  TABLES,
  attempt,
  batch,
  columns,
  fixture,
  item,
  ready,
  stored,
  update,
  watermark,
  writer,
} from './core-kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

for (const table of TABLES) {
  it(`[AC-B2-06a#15] ${table} 四角色表级和逐列有效权限精确匹配，禁止扩大授权`, async () => {
    await ready(h.app);
    // Query actual columns too: an unexpected column must not acquire UPDATE privileges.
    const names = (await columns(h.app, table)).map((c) => c.name);
    expect(names.sort()).toEqual(Object.keys(SHAPES[table]).sort());
    for (const role of ROLES) {
      const readable = role !== 'couli_maint';
      const insertable =
        table === 'payout_attempts' ? role === 'couli_payout' : role === 'couli_app';
      const updates =
        table === 'payout_attempts' && role === 'couli_payout' ? COMPLETION_COLUMNS : [];
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
        const expected =
          privilege === 'SELECT' ? readable : privilege === 'INSERT' ? insertable : false;
        const found = await sql<{ granted: boolean }>`SELECT
          has_table_privilege(${role}, ${`app.${table}`}, ${privilege}) AS granted`.execute(h.app);
        expect(found.rows, `${role}/${table}/${privilege}`).toEqual([{ granted: expected }]);
      }
      for (const column of names) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          const expected =
            privilege === 'SELECT'
              ? readable
              : privilege === 'INSERT'
                ? insertable
                : privilege === 'UPDATE'
                  ? updates.includes(column)
                  : false;
          const found = await sql<{ granted: boolean }>`SELECT
            has_column_privilege(${role}, ${`app.${table}`}, ${column}, ${privilege}) AS granted`.execute(
            h.app,
          );
          expect(found.rows, `${role}/${table}/${column}/${privilege}`).toEqual([
            { granted: expected },
          ]);
        }
      }
    }
  });

  it(`[AC-B2-06a#16] ${table} 只允许指定角色插入，业务读取放行，DELETE/TRUNCATE 全部拒绝`, async () => {
    await ready(h.app);
    const f = await fixture(h);
    const rows = {
      payout_batches: batch(f.owner.app_id),
      payout_batch_items: item(f),
      payout_attempts: attempt(f),
      payout_watermarks: watermark(f.owner.app_id),
    };
    const row = rows[table];
    expect(await sqlState(insert(writer(h, table), table, row))).toBe('ok');
    const before = await stored(h.app, table, row['id']);
    expect(before).toHaveLength(1);
    for (const role of ROLES) {
      const db = h.roles[role];
      if (role === 'couli_maint')
        expect(await sqlState(stored(db, table, row['id']))).toBe('42501');
      else expect(await stored(db, table, row['id'])).toEqual(before);
      if (db !== writer(h, table)) {
        expect(await sqlState(insert(db, table, { ...row, id: randomUUID() })), role).toBe('42501');
      }
      expect(
        await sqlState(
          sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE id = ${row['id']}`.execute(db),
        ),
        role,
      ).toBe('42501');
      expect(await sqlState(sql`TRUNCATE ${sql.table(`app.${table}`)}`.execute(db)), role).toBe(
        '42501',
      );
      if (table !== 'payout_attempts' || role !== 'couli_payout') {
        const values =
          table === 'payout_attempts' ? { result: 'success' } : { app_id: row['app_id'] };
        expect(await sqlState(update(db, table, row['id'], values)), role).toBe('42501');
      }
      expect(await stored(h.app, table, row['id'])).toEqual(before);
    }
  });
}

for (const table of ['payout_batch_items', 'payout_watermarks'] as const) {
  it(`[AC-B2-06a#17] ${table} 安装无条件行级 BEFORE UPDATE/DELETE 保护且沿用 23001 拒绝函数`, async () => {
    await ready(h.app);
    const triggers = await sql<{
      enabled: string;
      kind: number;
      columns: number[];
      guard: string;
      condition: string | null;
      args: number;
    }>`SELECT t.tgenabled::text AS enabled, t.tgtype::integer AS kind,
      ARRAY(SELECT unnest(t.tgattr)::integer) AS columns,
      t.tgfoid::regprocedure::text AS guard, pg_get_expr(t.tgqual, t.tgrelid) AS condition,
      t.tgnargs::integer AS args
      FROM pg_trigger t WHERE t.tgrelid = to_regclass(${`app.${table}`}) AND NOT t.tgisinternal`.execute(
      h.app,
    );
    for (const event of [16, 8]) {
      expect(
        triggers.rows.some(
          (t) =>
            /^[OA]$/.test(t.enabled) &&
            (t.kind & 3) === 3 &&
            (t.kind & event) === event &&
            t.columns.length === 0 &&
            t.guard === 'app.reject_update_delete()' &&
            t.condition === null &&
            t.args === 0,
        ),
        `${table}/${event === 16 ? 'UPDATE' : 'DELETE'}`,
      ).toBe(true);
    }
    // Business-role ACLs reject first (42501). Catalog binding verifies the second barrier
    // without elevating to migrator/superuser or granting temporary UPDATE/DELETE privileges.
    const fn = await sql<{ body: string }>`SELECT prosrc AS body FROM pg_proc
      WHERE oid = to_regprocedure('app.reject_update_delete()')`.execute(h.app);
    expect(fn.rows).toHaveLength(1);
    expect(fn.rows[0]?.body).toMatch(/RAISE\s+EXCEPTION/i);
    expect(fn.rows[0]?.body).toMatch(/ERRCODE\s*=\s*'(restrict_violation|23001)'/i);
  });
}

it('[AC-B2-06a#18] attempts 的行级更新与删除守卫启用且不按更新列缩小范围', async () => {
  await ready(h.app);
  const triggers = await sql<{
    enabled: string;
    kind: number;
    columns: number[];
    condition: string | null;
  }>`SELECT t.tgenabled::text AS enabled, t.tgtype::integer AS kind,
    ARRAY(SELECT unnest(t.tgattr)::integer) AS columns, pg_get_expr(t.tgqual, t.tgrelid) AS condition
    FROM pg_trigger t WHERE t.tgrelid = to_regclass('app.payout_attempts') AND NOT t.tgisinternal`.execute(
    h.app,
  );
  for (const event of [16, 8]) {
    expect(
      triggers.rows.some(
        (t) =>
          /^[OA]$/.test(t.enabled) &&
          (t.kind & 3) === 3 &&
          (t.kind & event) === event &&
          t.columns.length === 0 &&
          t.condition === null,
      ),
      event === 16 ? 'UPDATE' : 'DELETE',
    ).toBe(true);
  }
});

it('[AC-B2-06a#19] attempts 不可改身份、请求、归属和时刻，混入合法结果字段也拒绝且不损坏原行', async () => {
  await ready(h.app);
  const f = await fixture(h);
  const other = await fixture(h);
  const row = attempt(f);
  const db = h.roles.couli_payout;
  await insert(db, 'payout_attempts', row);
  const before = await stored(h.app, 'payout_attempts', row['id']);
  for (const values of [
    { id: randomUUID() },
    { app_id: other.owner.app_id },
    { withdrawal_id: other.wd['id'] },
    { kind: 'query' },
    { request: '{"changed":true}' },
    { at: new Date('2032-06-16T02:00:00Z') },
    { at: AT },
  ]) {
    expect(
      await sqlState(update(db, 'payout_attempts', row['id'], { ...values, result: 'success' })),
    ).toBe('42501');
    expect(await stored(h.app, 'payout_attempts', row['id'])).toEqual(before);
  }
  expect(
    await sqlState(
      update(db, 'payout_attempts', row['id'], { result: 'unknown', latency_ms: 10000 }),
    ),
  ).toBe('ok');
  expect((await stored(h.app, 'payout_attempts', row['id']))[0]).toMatchObject({
    result: 'unknown',
  });
});
