// B2-04lb rule tests (money r1 S0; 编排裁定 D10-483; db/AGENTS.md 迁移规则): answered_at comes from
// one new migration that only adds the column (timestamptz, NULL, no default, no backfill) and
// grants at most UPDATE (answered_at) to couli_app; merged migrations stay untouched; the
// generated snapshot db/schema.sql has the column and keeps main's grants. Static file checks, no
// database.
import { readFileSync, readdirSync } from 'node:fs';

import { expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);
// The last migration on this branch before the task (0101_share-materials.sql).
const LAST_MERGED = 101;
const MENTIONS = /\banswered_at\b/i;
const ADDS =
  /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?app\.order_rights\s+add\s+column\s+(?:if\s+not\s+exists\s+)?answered_at\s+([^,;]+)[,;]/i;

function migrations(): { name: string; text: string }[] {
  return readdirSync(new URL('db/migrations/', ROOT))
    .filter((name) => /^\d{4}_[a-z0-9-]+\.sql$/.test(name))
    .sort()
    .map((name) => ({ name, text: readFileSync(new URL(`db/migrations/${name}`, ROOT), 'utf8') }));
}

/** SQL text without `--` comments (prose may name statements it does not run). */
function code(text: string): string {
  return text.replace(/--[^\n]*/g, '');
}

/**
 * The GRANT / REVOKE statements on app.order_rights, lower case, whitespace collapsed, no space
 * around parentheses, `on table` written `on`.
 */
function grantsOn(text: string): string[] {
  const pattern = /\b(?:grant|revoke)\s[^;]*?\bon\s+(?:table\s+)?app\.order_rights\b[^;]*;/gi;
  return [...code(text).matchAll(pattern)].map(([statement = '']) =>
    statement
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\s*\(\s*/g, '(')
      .replace(/\s*\)/g, ')')
      .replace(/ on table /g, ' on '),
  );
}

it('[AC-B2-04lb#33] D10-483 只新增迁移：恰有一个编号在 0101 之后的新迁移提到 answered_at，0001～0101 不出现；该迁移加列为 timestamptz、可空、无默认值', () => {
  const all = migrations();
  const adding = all.filter((m) => MENTIONS.test(code(m.text)));
  expect(adding.map((m) => m.name)).toHaveLength(1);
  for (const { name, text } of adding) {
    expect(Number(name.slice(0, 4)), name).toBeGreaterThan(LAST_MERGED);
    expect(text.split('\n')[0]?.trim(), name).toBe('-- Up Migration');
    const added = ADDS.exec(code(text));
    expect(added, `${name}: ALTER TABLE app.order_rights ADD COLUMN answered_at`).not.toBeNull();
    // An explicit NULL is the same column; anything else (DEFAULT, NOT NULL, …) is not.
    const definition = (added?.[1] ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .replace(/ null$/, '');
    expect(['timestamptz', 'timestamp with time zone'], definition).toContain(definition);
  }
  const merged = all.filter((m) => Number(m.name.slice(0, 4)) <= LAST_MERGED);
  expect(merged.length).toBeGreaterThanOrEqual(LAST_MERGED);
  expect(merged.filter((m) => MENTIONS.test(m.text)).map((m) => m.name)).toEqual([]);
});

it('[AC-B2-04lb#34] D10-483 不回填、不扩权：新迁移不 UPDATE / DELETE app.order_rights 的存量行，不设默认值或 NOT NULL；对该表的授权语句至多一条 GRANT UPDATE(answered_at) TO couli_app，没有 REVOKE', () => {
  const adding = migrations().filter((m) => MENTIONS.test(code(m.text)));
  expect(adding).toHaveLength(1);
  for (const { name, text } of adding) {
    const sqlText = code(text);
    expect(sqlText, name).not.toMatch(/\bupdate\s+(?:only\s+)?app\.order_rights\b/i);
    expect(sqlText, name).not.toMatch(/\bdelete\s+from\s+(?:only\s+)?app\.order_rights\b/i);
    expect(sqlText, name).not.toMatch(/\banswered_at\b[^;]*\bset\s+(?:default|not\s+null)\b/i);
    expect(sqlText, name).not.toMatch(/\balter\s+column\s+answered_at\b/i);
    const statements = grantsOn(text);
    expect(statements.length, name).toBeLessThanOrEqual(1);
    for (const statement of statements) {
      expect(statement, name).toBe('grant update(answered_at) on app.order_rights to couli_app;');
    }
  }
});

it('[AC-B2-04lb#35] D10-483 schema 快照 db/schema.sql：order_rights 含 answered_at timestamptz 可空列；表级授权与主干一致，另至多一条 couli_app 的 UPDATE(answered_at) 列级授权', () => {
  const schema = readFileSync(new URL('db/schema.sql', ROOT), 'utf8');
  const table = /\nCREATE TABLE app\.order_rights \(\n([\s\S]*?)\n\);\n/.exec(schema);
  expect(table, 'CREATE TABLE app.order_rights').not.toBeNull();
  expect(table?.[1] ?? '').toMatch(/^\s+answered_at timestamp with time zone,?$/m);
  const statements = grantsOn(schema).filter(
    (s) => s !== 'grant update(answered_at) on app.order_rights to couli_app;',
  );
  expect(statements.sort()).toEqual([
    'grant select on app.order_rights to couli_readonly;',
    'grant select,insert,update on app.order_rights to couli_app;',
  ]);
});
