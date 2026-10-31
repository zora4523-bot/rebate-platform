// B2-08a rule tests (规划/08 BR-WDR-20; 规划/02 §16.3; db/AGENTS.md rule 11; 编排裁定 D10-456 ④):
// app.tax_ytd holds the yearly tax totals of withdrawals, so tools/ci/lint-migrations.ts treats it as a
// funds table by its whole name (no prefix matches tax_): no squawk-ignore on its statements, no SET
// SCHEMA, its constraints and indexes are named and never only dropped. The migration that creates it
// passes the gate as the CLI would check it.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import {
  FROZEN_MIGRATIONS,
  FUNDS_TABLE_NAMES,
  checkMigration,
  checkTimeouts,
  isFundsTable,
  selectMigrations,
  type MigrationContext,
} from '../../../../tools/ci/lint-migrations.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MIGRATIONS = join(ROOT, 'db/migrations');
const FILE = '0103_tax-ytd-guard.sql';
const FUNDS = 'funds or attribution table tax_ytd';
// A stand-in history: the table with a named key and index, as the B2-08a migration declares them.
const HISTORY = `CREATE TABLE app.tax_ytd (
  id uuid NOT NULL,
  app_id text NOT NULL,
  user_id uuid NOT NULL,
  year integer NOT NULL,
  income_type text NOT NULL,
  identity_hmac text NOT NULL,
  cum_income_fen bigint NOT NULL DEFAULT 0,
  CONSTRAINT tax_ytd_pkey PRIMARY KEY (id),
  CONSTRAINT tax_ytd_identity_key UNIQUE (app_id, user_id, year, income_type, identity_hmac),
  CONSTRAINT tax_ytd_cum_income_fen_check CHECK (cum_income_fen >= 0)
);
CREATE INDEX tax_ytd_user_year_idx ON app.tax_ytd (app_id, user_id, year);
`;
const CONTEXT: MigrationContext = { schemaSql: '', migrationsSql: [HISTORY], approved: false };

// The same SQL on an ordinary table: what tax_ytd would get without the funds-table listing.
function ordinary(sql: string): string {
  return sql.replaceAll('tax_ytd', 'tax_memo');
}
function messages(sql: string, context: MigrationContext): string[] {
  return checkMigration(FILE, sql, context).map((p) => p.message);
}
function refused(sql: string, message: string, context = CONTEXT): void {
  expect(messages(sql, context), sql).toEqual(
    expect.arrayContaining([expect.stringContaining(message)]),
  );
  const plain = messages(ordinary(sql), { ...context, migrationsSql: [ordinary(HISTORY)] });
  expect(
    plain.filter((m) => m.includes('funds or attribution table')),
    ordinary(sql),
  ).toEqual([]);
}

it('[BR-WDR-20] tax_ytd 按整名登记在资金表清单里，带 schema 与引号等价，相似名字不纳入', () => {
  expect(FUNDS_TABLE_NAMES).toContain('tax_ytd');
  for (const name of ['tax_ytd', 'app.tax_ytd', '"tax_ytd"', '"app"."tax_ytd"', 'APP.TAX_YTD'])
    expect(isFundsTable(name), name).toBe(true);
  for (const name of ['tax_ytd_archive', 'app.tax_ytd_x', 'user_tax_ytd', 'tax_rates'])
    expect(isFundsTable(name), name).toBe(false);
});

it.each([
  ['DROP 表', 'ban-drop-table', 'DROP TABLE app.tax_ytd;'],
  ['DROP 列', 'ban-drop-column', 'ALTER TABLE app.tax_ytd DROP COLUMN continuous_months;'],
  [
    '改类型',
    'changing-column-type',
    'ALTER TABLE app.tax_ytd ALTER COLUMN continuous_months TYPE bigint;',
  ],
  [
    'RENAME 列',
    'renaming-column',
    'ALTER TABLE app.tax_ytd RENAME COLUMN identity_hmac TO id_no_hmac;',
  ],
  ['RENAME 表', 'renaming-table', 'ALTER TABLE app.tax_ytd RENAME TO tax_ytd_old;'],
])(
  '[BR-WDR-20] tax_ytd %s 不接受语句级 squawk-ignore，普通表同写法不受资金表限制',
  (_label, rule, sql) => {
    const ignored = `-- 夹具：旧字段或旧表已完成迁移，可执行收缩。\n-- squawk-ignore ${rule}\n${sql}`;
    for (const approved of [false, true])
      refused(ignored, `squawk-ignore on a statement of ${FUNDS}`, { ...CONTEXT, approved });
  },
);

it('[BR-WDR-20] tax_ytd 不得 SET SCHEMA，普通表同写法放行', () => {
  refused('ALTER TABLE app.tax_ytd SET SCHEMA archive;', `SET SCHEMA on ${FUNDS}`);
});

it.each([
  ['index', 'CREATE INDEX ON app.tax_ytd (app_id, year);'],
  ['constraint', 'ALTER TABLE app.tax_ytd ADD CHECK (cum_income_fen <= 100000000000);'],
  [
    'constraint',
    `CREATE TABLE app.tax_ytd (
  id uuid PRIMARY KEY,
  cum_income_fen bigint NOT NULL DEFAULT 0 CHECK (cum_income_fen >= 0)
);`,
  ],
])('[BR-WDR-20] tax_ytd 未命名 %s 拒绝（CT-06f），普通表同写法放行', (kind, sql) => {
  refused(sql, `unnamed ${kind} on ${FUNDS}`, { ...CONTEXT, migrationsSql: [] });
});

it.each([
  ['index tax_ytd_user_year_idx', 'DROP INDEX app.tax_ytd_user_year_idx;'],
  [
    'constraint tax_ytd_identity_key',
    'ALTER TABLE app.tax_ytd DROP CONSTRAINT tax_ytd_identity_key;',
  ],
  [
    'constraint tax_ytd_cum_income_fen_check',
    'ALTER TABLE app.tax_ytd DROP CONSTRAINT tax_ytd_cum_income_fen_check;',
  ],
])('[BR-WDR-20] tax_ytd 的 %s 只删不重建拒绝，普通表同写法放行', (object, sql) => {
  refused(sql, `${object} on ${FUNDS} may not be dropped`);
});

it('[BR-WDR-20] tax_ytd 金额列改成非 bigint 拒绝，且该语句不能用 squawk-ignore 放行', () => {
  const sql =
    '-- 夹具：试图把累计改成 numeric。\n-- squawk-ignore changing-column-type\nALTER TABLE app.tax_ytd ALTER COLUMN cum_income_fen TYPE numeric;';
  expect(messages(sql, CONTEXT)).toEqual(
    expect.arrayContaining([
      expect.stringContaining('money column cum_income_fen must be bigint'),
      expect.stringContaining(`squawk-ignore on a statement of ${FUNDS}`),
    ]),
  );
});

it('[BR-WDR-20] 建 app.tax_ytd 的迁移只有一个，是门禁要查的新迁移，按 CLI 的上下文通过门禁', () => {
  const names = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const creating = names.filter((name) =>
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?app"?\s*\.\s*"?tax_ytd"?\s*\(/i.test(read(name)),
  );
  expect(creating, 'db/migrations 里建 app.tax_ytd 的迁移').toHaveLength(1);
  const file = creating[0] ?? '';
  expect(Object.keys(FROZEN_MIGRATIONS)).not.toContain(file);
  expect(selectMigrations(names).lint).toContain(file);
  const sql = read(file);
  expect(sql.split('\n')[0]?.trim()).toBe('-- Up Migration');
  expect(sql).not.toMatch(/squawk-ignore/);
  const context: MigrationContext = {
    approved: false,
    schemaSql: read('../schema.sql'),
    migrationsSql: names.filter((name) => name < file).map(read),
  };
  expect(checkMigration(`db/migrations/${file}`, sql, context)).toEqual([]);
  expect(checkTimeouts(`db/migrations/${file}`, sql)).toEqual([]);
});
