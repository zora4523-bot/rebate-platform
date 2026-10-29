// B1-15v rule tests (编排裁定 D10-426; db/AGENTS.md 迁移规则 1、2、4): the table comes from one new
// migration that also carries its grants, merged migrations stay untouched, and the generated
// snapshot db/schema.sql has the table and its grants. Static file checks, no database.
import { readFileSync, readdirSync } from 'node:fs';

import { expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);
// The last migration merged before this task (main at 264361c67).
const LAST_MERGED = 100;
const CREATES = /create\s+table\s+(?:if\s+not\s+exists\s+)?app\.share_materials\b/i;

function migrations(): { name: string; text: string }[] {
  return readdirSync(new URL('db/migrations/', ROOT))
    .filter((name) => /^\d{4}_[a-z0-9-]+\.sql$/.test(name))
    .sort()
    .map((name) => ({ name, text: readFileSync(new URL(`db/migrations/${name}`, ROOT), 'utf8') }));
}
// role -> privileges granted on app.share_materials by the GRANT statements of a SQL text.
function grants(text: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  const pattern = /grant\s+([a-z\s,]+?)\s+on\s+(?:table\s+)?app\.share_materials\s+to\s+([^;]+);/gi;
  for (const [, privileges = '', roles = ''] of text.matchAll(pattern)) {
    for (const role of roles.split(',').map((r) => r.trim().toLowerCase())) {
      const list = (found[role] ??= []);
      for (const p of privileges.split(',')) list.push(p.trim().toUpperCase());
      list.sort();
    }
  }
  return found;
}

it('[AC-B1-15v#5] 只新增迁移：恰有一个编号在已合并迁移之后的新迁移建 app.share_materials，0001～0100 不出现本表', () => {
  const all = migrations();
  const creating = all.filter((m) => CREATES.test(m.text));
  expect(creating.map((m) => m.name)).toHaveLength(1);
  for (const { name, text } of creating) {
    expect(Number(name.slice(0, 4)), name).toBeGreaterThan(LAST_MERGED);
    expect(text.split('\n')[0]?.trim(), name).toBe('-- Up Migration');
  }
  const merged = all.filter((m) => Number(m.name.slice(0, 4)) <= LAST_MERGED);
  expect(merged.length).toBeGreaterThanOrEqual(LAST_MERGED);
  expect(merged.filter((m) => /share_materials/i.test(m.text)).map((m) => m.name)).toEqual([]);
});

it('[AC-B1-15v#4] 授权写在建表的同一迁移：couli_app 只给 SELECT、INSERT，不给 UPDATE、DELETE', () => {
  const creating = migrations().filter((m) => CREATES.test(m.text));
  expect(creating).toHaveLength(1);
  for (const { name, text } of creating) {
    const granted = grants(text);
    expect(granted['couli_app'], name).toEqual(['INSERT', 'SELECT']);
    for (const role of ['couli_payout', 'couli_maint'])
      expect(granted[role], `${name}/${role}`).toBeUndefined();
  }
});

it('[AC-B1-15v#5] schema 快照 db/schema.sql 含本表、主键、到 app.links 的外键与授权', () => {
  const schema = readFileSync(new URL('db/schema.sql', ROOT), 'utf8');
  const table = /\nCREATE TABLE app\.share_materials \(\n([\s\S]*?)\n\);\n/.exec(schema);
  expect(table, 'CREATE TABLE app.share_materials').not.toBeNull();
  const body = table?.[1] ?? '';
  for (const column of [
    /^\s+app_id text NOT NULL,?$/m,
    /^\s+link_id uuid NOT NULL,?$/m,
    /^\s+share_url text NOT NULL,?$/m,
    /^\s+tpwd text,?$/m,
    /^\s+created_at timestamp with time zone DEFAULT now\(\) NOT NULL,?$/m,
  ]) {
    expect(body, String(column)).toMatch(column);
  }
  expect(schema).toMatch(
    /ALTER TABLE ONLY app\.share_materials\s+ADD CONSTRAINT \w+ PRIMARY KEY \(link_id\);/,
  );
  expect(schema).toMatch(
    /ALTER TABLE ONLY app\.share_materials\s+ADD CONSTRAINT \w+ FOREIGN KEY \([a-z_, ]*\blink_id\b[a-z_, ]*\) REFERENCES app\.links\([a-z_, ]*\blink_id\b[a-z_, ]*\);/,
  );
  expect(grants(schema)).toEqual({ couli_app: ['INSERT', 'SELECT'], couli_readonly: ['SELECT'] });
});
