import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  checkMigration,
  checkTimeouts,
  decodeLiteral,
  normaliseDefinition,
  type MigrationContext,
} from '../../../../tools/ci/lint-migrations.ts';
import { ROOT, SCRIPT, TIMEOUTS } from './kit.ts';

// CT-06g §9.2①～④；只由编排者在隔离容器运行，CLI 使用仓库安装的真 squawk。
// 每组将新行为与允许/拒绝边界配对，CT-06f 基线应因断言失败而红。
const FILE = '0031_leftovers.sql';
const HISTORY_FILE = '0030_leftovers-history.sql';
const CLI_TIMEOUT_MS = 60_000;
const EMPTY: MigrationContext = { schemaSql: '', migrationsSql: [], approved: false };

function refused(sql: string, message: string, context: MigrationContext): void {
  expect(checkMigration(FILE, sql, context), sql).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ file: FILE, message: expect.stringContaining(message) }),
    ]),
  );
}

function quoted(body: string): string {
  return `'${body.replaceAll("'", "''")}'`;
}

const POSITIONS = [
  { label: 'SELECT', wrap: (call: string) => `SELECT ${call};` },
  { label: 'FROM', wrap: (call: string) => `SELECT 1 FROM ${call};` },
  { label: '子查询', wrap: (call: string) => `SELECT (SELECT ${call});` },
  { label: 'CTE', wrap: (call: string) => `WITH s AS (SELECT ${call}) SELECT 1;` },
  { label: 'DO', wrap: (call: string) => `DO $body$ BEGIN PERFORM ${call}; END $body$;` },
  {
    label: 'DO EXECUTE',
    wrap: (call: string) => `DO $body$ BEGIN EXECUTE ${quoted(`SELECT ${call}`)}; END $body$;`,
  },
];
const NON_LITERALS = [
  'NULL',
  "concat('0')",
  "concat('5', 's')",
  "current_setting('x')",
  "'5s' || ''",
  "'5s'::text || ''",
  "(SELECT '0')",
  'timeout_value',
];
const ON_LITERALS = ["'5s'", "'5s'::text", "'5s'::varchar", "'5s'::name", '$$5s$$'];

it.each(POSITIONS)(
  '[AC-CT-06g#1] $label 中两种超时的 set_config 只接受单个字符串字面量及允许的强转',
  ({ wrap }) => {
    for (const setting of ['lock_timeout', 'statement_timeout']) {
      const other = setting === 'lock_timeout' ? 'statement_timeout' : 'lock_timeout';
      for (const fn of ['set_config', 'pg_catalog.set_config', '"pg_catalog"."set_config"']) {
        for (const local of ['true', 'false']) {
          const sql = (value: string) => TIMEOUTS + wrap(`${fn}('${setting}', ${value}, ${local})`);
          for (const value of ON_LITERALS)
            expect(checkTimeouts(FILE, sql(value)), sql(value)).toEqual([]);
          for (const value of [...NON_LITERALS, "'0'::text", "'0ms'::varchar", "'0'::name"])
            for (const suffix of ['', TIMEOUTS]) {
              const input = sql(value) + suffix;
              const problems = checkTimeouts(FILE, input).join('\n');
              expect(problems, input).toContain(`require-${setting.replace('_', '-')}`);
              expect(problems, input).not.toContain(`require-${other.replace('_', '-')}`);
            }
        }
      }
    }
  },
);

const LABEL_GUARD = 'orders_label_guard';
const DROP_LABEL = `ALTER TABLE app.orders DROP CONSTRAINT ${LABEL_GUARD};\n`;
const VALIDATE_LABEL = `ALTER TABLE app.orders VALIDATE CONSTRAINT ${LABEL_GUARD};`;
const DIFFERENT_LABEL = `constraint ${LABEL_GUARD} on funds or attribution table orders recreated with a different definition`;

function labelConstraint(literal: string, notValid = false): string {
  return `ALTER TABLE app.orders ADD CONSTRAINT ${LABEL_GUARD} CHECK (label <> ${literal})${notValid ? ' NOT VALID' : ''};\n`;
}

it.each(['schema', 'migration', 'validated-history'])(
  '[AC-CT-06g#2] %s 的 NOT VALID 修饰符可去除，字符串内的 not valid 必须保留',
  (source) => {
    const original = labelConstraint("'not valid'");
    const context: MigrationContext = {
      ...EMPTY,
      schemaSql: source === 'schema' ? original : '',
      migrationsSql:
        source === 'schema'
          ? []
          : source === 'migration'
            ? [original]
            : [labelConstraint("'not valid'", true), VALIDATE_LABEL],
    };
    // 先验证不能借 VALIDATE 把历史字符串删空，再验证相同字符串不会误拒。
    refused(DROP_LABEL + labelConstraint("''", true) + VALIDATE_LABEL, DIFFERENT_LABEL, context);
    expect(
      checkMigration(
        FILE,
        DROP_LABEL + labelConstraint("'not valid'", true) + VALIDATE_LABEL,
        context,
      ),
    ).toEqual([]);
    expect(checkMigration(FILE, DROP_LABEL + original, context)).toEqual([]);
    refused(DROP_LABEL + labelConstraint("'not valid'", true), DIFFERENT_LABEL, context);
  },
);

it.each(['constraint', 'index'])(
  '[AC-CT-06g#3] %s 定义的 UTF-8 BOM 不得丢失，普通 UTF-8 字符仍可等价重建',
  (kind) => {
    const definition = (literal: string) =>
      kind === 'constraint'
        ? labelConstraint(literal)
        : `CREATE INDEX orders_label_idx ON app.orders (app_id) WHERE label <> ${literal};`;
    const drop = kind === 'constraint' ? DROP_LABEL : 'DROP INDEX app.orders_label_idx;\n';
    const name = kind === 'constraint' ? LABEL_GUARD : 'orders_label_idx';
    const original = definition(String.raw`E'\xef\xbb\xbfACTIVE'`);
    const context = { ...EMPTY, migrationsSql: [original] };
    expect(
      checkMigration(FILE, drop + definition("'é'"), {
        ...EMPTY,
        migrationsSql: [definition(String.raw`E'\xc3\xa9'`)],
      }),
    ).toEqual([]);
    refused(
      drop + definition("'ACTIVE'"),
      `${kind} ${name} on funds or attribution table orders recreated with a different definition`,
      context,
    );
    expect(checkMigration(FILE, drop + definition("'\uFEFFACTIVE'"), context)).toEqual([]);
    expect(decodeLiteral(String.raw`E'\xef\xbb\xbfACTIVE'`)).toBe('\uFEFFACTIVE');
    expect(decodeLiteral(String.raw`E'\xc3\xa9'`)).toBe('é');
    expect(normaliseDefinition(original)).not.toBe(normaliseDefinition(definition("'ACTIVE'")));
    expect(normaliseDefinition(definition(String.raw`E'\xc3\xa9'`))).toBe(
      normaliseDefinition(definition("'é'")),
    );
  },
);

const HISTORY = `${TIMEOUTS}CREATE TABLE app.orders (
  app_id uuid NOT NULL,
  label text,
  status text,
  CONSTRAINT orders_label_guard CHECK (label <> 'not valid'),
  CONSTRAINT orders_status_guard CHECK (status <> 'DELETED')
);\n`;
const CONTEXT: MigrationContext = { ...EMPTY, migrationsSql: [HISTORY] };
const IGNORE = '-- squawk-ignore constraint-missing-not-valid';
const IGNORE_REFUSAL = 'squawk-ignore on a statement of funds or attribution table orders';
const REBUILD =
  "ALTER TABLE app.orders DROP CONSTRAINT orders_label_guard, ADD CONSTRAINT orders_label_guard CHECK (label <> 'not valid');";
const ALLOWED = `${TIMEOUTS}-- 同表同名按历史定义重建，保留已验证状态。\n${IGNORE}\n${REBUILD}\n`;

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
  const scratch = join(ROOT, '.tmp/ct-06g');
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

it(
  '[AC-CT-06g#4] 同定义重建仅豁免指定语句的 constraint-missing-not-valid，真 squawk 复查也通过',
  () => {
    // 无 ignore 时真 squawk 必须检出这条规则，避免夹具根本没有触发它而假绿。
    fixture({ [HISTORY_FILE]: HISTORY, [FILE]: TIMEOUTS + REBUILD }, (root) => {
      const result = cli(['--root', root]);
      expect(result.status, result.stderr + result.stdout).toBe(1);
      expect(result.stdout).toContain('squawk over');
      expect(result.stdout).toContain('constraint-missing-not-valid');
    });
  },
  CLI_TIMEOUT_MS,
);

const REJECTED_IGNORES = [
  { label: '规则名不同', sql: ALLOWED.replace(IGNORE, '-- squawk-ignore ban-drop-column') },
  {
    label: '多条规则',
    sql: ALLOWED.replace(IGNORE, `${IGNORE}, ban-drop-column`),
  },
  { label: '重建定义不同', sql: ALLOWED.replace("label <> 'not valid'", "label <> ''") },
  {
    label: '混入没有历史的新约束',
    sql: ALLOWED.replace(
      REBUILD,
      REBUILD.replace(';', ", ADD CONSTRAINT new_guard CHECK (label <> 'new');"),
    ),
  },
  {
    label: '重建带 NOT VALID，即使稍后验证',
    sql: ALLOWED.replace(REBUILD, REBUILD.replace(';', ' NOT VALID;') + '\n' + VALIDATE_LABEL),
  },
  {
    label: '混入其他子命令',
    sql: ALLOWED.replace(REBUILD, REBUILD.replace(';', ', ADD COLUMN note text;')),
  },
  {
    label: '删了未重建的另一约束',
    sql: ALLOWED.replace(REBUILD, REBUILD.replace(';', ', DROP CONSTRAINT orders_status_guard;')),
  },
  {
    label: 'ignore 同行尾随',
    sql: `${TIMEOUTS}${REBUILD} ${IGNORE}\n`,
  },
  { label: '未提供迁移史', sql: ALLOWED, noHistory: true },
];

it.each(REJECTED_IGNORES)(
  '[AC-CT-06g#5] $label 仍按资金表 ignore 拒绝；修正为同定义重建后 CLI 放行',
  ({ sql, noHistory }) => {
    const context = noHistory === true ? EMPTY : CONTEXT;
    refused(sql, IGNORE_REFUSAL, context);
    if (noHistory === true) {
      expect(checkMigration(FILE, sql)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining(IGNORE_REFUSAL) }),
        ]),
      );
    }
    fixture({ ...(noHistory === true ? {} : { [HISTORY_FILE]: HISTORY }), [FILE]: sql }, (root) => {
      const result = cli(['--root', root]);
      expect(result.status, result.stderr + result.stdout).toBe(1);
      expect(result.stderr).toContain(IGNORE_REFUSAL);
      expect(result.stderr).toContain(`${FILE}:`);
    });
  },
  CLI_TIMEOUT_MS,
);

it(
  '[AC-CT-06g#6] 多个约束须全部同定义重建，不能只看第一个 ADD CONSTRAINT',
  () => {
    const multi = `${TIMEOUTS}-- 两个约束均按历史定义重建。\n${IGNORE}\n${[
      'ALTER TABLE ONLY "app"."orders"',
      'DROP CONSTRAINT "orders_label_guard",',
      'DROP CONSTRAINT "orders_status_guard",',
      'ADD CONSTRAINT "orders_label_guard" CHECK (label <> \'not valid\'),',
      'ADD CONSTRAINT "orders_status_guard" CHECK (status <> \'DELETED\');',
    ].join(' ')}\n`;
    const changed = multi.replace("status <> 'DELETED'", "status <> 'ACTIVE'");
    refused(changed, IGNORE_REFUSAL, CONTEXT);
    fixture({ [HISTORY_FILE]: HISTORY, [FILE]: changed }, (root) => {
      const result = cli(['--root', root]);
      expect(result.status, result.stderr + result.stdout).toBe(1);
      expect(result.stderr).toContain(IGNORE_REFUSAL);
    });
  },
  CLI_TIMEOUT_MS,
);

it(
  '[AC-CT-06g#7] 真实仓库无参数退出 0，同定义重建夹具也通过',
  () => {
    // 仓库可有 0020、0021 等待检查文件，也可全在冻结清单；不假定 nothing to lint。
    const result = cli([], join(ROOT, 'test'));
    expect(result.status, result.stderr + result.stdout).toBe(0);
  },
  CLI_TIMEOUT_MS,
);
