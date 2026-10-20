import { readFileSync, readdirSync } from 'node:fs';

import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { SHAPES, TABLES, close, open, ready, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open();
});
afterAll(async () => {
  await close(h);
});

it('[AC-CT-25b#1] 两表字段、类型、可空性与默认值符合 §9.2', async () => {
  await ready(h.app);
  for (const table of TABLES) {
    const columns = await sql<{
      name: string;
      type: string;
      nullable: boolean;
      default_value: string | null;
    }>`SELECT column_name AS name, udt_name AS type, is_nullable = 'YES' AS nullable,
      column_default AS default_value FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = ${table} ORDER BY column_name`.execute(h.app);
    expect(columns.rows).toEqual(
      Object.entries(SHAPES[table])
        .map(([name, [type, nullable, default_value]]) => ({ name, type, nullable, default_value }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }
});

it('[AC-CT-25b#2] 联合主键无额外全局唯一限制，邀请查询与顺延索引保留列顺序', async () => {
  await ready(h.app);
  for (const table of TABLES) {
    const key = ['app_id', table === 'invite_rewards' ? 'invitee_id' : 'period'];
    const primary = await sql<{ cols: string[]; valid: boolean }>`SELECT
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS cols,
      c.convalidated AS valid FROM pg_constraint c
      WHERE c.conrelid = to_regclass(${`app.${table}`}) AND c.contype = 'p'`.execute(h.app);
    expect(primary.rows).toEqual([{ cols: key, valid: true }]);
    const indexes = await sql<{
      cols: string[];
      unique: boolean;
      predicate: string | null;
      valid: boolean;
      ready: boolean;
    }>`SELECT ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true)
        FROM generate_series(1, i.indnkeyatts) k ORDER BY k) AS cols,
      i.indisunique AS unique, pg_get_expr(i.indpred, i.indrelid) AS predicate,
      i.indisvalid AS valid, i.indisready AS ready
      FROM pg_index i WHERE i.indrelid = to_regclass(${`app.${table}`})`.execute(h.app);
    expect(indexes.rows.filter((i) => i.unique)).toEqual([
      { cols: key, unique: true, predicate: null, valid: true, ready: true },
    ]);
    if (table === 'invite_rewards') {
      for (const cols of [
        ['app_id', 'inviter_id'],
        ['app_id', 'status', 'triggered_at'],
      ]) {
        expect(indexes.rows).toContainEqual({
          cols,
          unique: false,
          predicate: null,
          valid: true,
          ready: true,
        });
      }
    }
  }
  // users_pkey(id) prevents two users with the same UUID across apps. The catalog assertion
  // above tests the reward key's app scope without weakening the existing users FK/PK.
  // TODO(规划/11 §2.3): 同 invitee UUID 跨 app 双行实测 — blocked on users.id 全局主键。
});

it('[AC-CT-25b#3] 五条外键含 app_id、指向指定父键且禁止级联', async () => {
  await ready(h.app);
  const foreign = await sql<{
    cols: string[];
    target: string;
    target_cols: string[];
    on_update: string;
    on_delete: string;
    valid: boolean;
  }>`SELECT ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS cols,
    c.confrelid::regclass::text AS target,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord) AS target_cols,
    c.confupdtype::text AS on_update, c.confdeltype::text AS on_delete, c.convalidated AS valid
    FROM pg_constraint c WHERE c.conrelid = to_regclass('app.invite_rewards')
      AND c.contype = 'f'`.execute(h.app);
  expect(foreign.rows).toHaveLength(5);
  for (const [column, target, targetColumn] of [
    ['invitee_id', 'users', 'id'],
    ['inviter_id', 'users', 'id'],
    ['trigger_order_id', 'order_keys', 'order_id'],
    ['inviter_voucher_id', 'ledger_vouchers', 'id'],
    ['invitee_voucher_id', 'ledger_vouchers', 'id'],
  ]) {
    const found = foreign.rows.find((fk) => fk.cols.includes(column!));
    expect(found).toMatchObject({
      cols: ['app_id', column],
      target: `app.${target}`,
      target_cols: ['app_id', targetColumn],
      valid: true,
    });
    expect(['a', 'r']).toContain(found?.on_update);
    expect(['a', 'r']).toContain(found?.on_delete);
  }
});

it('[AC-CT-25b#4] 约束与索引显式具名，创建两表和授权位于同一迁移且不绑定编号', async () => {
  await ready(h.app);
  const directory = new URL('../../../../../db/migrations/', import.meta.url);
  const candidates = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .map((name) =>
      readFileSync(new URL(name, directory), 'utf8').replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ''),
    )
    .filter((source) => /CREATE\s+TABLE\s+app\.invite_rewards\s*\(/i.test(source));
  expect(candidates).toHaveLength(1);
  const source = candidates[0]!;
  for (const table of TABLES) {
    expect(source).toMatch(new RegExp(`CREATE\\s+TABLE\\s+app\\.${table}\\s*\\(`, 'i'));
    for (const role of ['couli_app', 'couli_readonly']) {
      expect(source).toMatch(
        new RegExp(
          `GRANT\\s+[^;]+\\s+ON\\s+(?:TABLE\\s+)?app\\.${table}\\s+TO\\s+${role}\\s*;`,
          'i',
        ),
      );
    }
    const constraints = await sql<{ name: string; kind: string; valid: boolean }>`
      SELECT conname::text AS name, contype::text AS kind, convalidated AS valid
      FROM pg_constraint WHERE conrelid = to_regclass(${`app.${table}`})
        AND contype IN ('p', 'u', 'c', 'f')`.execute(h.app);
    expect(constraints.rows.some((c) => c.kind === 'c')).toBe(true);
    for (const constraint of constraints.rows) {
      expect(constraint.valid).toBe(true);
      expect(source, constraint.name).toMatch(
        new RegExp(`\\bCONSTRAINT\\s+"?${constraint.name}"?\\s`, 'i'),
      );
    }
    const indexes = await sql<{ name: string }>`SELECT c.relname::text AS name
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = to_regclass(${`app.${table}`}) AND NOT EXISTS
        (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.contype IN ('p', 'u'))`.execute(
      h.app,
    );
    for (const index of indexes.rows) {
      expect(source).toMatch(
        new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+"?${index.name}"?\\s`, 'i'),
      );
    }
  }
});
