// B2-05m rule tests (规划/08 BR-WDR-26; 规划/02 §16.3; db/AGENTS.md rules 1–4, 11; task §9.1): the
// migration that adds app.withdrawals.review_overdue_at. withdrawals is a funds table (prefix
// `withdraw` in tools/ci/lint-migrations.ts), so the migration passes the gate as the CLI checks it,
// only adds the column and its couli_app column grant (no backfill, no default, no constraint, index
// or trigger change, no grant to another role), and the variants without a SET LOCAL timeout or with
// a DROP / RENAME / retype smuggled in are refused. The file is found by name: its number is assigned
// when it lands (D10-116).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import {
  APPROVED_GUARD_CHANGES,
  FROZEN_MIGRATIONS,
  checkMigration,
  checkTimeouts,
  isFundsTable,
  selectMigrations,
  type MigrationContext,
} from '../../../../tools/ci/lint-migrations.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MIGRATIONS = join(ROOT, 'db/migrations');
const MIGRATION_SUFFIX = '_withdrawals-review-overdue-at.sql';
const FUNDS = 'funds or attribution table withdrawals';

interface Migration {
  file: string;
  sql: string;
  context: MigrationContext;
}
function read(name: string): string {
  return readFileSync(join(MIGRATIONS, name), 'utf8');
}
// Every case starts here: before the migration exists the case fails on this assertion.
function migration(): Migration {
  const names = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const found = names.filter((name) => name.endsWith(MIGRATION_SUFFIX));
  expect(found, `db/migrations/*${MIGRATION_SUFFIX}`).toHaveLength(1);
  const file = found[0] ?? '';
  return {
    file,
    sql: read(file),
    context: {
      approved: false,
      schemaSql: read('../schema.sql'),
      migrationsSql: names.filter((name) => name < file).map(read),
    },
  };
}
function messages(m: Migration, sql: string): string[] {
  return checkMigration(`db/migrations/${m.file}`, sql, m.context).map((p) => p.message);
}
/** The SQL statements of a migration, comments removed, whitespace collapsed, `;` dropped. */
function statements(sql: string): string[] {
  return sql
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.replaceAll(/\s+/g, ' ').trim())
    .filter((s) => s !== '');
}
const TABLE = String.raw`(?:ONLY\s+)?"?app"?\s*\.\s*"?withdrawals"?`;
const KINDS: ReadonlyArray<readonly [string, RegExp]> = [
  ['lock_timeout', /^SET LOCAL lock_timeout\s*(?:=|TO)\s*'5s'$/i],
  ['statement_timeout', /^SET LOCAL statement_timeout\s*(?:=|TO)\s*'30s'$/i],
  [
    'add column',
    new RegExp(
      String.raw`^ALTER TABLE ${TABLE} ADD (?:COLUMN )?"?review_overdue_at"? (?:timestamptz|timestamp with time zone)(?: NULL)?$`,
      'i',
    ),
  ],
  [
    'grant',
    new RegExp(
      String.raw`^GRANT UPDATE\s*\(\s*"?review_overdue_at"?\s*\) ON (?:TABLE )?${TABLE} TO "?couli_app"?$`,
      'i',
    ),
  ],
  // A column comment is harmless; nothing else is allowed.
  [
    'comment',
    /^COMMENT ON COLUMN "?app"?\s*\.\s*"?withdrawals"?\s*\.\s*"?review_overdue_at"? IS /i,
  ],
];
function kind(statement: string): string {
  return KINDS.find(([, pattern]) => pattern.test(statement))?.[0] ?? `other: ${statement}`;
}

it('[BR-WDR-26] 加 review_overdue_at 的迁移只有一个，按名字找到，是门禁要查的新迁移，按 CLI 的上下文通过门禁', () => {
  const m = migration();
  expect(m.file).toMatch(/^\d{4}_withdrawals-review-overdue-at\.sql$/);
  expect(isFundsTable('app.withdrawals')).toBe(true);
  expect(Object.keys(FROZEN_MIGRATIONS)).not.toContain(m.file);
  // 只加列、不动资金表保护对象：不需要登记 APPROVED_GUARD_CHANGES。
  expect(Object.keys(APPROVED_GUARD_CHANGES)).not.toContain(m.file);
  const names = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'));
  expect(selectMigrations(names).lint).toContain(m.file);
  expect(selectMigrations(names).badNames).not.toContain(m.file);
  expect(m.sql.split('\n')[0]?.trim()).toBe('-- Up Migration');
  expect(m.sql).not.toMatch(/squawk-ignore/);
  expect(checkMigration(`db/migrations/${m.file}`, m.sql, m.context)).toEqual([]);
  expect(checkTimeouts(`db/migrations/${m.file}`, m.sql)).toEqual([]);
});

it('[BR-WDR-26] 迁移只做两件事：加可空无缺省的 timestamptz 列、把它的 UPDATE 授给 couli_app；不回填、不加约束索引、不给别的角色写权', () => {
  const m = migration();
  const kinds = statements(m.sql).map(kind);
  expect(kinds.slice(0, 2).sort(), 'two SET LOCAL first').toEqual([
    'lock_timeout',
    'statement_timeout',
  ]);
  expect(
    kinds.slice(2).filter((k) => k !== 'comment'),
    'then ADD COLUMN, then GRANT',
  ).toEqual(['add column', 'grant']);
  expect(kinds.filter((k) => k === 'comment').length).toBeLessThanOrEqual(1);
  // The column comment's text may say anything; every other statement is scanned.
  const code = statements(m.sql)
    .filter((s) => kind(s) !== 'comment')
    .join(';\n');
  for (const word of [
    /\bDEFAULT\b/i,
    /\bNOT\s+NULL\b/i,
    /\bCHECK\b/i,
    /\bCONSTRAINT\b/i,
    /\bINDEX\b/i,
    /\bTRIGGER\b/i,
    /\bDROP\b/i,
    /\bRENAME\b/i,
    /\bREVOKE\b/i,
    /\bUPDATE\s+"?app"?\s*\./i,
    /\bINSERT\b/i,
    /\bcouli_(?:payout|readonly|maint)\b/i,
  ]) {
    expect(code, String(word)).not.toMatch(word);
  }
});

it('[BR-WDR-26] 迁移头注释照 0104 的格式：Task、Compatibility、Grants、Recovery、Timeouts', () => {
  const m = migration();
  const lines = m.sql.split('\n');
  const firstSql = lines.findIndex((line) => line.trim() !== '' && !line.trim().startsWith('--'));
  expect(firstSql).toBeGreaterThan(1);
  const header = lines.slice(0, firstSql).join('\n');
  expect(header).toMatch(/BR-WDR-26/);
  for (const field of [/Task B2-05m\b/, /Compatibility:/, /Grants\b/, /Recovery:/, /Timeouts:/]) {
    expect(header, String(field)).toMatch(field);
  }
});

it('[BR-WDR-26] 去掉任一 SET LOCAL 超时、或把它设成 0 的变体被门禁拒绝', () => {
  const m = migration();
  expect(checkTimeouts(m.file, m.sql)).toEqual([]);
  for (const setting of ['lock_timeout', 'statement_timeout']) {
    const line = new RegExp(String.raw`^[ \t]*SET\s+LOCAL\s+${setting}\b[^\n]*\n?`, 'im');
    const without = m.sql.replace(line, '');
    expect(without, `without ${setting}`).not.toBe(m.sql);
    expect(checkTimeouts(m.file, without), `without ${setting}`).not.toEqual([]);
    const zero = m.sql.replace(line, `SET LOCAL ${setting} = '0';\n`);
    expect(checkTimeouts(m.file, zero), `${setting} = 0`).not.toEqual([]);
  }
  const reset = `${m.sql}\nRESET lock_timeout;\n`;
  expect(checkTimeouts(m.file, reset), 'RESET').not.toEqual([]);
});

it.each([
  ['DROP 新列', 'ban-drop-column', 'ALTER TABLE app.withdrawals DROP COLUMN review_overdue_at;'],
  ['DROP 既有列', 'ban-drop-column', 'ALTER TABLE app.withdrawals DROP COLUMN reject_note;'],
  [
    '改类型',
    'changing-column-type',
    'ALTER TABLE app.withdrawals ALTER COLUMN review_overdue_at TYPE timestamp;',
  ],
  [
    'RENAME 列',
    'renaming-column',
    'ALTER TABLE app.withdrawals RENAME COLUMN review_overdue_at TO overdue_at;',
  ],
])(
  '[BR-WDR-26] 迁移里加上 %s 的变体被拒：withdrawals 是资金表，语句级 squawk-ignore 不放行',
  (_label, rule, statement) => {
    const m = migration();
    const variant = `${m.sql}\n-- 夹具：试图收缩。\n-- squawk-ignore ${rule}\n${statement}\n`;
    const refusal = expect.stringContaining(`squawk-ignore on a statement of ${FUNDS}`);
    for (const approved of [false, true]) {
      expect(
        checkMigration(`db/migrations/${m.file}`, variant, { ...m.context, approved }).map(
          (p) => p.message,
        ),
        `approved=${String(approved)}`,
      ).toEqual(expect.arrayContaining([refusal]));
    }
  },
);

it('[BR-WDR-26] 迁移里加上 DROP COLUMN … CASCADE 或只删不重建既有约束、索引的变体被拒', () => {
  const m = migration();
  expect(
    messages(m, `${m.sql}\nALTER TABLE app.withdrawals DROP COLUMN review_overdue_at CASCADE;\n`),
  ).toEqual(expect.arrayContaining([expect.stringContaining('DROP … CASCADE is not accepted')]));
  expect(
    messages(m, `${m.sql}\nALTER TABLE app.withdrawals DROP CONSTRAINT withdrawals_paid_check;\n`),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining(`constraint withdrawals_paid_check on ${FUNDS} may not be dropped`),
    ]),
  );
  expect(messages(m, `${m.sql}\nDROP INDEX app.withdrawals_open_idx;\n`)).toEqual(
    expect.arrayContaining([
      expect.stringContaining(`index withdrawals_open_idx on ${FUNDS} may not be dropped`),
    ]),
  );
});
