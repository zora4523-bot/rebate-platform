// B1-05p rule tests (编排裁定 D10-452 ②; db/AGENTS.md 迁移规则 1、2、4): both tables come from one new
// migration that also carries their grants, merged migrations stay untouched, and the generated
// snapshot db/schema.sql has the tables, keys, the read index and the grants. The migration number
// is the orchestrator's, so no file name here. Static file checks, no database.
import { readFileSync, readdirSync } from 'node:fs';

import { expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);
// The last migration merged before this task (main at 21ca9c1f9).
const LAST_MERGED = 104;
const CREATES_POOLS = /create\s+table\s+(?:if\s+not\s+exists\s+)?app\.product_pools\b/i;
const CREATES_ITEMS = /create\s+table\s+(?:if\s+not\s+exists\s+)?app\.pool_items\b/i;
const WRITER = ['DELETE', 'INSERT', 'SELECT', 'UPDATE'];

function migrations(): { name: string; text: string }[] {
  return readdirSync(new URL('db/migrations/', ROOT))
    .filter((name) => /^\d{4}_[a-z0-9-]+\.sql$/.test(name))
    .sort()
    .map((name) => ({ name, text: readFileSync(new URL(`db/migrations/${name}`, ROOT), 'utf8') }));
}
function creating(): { name: string; text: string }[] {
  return migrations().filter((m) => CREATES_POOLS.test(m.text) || CREATES_ITEMS.test(m.text));
}
// role -> privileges granted on `table` by the GRANT statements of a SQL text.
function grants(text: string, table: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  const pattern = /grant\s+([a-z\s,]+?)\s+on\s+(?:table\s+)?([a-z_.,\s]+?)\s+to\s+([^;]+);/gi;
  for (const [, privileges = '', tables = '', roles = ''] of text.matchAll(pattern)) {
    if (!tables.split(',').some((t) => t.trim().toLowerCase() === table)) continue;
    for (const role of roles.split(',').map((r) => r.trim().toLowerCase())) {
      const list = (found[role] ??= []);
      for (const p of privileges.split(',')) list.push(p.trim().toUpperCase());
      list.sort();
    }
  }
  return found;
}
function tableBody(schema: string, table: string): string[] {
  const pattern = `\\nCREATE TABLE app\\.${table} \\(\\n([\\s\\S]*?)\\n\\);\\n`;
  const found = new RegExp(pattern).exec(schema);
  expect(found, `CREATE TABLE app.${table}`).not.toBeNull();
  return (found?.[1] ?? '').split('\n').map((line) => line.trim().replace(/,$/, ''));
}

it('[BR-PROD-08] 只新增迁移：恰有一个编号在已合并迁移之后的新迁移同时建两张表，0001～0104 不碰它们', () => {
  const found = creating();
  expect(found.map((m) => m.name)).toHaveLength(1);
  for (const { name, text } of found) {
    expect(Number(name.slice(0, 4)), name).toBeGreaterThan(LAST_MERGED);
    expect(text.split('\n')[0]?.trim(), name).toBe('-- Up Migration');
    expect(text, name).toMatch(CREATES_POOLS);
    expect(text, name).toMatch(CREATES_ITEMS);
  }
  const merged = migrations().filter((m) => Number(m.name.slice(0, 4)) <= LAST_MERGED);
  expect(merged.length).toBeGreaterThanOrEqual(LAST_MERGED);
  expect(
    merged.filter((m) => /\bapp\.(?:product_pools|pool_items)\b/i.test(m.text)).map((m) => m.name),
  ).toEqual([]);
});

it('[BR-PROD-08] 授权写在建表的同一迁移：couli_app 增删改查，couli_readonly 只读，couli_payout、couli_maint 不授权', () => {
  const found = creating();
  expect(found).toHaveLength(1);
  for (const { name, text } of found) {
    for (const table of ['app.product_pools', 'app.pool_items']) {
      expect(grants(text, table), `${name}/${table}`).toEqual({
        couli_app: WRITER,
        couli_readonly: ['SELECT'],
      });
    }
  }
});

it('[BR-PROD-08] schema 快照 db/schema.sql 含两张表、主键、不级联的复合外键、读路径索引与授权', () => {
  const schema = readFileSync(new URL('db/schema.sql', ROOT), 'utf8');
  expect(tableBody(schema, 'product_pools')).toEqual(
    expect.arrayContaining([
      'app_id text NOT NULL',
      'pool_id uuid NOT NULL',
      'name text NOT NULL',
      'status text NOT NULL',
      'revision bigint DEFAULT 0 NOT NULL',
      'created_by uuid NOT NULL',
      'created_at timestamp with time zone DEFAULT now() NOT NULL',
      'updated_at timestamp with time zone DEFAULT now() NOT NULL',
    ]),
  );
  expect(tableBody(schema, 'pool_items')).toEqual(
    expect.arrayContaining([
      'app_id text NOT NULL',
      'pool_id uuid NOT NULL',
      'product_key text NOT NULL',
      'platform text NOT NULL',
      'raw_item_id text NOT NULL',
      'title text NOT NULL',
      'image text',
      'price_fen bigint NOT NULL',
      'coupon_fen bigint NOT NULL',
      'final_price_fen bigint NOT NULL',
      'quoted_at timestamp with time zone NOT NULL',
      'status text NOT NULL',
      'sort integer DEFAULT 0 NOT NULL',
      'start_at timestamp with time zone',
      'end_at timestamp with time zone',
      'invalid_reason text',
      'created_by uuid NOT NULL',
      'created_at timestamp with time zone DEFAULT now() NOT NULL',
      'updated_at timestamp with time zone DEFAULT now() NOT NULL',
    ]),
  );
  expect(schema).toMatch(
    /ALTER TABLE ONLY app\.product_pools\s+ADD CONSTRAINT \w+ PRIMARY KEY \(app_id, pool_id\);/,
  );
  expect(schema).toMatch(
    /ALTER TABLE ONLY app\.pool_items\s+ADD CONSTRAINT \w+ PRIMARY KEY \(app_id, pool_id, product_key\);/,
  );
  expect(schema).toMatch(
    /ALTER TABLE ONLY app\.pool_items\s+ADD CONSTRAINT \w+ FOREIGN KEY \(app_id, pool_id\) REFERENCES app\.product_pools\(app_id, pool_id\);/,
  );
  expect(schema).toMatch(
    /CREATE INDEX \w+ ON app\.pool_items USING btree \(app_id, pool_id, sort, product_key\);/,
  );
  for (const table of ['app.product_pools', 'app.pool_items']) {
    expect(grants(schema, table), table).toEqual({ couli_app: WRITER, couli_readonly: ['SELECT'] });
  }
});
