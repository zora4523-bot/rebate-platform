import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  checkMigration,
  checkTimeouts,
  normaliseDefinition,
  type MigrationContext,
} from '../../../../tools/ci/lint-migrations.ts';
import { ROOT, SCRIPT, TIMEOUTS } from './kit.ts';

// CT-06h §9.2①～④。只由编排者在隔离容器运行；每组将新行为与保留的边界配对。
// CT-06g 已有导出，无须增加骨架或改 tools/**。真实仓库回归并入 CHECK 单行组，避免纯回归先绿。
const FILE = '0031_leftovers-2.sql';
const HISTORY_FILE = '0030_leftovers-2-history.sql';
const CLI_TIMEOUT_MS = 60_000;
const EMPTY: MigrationContext = { schemaSql: '', migrationsSql: [], approved: false };
const IGNORE = '-- squawk-ignore constraint-missing-not-valid';
const IGNORE_REFUSAL = 'squawk-ignore on a statement of funds or attribution table orders';

function refused(sql: string, message: string, context: MigrationContext): void {
  expect(checkMigration(FILE, sql, context), sql).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ file: FILE, message: expect.stringContaining(message) }),
    ]),
  );
}

function cli(args: string[], cwd = ROOT) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: process.env,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function fixture(files: Record<string, string>, check: (root: string) => void): void {
  const scratch = join(ROOT, '.tmp/ct-06h');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, '迁移 '));
  try {
    mkdirSync(join(root, 'db/migrations'), { recursive: true });
    copyFileSync(join(ROOT, '.squawk.toml'), join(root, '.squawk.toml'));
    for (const [name, sql] of Object.entries(files))
      writeFileSync(join(root, 'db/migrations', name), sql);
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const REBUILDS = [
  { label: 'CHECK 单行', definition: "CHECK (label <> 'ACTIVE')", layout: 'single' },
  { label: 'CHECK 分行', definition: "CHECK (label <> 'ACTIVE')", layout: 'multiline' },
  { label: 'CHECK 两条 ALTER', definition: "CHECK (label <> 'ACTIVE')", layout: 'split' },
  { label: 'EXCLUDE', definition: 'EXCLUDE USING btree (id WITH =)', layout: 'single' },
  { label: 'UNIQUE', definition: 'UNIQUE (ref)', layout: 'single' },
  { label: 'PRIMARY KEY', definition: 'PRIMARY KEY (id)', layout: 'single' },
  {
    label: 'FOREIGN KEY',
    definition: 'FOREIGN KEY (account_id) REFERENCES app.accounts (id)',
    layout: 'single',
  },
];

it.each(REBUILDS)(
  '[AC-CT-06h#1] $label 同定义重建带 ignore 也须在 CLI 自检拒绝，不得启动 squawk',
  ({ label, definition, layout }) => {
    const history = `${TIMEOUTS}CREATE TABLE app.accounts (
      id bigint CONSTRAINT accounts_pk PRIMARY KEY
    );
    CREATE TABLE app.orders (
      app_id uuid NOT NULL, id bigint, ref text, account_id bigint, label text,
      CONSTRAINT orders_guard ${definition}
    );\n`;
    const drop = 'DROP CONSTRAINT orders_guard';
    const add = `ADD CONSTRAINT orders_guard ${definition}`;
    const rebuild = (ignore: string) =>
      layout === 'split'
        ? `ALTER TABLE app.orders ${drop};\n${ignore}\nALTER TABLE app.orders ${add};\n`
        : layout === 'multiline'
          ? `${ignore}\nALTER TABLE ONLY "app"."orders"\n  ${drop},\n  ${add};\n`
          : `${ignore}\nALTER TABLE app.orders ${drop}, ${add};\n`;
    const context = { ...EMPTY, migrationsSql: [history] };
    // 不带 ignore 的同定义仍通过定义比较；实际 SQL 风险另由 squawk 把关。
    expect(checkMigration(FILE, TIMEOUTS + rebuild(''), context)).toEqual([]);

    if (label === 'CHECK 单行') {
      // 有 0020、0021 等新迁移也必须成功，不限定为 nothing to lint。
      const real = cli([], join(ROOT, 'test'));
      expect(real.status, real.stderr + real.stdout).toBe(0);
      const ordinary = (sql: string) => sql.replaceAll('app.orders', 'app.articles');
      fixture(
        {
          [HISTORY_FILE]: ordinary(history),
          [FILE]: ordinary(TIMEOUTS + rebuild(IGNORE)),
        },
        (root) => {
          const result = cli(['--root', root]);
          expect(result.status, result.stderr + result.stdout).toBe(0);
          expect(result.stdout).toContain('squawk over');
        },
      );
    }

    for (const ignore of [
      IGNORE,
      `${IGNORE}, ban-drop-column`,
      `-- squawk-ignore ban-drop-column\n${IGNORE}`,
    ]) {
      const sql = TIMEOUTS + '-- 夹具：按原定义加回同名约束。\n' + rebuild(ignore);
      fixture({ [HISTORY_FILE]: history, [FILE]: sql }, (root) => {
        // 不存在的可执行文件作哨兵：走到 squawk 分支会退出 2，不能冒充自检拒绝。
        const result = cli(['--root', root, '--squawk', join(root, 'absent-squawk')]);
        expect(result.status, result.stderr + result.stdout).toBe(1);
        expect(result.stderr).toContain(IGNORE_REFUSAL);
        expect(result.stderr).toContain(`${FILE}:`);
        expect(result.stderr).toContain('squawk was not run');
        expect(result.stderr).not.toContain('absent-squawk');
        expect(result.stdout).not.toContain('squawk over');
      });
      refused(sql, IGNORE_REFUSAL, context);
      // 登记定义变更不等于授权资金表使用 ignore。
      refused(sql, IGNORE_REFUSAL, { ...context, approved: true });
      refused(sql.replace(definition, 'CHECK (id > 0)'), IGNORE_REFUSAL, context);
    }
  },
  CLI_TIMEOUT_MS,
);

it.each(['lock_timeout', 'statement_timeout'])(
  '[AC-CT-06h#2] %s 的 set_config 参数引用和不匹配美元标签按关闭处理，完整字面量保留',
  (setting) => {
    const rule = `require-${setting.replace('_', '-')}`;
    const other = setting === 'lock_timeout' ? 'statement_timeout' : 'lock_timeout';
    const positions = [
      (call: string) => `SELECT ${call}`,
      (call: string) => `SELECT 1 FROM ${call}`,
      (call: string) => `SELECT (SELECT ${call})`,
      (call: string) => `WITH s AS (SELECT ${call}) SELECT * FROM s`,
    ];
    for (const wrap of positions) {
      for (const fn of ['set_config', 'pg_catalog.set_config', '"pg_catalog"."set_config"']) {
        for (const local of ['true', 'false']) {
          const sql = (value: string) =>
            TIMEOUTS +
            `PREPARE t(text, text) AS ${wrap(`${fn}('${setting}', ${value}, ${local})`)};\nEXECUTE t('0', '0');\n`;
          for (const value of ["'5s'", '$$5s$$', '$v$5s$v$', '$Timeout_1$5s$Timeout_1$'])
            expect(checkTimeouts(FILE, sql(value)), value).toEqual([]);
          for (const value of ['$1', '$2', '$1::text', '$a$5s$b$', '$v$5s$V$', '$$0ms$$']) {
            for (const suffix of ['', TIMEOUTS]) {
              const input = sql(value) + suffix;
              const problems = checkTimeouts(FILE, input).join('\n');
              expect(problems, input).toContain(rule);
              expect(problems, input).not.toContain(`require-${other.replace('_', '-')}`);
            }
          }
        }
      }
    }
  },
);

const LABEL_NAME = 'orders_label_guard';
const DROP_LABEL = `ALTER TABLE app.orders DROP CONSTRAINT ${LABEL_NAME};\n`;
const DIFFERENT_LABEL = `constraint ${LABEL_NAME} on funds or attribution table orders recreated with a different definition`;

function labelConstraint(literal: string): string {
  return `ALTER TABLE app.orders ADD CONSTRAINT ${LABEL_NAME} CHECK (label <> ${literal});`;
}

it.each(['$$', '$tag$'])(
  '[AC-CT-06h#3] %s 字面量大小写保留；等价单引号允许重建，改变内容须拒绝',
  (tag) => {
    const original = labelConstraint(`${tag}ACTIVE${tag}`);
    const context = { ...EMPTY, migrationsSql: [original] };
    // 先检查真正的保护效果，避免只修 normaliseDefinition 的独立返回值。
    refused(DROP_LABEL + labelConstraint(`${tag}active${tag}`), DIFFERENT_LABEL, context);
    expect(checkMigration(FILE, DROP_LABEL + original, context)).toEqual([]);
    expect(checkMigration(FILE, DROP_LABEL + labelConstraint("'ACTIVE'"), context)).toEqual([]);
    expect(normaliseDefinition(original)).not.toBe(
      normaliseDefinition(labelConstraint(`${tag}active${tag}`)),
    );
    for (const [dollar, single] of [
      [`${tag}a${tag}`, "'a'"],
      [`${tag}a'b${tag}`, "'a''b'"],
      [`${tag}a  B\napp.C -- ;${tag}`, "'a  B\napp.C -- ;'"],
    ] as const) {
      expect(normaliseDefinition(labelConstraint(dollar))).toBe(
        normaliseDefinition(labelConstraint(single)),
      );
      for (const [before, after] of [
        [dollar, single],
        [single, dollar],
      ] as const) {
        expect(
          checkMigration(FILE, DROP_LABEL + labelConstraint(after), {
            ...EMPTY,
            migrationsSql: [labelConstraint(before)],
          }),
        ).toEqual([]);
      }
    }
    // 美元符号在单引号里面就是数据，不能被再次当作引号剥掉。
    const quotedDollars = labelConstraint("'$$ACTIVE$$'");
    expect(normaliseDefinition(quotedDollars)).toContain("'$$ACTIVE$$'");
    expect(normaliseDefinition(quotedDollars)).not.toBe(
      normaliseDefinition(labelConstraint("'ACTIVE'")),
    );
    const quotedContext = { ...EMPTY, migrationsSql: [quotedDollars] };
    expect(checkMigration(FILE, DROP_LABEL + quotedDollars, quotedContext)).toEqual([]);
    refused(DROP_LABEL + labelConstraint("'$$active$$'"), DIFFERENT_LABEL, quotedContext);
    refused(DROP_LABEL + labelConstraint("'ACTIVE'"), DIFFERENT_LABEL, quotedContext);
  },
);

const COLUMN_GUARDS = [
  { kind: 'PRIMARY KEY', column: 'id', type: 'bigint', name: 'x', clause: 'PRIMARY KEY' },
  { kind: 'UNIQUE', column: 'ref', type: 'text', name: 'y', clause: 'UNIQUE' },
  {
    kind: 'FOREIGN KEY',
    column: 'account_id',
    type: 'bigint',
    name: 'z',
    clause: 'REFERENCES app.accounts (id)',
  },
];

it.each(
  COLUMN_GUARDS.flatMap((guard) =>
    ['CREATE TABLE', 'ADD COLUMN'].map((source) => ({ ...guard, source })),
  ),
)(
  '[AC-CT-06h#4] $source 的列级 $kind 与表级约束等价，换列仍拒绝',
  ({ kind, column, type, name, clause, source }) => {
    const others = COLUMN_GUARDS.filter((guard) => guard.column !== column)
      .map((guard) => `${guard.column} ${guard.type}`)
      .join(', ');
    const columnSql = `${column} ${type} CONSTRAINT ${name} ${clause}`;
    const history =
      source === 'CREATE TABLE'
        ? [`CREATE TABLE app.orders (app_id uuid NOT NULL, ${others}, ${columnSql});`]
        : [
            `CREATE TABLE app.orders (app_id uuid NOT NULL, ${others});`,
            `ALTER TABLE app.orders ADD COLUMN ${columnSql};`,
          ];
    const context: MigrationContext = { ...EMPTY, migrationsSql: history };
    const tableClause = (col: string) =>
      kind === 'FOREIGN KEY'
        ? `FOREIGN KEY (${col}) REFERENCES app.accounts (id)`
        : `${kind} (${col})`;
    const rebuild = (col: string) =>
      `ALTER TABLE app.orders DROP CONSTRAINT ${name};\nALTER TABLE app.orders ADD CONSTRAINT ${name} ${tableClause(col)};`;
    const different = `constraint ${name} on funds or attribution table orders recreated with a different definition`;
    refused(rebuild(column === 'id' ? 'account_id' : 'id'), different, context);
    // approved: false，且 schemaSql 留空；通过必须来自迁移史的列约束等价识别。
    expect(checkMigration(FILE, rebuild(column), context)).toEqual([]);
    if (kind === 'FOREIGN KEY') {
      refused(
        rebuild(column).replace(
          'REFERENCES app.accounts (id)',
          'REFERENCES app.accounts (other_id)',
        ),
        different,
        context,
      );
    }
  },
);
