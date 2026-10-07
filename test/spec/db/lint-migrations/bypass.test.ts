import { expect, it } from 'vitest';
import { gate, run, TIMEOUTS, withFixture } from './kit.ts';

// 续接首轮 #1–#28；对应任务 §10 的补充要求，不改首轮规则测试。
const IGNORE_CASES = [
  {
    label: '同行分号后的尾注释',
    table: 'orders',
    sql: 'ALTER TABLE app.orders DROP COLUMN c; -- squawk-ignore ban-drop-column',
  },
  {
    label: '尾注释后紧跟非资金语句，注释仍归前一条',
    table: 'orders',
    sql: `ALTER TABLE app.orders DROP COLUMN c; -- squawk-ignore ban-drop-column
ALTER TABLE app.articles ADD COLUMN title text;`,
  },
  {
    label: '块注释与 DROP TABLE IF EXISTS',
    table: 'orders',
    sql: '/* squawk-ignore ban-drop-table */\nDROP TABLE IF EXISTS app.orders;',
  },
  {
    label: '行注释与 DROP TABLE IF EXISTS',
    table: 'orders',
    sql: '-- squawk-ignore ban-drop-table\nDROP TABLE IF EXISTS app.orders;',
  },
  {
    label: 'ALTER TABLE ONLY',
    table: 'orders',
    sql: '-- squawk-ignore ban-drop-column\nALTER TABLE ONLY app.orders DROP COLUMN c;',
  },
  {
    label: 'ALTER TABLE IF EXISTS',
    table: 'ledger_entries',
    sql: '-- squawk-ignore renaming-column\nALTER TABLE IF EXISTS app.ledger_entries RENAME COLUMN a TO b;',
  },
  {
    label: 'DROP TABLE 逗号清单中第二个表属于资金表',
    table: 'orders',
    sql: '-- squawk-ignore ban-drop-table\nDROP TABLE app.articles, app.orders;',
  },
];

it.each(IGNORE_CASES)('[AC-CT-06a#29] checkMigration 拒绝绕过：$label', async ({ table, sql }) => {
  const { checkMigration } = await gate();
  const problems = checkMigration('0019_bypass.sql', sql);
  expect(problems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        file: '0019_bypass.sql',
        message: expect.stringContaining(`funds or attribution table ${table}`),
      }),
    ]),
  );
  for (const problem of problems) {
    expect(Number.isInteger(problem.line)).toBe(true);
    expect(problem.line).toBeGreaterThanOrEqual(1);
    expect(problem.line).toBeLessThanOrEqual(sql.split('\n').length);
  }
});

it.each(IGNORE_CASES)(
  '[AC-CT-06a#30] CLI 自检拒绝绕过并在 squawk 前退出：$label',
  ({ table, sql }) => {
    withFixture({ '0019_bypass.sql': TIMEOUTS + sql }, (root) => {
      const result = run(['--root', root]);
      expect(result.status, result.stderr + result.stdout).toBe(1);
      expect(result.stderr).toContain(`funds or attribution table ${table}`);
      expect(result.stdout).not.toMatch(/:\d+:\d+: warning:/);
    });
  },
);

it('[AC-CT-06a#31] 块注释中的 squawk-ignore-file 也必须拒绝', async () => {
  const { checkMigration } = await gate();
  expect(
    checkMigration(
      '0019_ignore-file.sql',
      '/* squawk-ignore-file */\nCREATE TABLE app.articles (id bigint);',
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        file: '0019_ignore-file.sql',
        line: 1,
        message: expect.stringContaining('squawk-ignore-file is not accepted'),
      }),
    ]),
  );
});

it('[AC-CT-06a#32] CLI 拒绝块注释中的文件级 ignore，不运行 squawk', () => {
  withFixture(
    {
      '0019_ignore-file.sql':
        TIMEOUTS + '/* squawk-ignore-file */\nCREATE TABLE app.articles (id bigint);',
    },
    (root) => {
      const result = run(['--root', root]);
      expect(result.status, result.stderr + result.stdout).toBe(1);
      expect(result.stderr).toContain('squawk-ignore-file is not accepted');
      expect(result.stdout).not.toMatch(/:\d+:\d+: warning:/);
    },
  );
});

it.each([
  ['金额列内联 CHECK', 'CREATE TABLE app.t (amount_fen bigint NOT NULL CHECK (amount_fen > 0));'],
  ['表级 CHECK', 'CREATE TABLE app.t (x_fen bigint, CHECK (x_fen IS NOT NULL));'],
  [
    '触发器函数中的 NEW / OLD 金额比较',
    `CREATE FUNCTION app.reject_amount_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.x_fen IS DISTINCT FROM OLD.x_fen THEN
    RAISE EXCEPTION 'amount changed';
  END IF;
  RETURN NEW;
END;
$$;`,
  ],
  ['列注释', "COMMENT ON COLUMN app.t.amount_fen IS 'Amount in integer fen';"],
  ['带 schema 的 int8', 'CREATE TABLE app.t (amount_fen pg_catalog.int8);'],
  ['int8 别名', 'CREATE TABLE app.t (amount_fen int8);'],
])('[AC-CT-06a#33] 合法金额类型及非列定义不误报：%s', async (_label, sql) => {
  const { checkMigration } = await gate();
  expect(checkMigration('0019_valid-amount.sql', sql)).toEqual([]);
});

it.each([
  ['SET DATA TYPE', 'ALTER TABLE app.t ALTER COLUMN amount_fen SET DATA TYPE integer;'],
  ['text', 'CREATE TABLE app.t (amount_fen text);'],
  ['pg_catalog.int4', 'CREATE TABLE app.t (amount_fen pg_catalog.int4);'],
  ['varchar(20)', 'CREATE TABLE app.t (amount_fen varchar(20));'],
])('[AC-CT-06a#34] 非 bigint 金额类型不能绕过自检：%s', async (_label, sql) => {
  const { checkMigration } = await gate();
  expect(checkMigration('0019_bad-amount.sql', sql)).toEqual([
    expect.objectContaining({
      file: '0019_bad-amount.sql',
      line: 1,
      message: expect.stringContaining('amount_fen must be bigint'),
    }),
  ]);
});
