import { expect, it } from 'vitest';
import { gate, requiredText } from './kit.ts';

// AC-CT-06a#n 是任务 §9 契约的断言组编号，不是新增业务 AC。
it('[AC-CT-06a#1] 默认基线为 18，只选新 SQL，结果排序且不修改输入', async () => {
  const module = await gate();
  expect(module.GATE_BASELINE).toBe(18);
  const names = [
    '0021_z.sql',
    '0018_old.sql',
    'README.md',
    '0020_b.sql',
    '0019_a.sql',
    '0001_old.sql',
  ];
  const before = [...names];
  expect(module.selectMigrations(names)).toEqual({
    lint: ['0019_a.sql', '0020_b.sql', '0021_z.sql'],
    badNames: [],
  });
  expect(names).toEqual(before);
  expect(module.selectMigrations([], 0)).toEqual({ lint: [], badNames: [] });
  expect(module.selectMigrations(['0018_old.sql', '0019_new.sql'], 17)).toEqual({
    lint: ['0018_old.sql', '0019_new.sql'],
    badNames: [],
  });
  expect(module.selectMigrations(['0019_new.sql'], 19)).toEqual({ lint: [], badNames: [] });
});

it('[AC-CT-06a#2] SQL 必须四位序号、下划线与 kebab-name，旧序号坏名字也拒绝', async () => {
  const { selectMigrations } = await gate();
  expect(
    selectMigrations([
      '0019-dash.sql',
      '19_short.sql',
      '0019_two_words.sql',
      '0019_Upper.sql',
      '0019_.sql',
      '10000_long.sql',
      '0017-bad.sql',
      '0020_good-name.sql',
      'notes.txt',
      '0019_good.sql.bak',
    ]),
  ).toEqual({
    lint: ['0020_good-name.sql'],
    badNames: [
      '0017-bad.sql',
      '0019-dash.sql',
      '0019_.sql',
      '0019_Upper.sql',
      '0019_two_words.sql',
      '10000_long.sql',
      '19_short.sql',
    ],
  });
});

it.each([
  'orders',
  'ledger_entries',
  'accounts',
  'withdrawals',
  'payout_accounts',
  'settlements',
  'commissions',
  'reconciliation_runs',
  'adjustments',
  'vouchers',
  'entries',
  'entries_archive',
  'balances',
  'union_bindings',
  'link_logs',
  'links',
])('[AC-CT-06a#3] %s 按契约属于资金或归属表，支持 schema 与双引号', async (table) => {
  const { isFundsTable } = await gate();
  for (const ref of [table, `app.${table}`, `"app"."${table}"`, `app."${table}"`]) {
    expect(isFundsTable(ref), ref).toBe(true);
  }
});

it.each([
  'articles',
  'users',
  'admin_users',
  'unions',
  'linkage',
  'hyperlinks',
  'preorders',
  'audit_logs',
])('[AC-CT-06a#4] %s 不应被资金前缀误伤', async (table) => {
  const { isFundsTable } = await gate();
  expect(isFundsTable(`app.${table}`)).toBe(false);
  expect(isFundsTable(`"orders"."${table}"`), '只检查表名，不检查 schema').toBe(false);
});

it('[AC-CT-06a#5] schema 当前全部资金及归属表都被识别', async () => {
  const { isFundsTable } = await gate();
  const tables = [...requiredText('db/schema.sql').matchAll(/^CREATE TABLE app\.(\w+)\s*\(/gm)].map(
    (match) => match[1]!,
  );
  const expected = [
    'link_logs',
    'link_logs_default',
    'link_open_attempts',
    'links',
    'order_keys',
    'order_rights',
    'order_settlements',
    'orders',
    'orders_default',
    'payout_account_changes',
    'payout_account_verify_attempts',
    'payout_accounts',
    'union_accounts',
    'union_auth_sessions',
    'union_bindings',
    'union_credentials',
    'union_pids',
  ];
  expect(tables).toEqual(expect.arrayContaining(expected));
  for (const table of expected) expect(isFundsTable(`app.${table}`), table).toBe(true);
});

it.each([
  'integer',
  'int',
  'int2',
  'int4',
  'smallint',
  'serial',
  'numeric(12,2)',
  'decimal',
  'real',
  'double precision',
  'float',
  'money',
])('[AC-CT-06a#6] 建表金额列禁止 %s，诊断带文件、从 1 起的行号与列名', async (type) => {
  const { checkMigration } = await gate();
  expect(
    checkMigration('0019_money.sql', `CREATE TABLE app.articles (\n  amount_fen ${type}\n);`),
  ).toEqual([
    expect.objectContaining({
      file: '0019_money.sql',
      line: 2,
      message: expect.stringMatching(/(?=.*amount_fen)(?=.*must be bigint)/),
    }),
  ]);
});

it.each([
  'ALTER TABLE app.orders ADD COLUMN amount_fen integer;',
  'ALTER TABLE app.orders ADD amount_fen numeric(12,2);',
  'ALTER TABLE app.orders ALTER COLUMN amount_fen TYPE int4;',
  'ALTER TABLE "app"."orders" ADD COLUMN "amount_fen" INTEGER;',
])('[AC-CT-06a#7] ADD / ALTER / 引号标识符同样检查金额：%s', async (sql) => {
  const { checkMigration } = await gate();
  expect(checkMigration('0019_money.sql', sql)).toEqual([
    expect.objectContaining({
      file: '0019_money.sql',
      line: 1,
      message: expect.stringMatching(/(?=.*amount_fen)(?=.*must be bigint)/),
    }),
  ]);
});

it('[AC-CT-06a#8] bigint 与 int8 合法，比例 integer 与注释中的错误类型不算金额错误', async () => {
  const { checkMigration } = await gate();
  expect(
    checkMigration(
      '0019_safe.sql',
      `-- ignored_fen int
/* another_fen numeric */
CREATE TABLE app.articles (id bigint, amount_fen bigint, fee_fen int8, rate_bp integer);
ALTER TABLE app.articles ADD COLUMN extra_fen BIGINT;
ALTER TABLE app.articles ALTER COLUMN amount_fen TYPE int8;
`,
    ),
  ).toEqual([]);
});

it('[AC-CT-06a#9] 一份文件报告多个金额错误，不能只返回第一个', async () => {
  const { checkMigration } = await gate();
  const problems = checkMigration(
    '0019_many.sql',
    'CREATE TABLE app.articles (\n amount_fen integer,\n fee_fen numeric\n);',
  );
  expect(problems).toHaveLength(2);
  expect(problems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        file: '0019_many.sql',
        line: 2,
        message: expect.stringContaining('amount_fen'),
      }),
      expect.objectContaining({
        file: '0019_many.sql',
        line: 3,
        message: expect.stringContaining('fee_fen'),
      }),
    ]),
  );
  for (const problem of problems) expect(problem.message).toContain('must be bigint');
});

it('[AC-CT-06a#10] 文件级 squawk-ignore-file 一律拒绝', async () => {
  const { checkMigration } = await gate();
  expect(
    checkMigration(
      '0019_ignore.sql',
      '-- squawk-ignore-file ban-drop-table\nDROP TABLE app.articles;',
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        file: '0019_ignore.sql',
        line: 1,
        message: expect.stringContaining('squawk-ignore-file is not accepted'),
      }),
    ]),
  );
});

it.each([
  ['orders', '-- squawk-ignore ban-drop-column\nALTER TABLE app.orders DROP COLUMN c;'],
  ['orders', 'ALTER TABLE app.orders -- squawk-ignore ban-drop-column\n DROP COLUMN c;'],
  ['orders', 'ALTER TABLE app.orders DROP COLUMN c -- squawk-ignore ban-drop-column\n;'],
  ['links', '-- reason\n-- squawk-ignore ban-drop-table\nDROP TABLE "app"."links";'],
  [
    'union_bindings',
    'ALTER TABLE app.union_bindings\n-- squawk-ignore renaming-column\nRENAME COLUMN c TO d;',
  ],
  [
    'ledger_entries',
    '-- squawk-ignore changing-column-type\nALTER TABLE app.ledger_entries ALTER COLUMN c TYPE bigint;',
  ],
])('[AC-CT-06a#11] %s 语句前、内部与末尾的 ignore 都不得绕过门禁：%s', async (table, sql) => {
  const { checkMigration } = await gate();
  const problems = checkMigration('0019_ignore.sql', sql);
  expect(problems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        file: '0019_ignore.sql',
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

it('[AC-CT-06a#12] 非资金表可忽略且不得跨分号把下一条资金语句算进来', async () => {
  const { checkMigration } = await gate();
  expect(
    checkMigration(
      '0019_exception.sql',
      `-- obsolete article column; approved cleanup
-- squawk-ignore ban-drop-column
ALTER TABLE app.articles DROP COLUMN old_title;
ALTER TABLE app.orders ADD COLUMN extra_fen bigint;
`,
    ),
  ).toEqual([]);
});
