import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  checkMigration,
  FROZEN_MIGRATIONS,
  FUNDS_TABLE_NAMES,
  isFundsTable,
  type MigrationContext,
} from '../../../../tools/ci/lint-migrations.ts';
import { ROOT, SCRIPT, TIMEOUTS } from './kit.ts';

// CT-06j §9：appeals 是 BR-FUND-22 申诉恢复的触发源。
// 每组把放行对照与新增拒绝行为配对；只由编排者在隔离容器运行。
const FILE = '0031_appeals-guard.sql';
const CLI_TIMEOUT_MS = 60_000;
const HISTORY = readFileSync(join(ROOT, 'db/migrations/0014_risk-baseline.sql'), 'utf8');
const CONTEXT: MigrationContext = { schemaSql: '', migrationsSql: [HISTORY], approved: false };
const ORDINARY_CONTEXT: MigrationContext = {
  ...CONTEXT,
  migrationsSql: [ordinary(HISTORY)],
};

function ordinary(sql: string): string {
  return sql.replaceAll('appeals', 'articles');
}

function refused(sql: string, message: string, context = CONTEXT): void {
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

function fixture(sql: string, check: (root: string) => void): void {
  const scratch = join(ROOT, '.tmp/ct-06j');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, '申诉迁移 '));
  try {
    mkdirSync(join(root, 'db/migrations'), { recursive: true });
    copyFileSync(join(ROOT, '.squawk.toml'), join(root, '.squawk.toml'));
    // 不伪造 0014 或 schema：冻结迁移须成套复制，CLI 从迁移史读取真实对象归属。
    for (const name of Object.keys(FROZEN_MIGRATIONS))
      copyFileSync(join(ROOT, 'db/migrations', name), join(root, 'db/migrations', name));
    writeFileSync(join(root, 'db/migrations', FILE), TIMEOUTS + sql);
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function cliRefused(root: string, message: string): void {
  const result = cli(['--root', root, '--squawk', join(root, 'absent-squawk')]);
  expect(result.status, result.stderr + result.stdout).toBe(1);
  expect(result.stderr).toContain(`${FILE}:`);
  expect(result.stderr).toContain(message);
  expect(result.stderr).toContain('squawk was not run');
  expect(result.stderr).not.toContain('absent-squawk');
  expect(result.stdout).not.toContain('squawk over');
}

it('[AC-CT-06j#1] appeals 按整名纳入，带 schema 与引号等价，相似名字不纳入', () => {
  for (const name of ['appeals_archive', 'app.appeals_x', 'user_appeals']) {
    expect(isFundsTable(name), name).toBe(false);
    expect(checkMigration(FILE, `ALTER TABLE ${name} SET SCHEMA archive;`, CONTEXT)).toEqual([]);
  }
  expect(FUNDS_TABLE_NAMES).toContain('appeals');
  for (const name of ['appeals', 'app.appeals', '"appeals"', '"app"."appeals"'])
    expect(isFundsTable(name), name).toBe(true);
});

it.each([
  ['DROP 表', 'DROP TABLE app.appeals;', 'ban-drop-table'],
  ['DROP 列', 'ALTER TABLE app.appeals DROP COLUMN content;', 'ban-drop-column'],
  ['改类型', 'ALTER TABLE app.appeals ALTER COLUMN content TYPE jsonb;', 'changing-column-type'],
  ['RENAME 列', 'ALTER TABLE app.appeals RENAME COLUMN content TO old_content;', 'renaming-column'],
  ['RENAME 表', 'ALTER TABLE app.appeals RENAME TO old_appeals;', 'renaming-table'],
])(
  '[AC-CT-06j#2] %s 拒绝，普通表可用语句级例外，appeals 不得用相同例外绕过',
  (_label, sql, rule) => {
    // DROP / TYPE / RENAME 由 squawk 拒绝；普通表须有理由及对应的 ignore 才放行。
    fixture(sql, (root) => {
      const result = cli(['--root', root]);
      expect(result.status, result.stderr + result.stdout).toBe(1);
      expect(result.stdout).toContain(rule);
      expect(result.stdout).toContain(FILE);
    });
    const ignored = `-- 夹具：旧字段或旧表已完成迁移，可执行收缩。\n-- squawk-ignore ${rule}\n${sql}`;
    fixture(ordinary(ignored), (root) => {
      const result = cli(['--root', root]);
      expect(result.status, result.stderr + result.stdout).toBe(0);
    });
    fixture(ignored, (root) => {
      cliRefused(root, 'squawk-ignore on a statement of funds or attribution table appeals');
    });
  },
  CLI_TIMEOUT_MS,
);

it('[AC-CT-06j#3] SET SCHEMA 对 appeals 拒绝，对普通表放行', () => {
  const sql = 'ALTER TABLE app.appeals SET SCHEMA archive;';
  expect(checkMigration(FILE, ordinary(sql), ORDINARY_CONTEXT)).toEqual([]);
  refused(sql, 'SET SCHEMA on funds or attribution table appeals');
});

it('[AC-CT-06j#4] appeals 的安全语句也不接受 squawk-ignore，登记审批不豁免', () => {
  const sql = 'CREATE INDEX appeals_content_idx ON app.appeals (content);';
  expect(checkMigration(FILE, sql, CONTEXT)).toEqual([]);
  const ignored =
    '-- 夹具：检查语句级例外的表归属。\n-- squawk-ignore require-concurrent-index-creation\n' + sql;
  expect(checkMigration(FILE, ordinary(ignored), ORDINARY_CONTEXT)).toEqual([]);
  for (const approved of [false, true])
    refused(ignored, 'squawk-ignore on a statement of funds or attribution table appeals', {
      ...CONTEXT,
      approved,
    });
});

it.each([
  ['索引', 'DROP INDEX app.appeals_user_idx;', 'index appeals_user_idx'],
  [
    '约束',
    'ALTER TABLE app.appeals DROP CONSTRAINT appeals_closed_check;',
    'constraint appeals_closed_check',
  ],
])('[AC-CT-06j#5] appeals %s 只删不重建拒绝，普通表同写法放行', (_label, sql, object) => {
  expect(checkMigration(FILE, ordinary(sql), ORDINARY_CONTEXT)).toEqual([]);
  refused(sql, `${object} on funds or attribution table appeals may not be dropped`);
});

it.each([
  ['index', 'CREATE INDEX ON app.appeals (app_id, user_id);'],
  ['constraint', "ALTER TABLE app.appeals ADD CHECK (content <> '');"],
])('[AC-CT-06j#6] appeals 未命名 %s 拒绝，普通表同写法放行', (kind, sql) => {
  expect(checkMigration(FILE, ordinary(sql), ORDINARY_CONTEXT)).toEqual([]);
  refused(sql, `unnamed ${kind} on funds or attribution table appeals`);
});

it.each([
  {
    kind: 'index',
    name: 'appeals_user_idx',
    drop: 'DROP INDEX app.appeals_user_idx;',
    original: 'CREATE INDEX appeals_user_idx ON app.appeals (app_id, user_id, created_at DESC);',
    changed: 'CREATE INDEX appeals_user_idx ON app.appeals (app_id, created_at DESC);',
  },
  {
    kind: 'constraint',
    name: 'appeals_closed_check',
    drop: 'ALTER TABLE app.appeals DROP CONSTRAINT appeals_closed_check;',
    original:
      "ALTER TABLE app.appeals ADD CONSTRAINT appeals_closed_check CHECK ((status = 'processing') = (closed_at IS NULL));",
    changed:
      "ALTER TABLE app.appeals ADD CONSTRAINT appeals_closed_check CHECK (status = 'processing' OR closed_at IS NOT NULL);",
  },
])(
  '[AC-CT-06j#7] $kind 对照真实 0014：同定义放行，改定义须登记审批，普通表不受此限制',
  ({ kind, name, drop, original, changed }) => {
    expect(checkMigration(FILE, drop + '\n' + original, CONTEXT)).toEqual([]);
    const sql = drop + '\n' + changed;
    expect(checkMigration(FILE, ordinary(sql), ORDINARY_CONTEXT)).toEqual([]);
    expect(checkMigration(FILE, sql, { ...CONTEXT, approved: true })).toEqual([]);
    refused(
      sql,
      `${kind} ${name} on funds or attribution table appeals recreated with a different definition: list the migration in APPROVED_GUARD_CHANGES`,
    );
  },
);

it.each([
  'DROP TRIGGER appeals_guard ON app.appeals;',
  'ALTER TABLE app.appeals DISABLE TRIGGER appeals_guard;',
  'ALTER TABLE app.appeals ENABLE REPLICA TRIGGER appeals_guard;',
])('[AC-CT-06j#8] 新增到 appeals 的触发器也不能只删或停用：%s', (sql) => {
  // 0014 没有 appeals 触发器；在其后新增的假定保护触发器同样受表清单约束。
  const trigger =
    'CREATE TRIGGER appeals_guard BEFORE UPDATE OR DELETE ON app.appeals FOR EACH ROW EXECUTE FUNCTION app.reject_appeal_rewrite();';
  const context = { ...CONTEXT, migrationsSql: [HISTORY, trigger] };
  expect(
    checkMigration(FILE, ordinary(sql), {
      ...ORDINARY_CONTEXT,
      migrationsSql: [ordinary(HISTORY), ordinary(trigger)],
    }),
  ).toEqual([]);
  expect(
    checkMigration(FILE, 'DROP TRIGGER appeals_guard ON app.appeals;\n' + trigger, context),
  ).toEqual([]);
  refused(sql, 'trigger appeals_guard on funds or attribution table appeals', context);
});

it(
  '[AC-CT-06j#9] 真实仓库无参数运行通过，CLI 从冻结迁移史识别 appeals 索引并拒绝只删',
  () => {
    const real = cli([], join(ROOT, 'test'));
    expect(real.status, real.stderr + real.stdout).toBe(0);
    // 不断言 nothing to lint；仓库可继续新增合法迁移。
    fixture('DROP INDEX app.appeals_user_idx;', (root) => {
      cliRefused(
        root,
        'index appeals_user_idx on funds or attribution table appeals may not be dropped',
      );
    });
  },
  CLI_TIMEOUT_MS,
);
