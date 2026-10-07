import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ROOT, SCRIPT, TIMEOUTS, run, withFixture } from './kit.ts';

const VALID = `${TIMEOUTS}CREATE TABLE app.articles (
  id bigint PRIMARY KEY,
  amount_fen bigint NOT NULL,
  rate_bp integer NOT NULL,
  title text
);
CREATE INDEX articles_title_idx ON app.articles (title);
GRANT SELECT, INSERT ON app.articles TO app_runtime;
CREATE TRIGGER articles_append_only BEFORE UPDATE OR DELETE ON app.articles
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
`;

it('[AC-CT-06a#13] 真实仓库只有冻结迁移时无参数运行成功，根路径不依赖 cwd', () => {
  const result = run([], { cwd: join(ROOT, 'test') });
  expect(result.status, result.stderr).toBe(0);
  // 当前只有 0001–0018；以后新增合法迁移不应使这条规则测试失效。
  const hasNewMigration = readdirSync(join(ROOT, 'db/migrations')).some(
    (name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) > 18,
  );
  if (!hasNewMigration) expect(result.stdout).toContain('nothing to lint');
});

it('[AC-CT-06a#14] 冻结 SQL 不检查，非 SQL 文件忽略，空选集退出 0', () => {
  withFixture(
    {
      '0001_old.sql': 'DROP TABLE app.orders;',
      '0018_frozen.sql': '-- squawk-ignore-file\nINVALID SQL;',
      'notes.txt': 'not SQL',
    },
    (root) => {
      const result = run(['--root', root]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('nothing to lint');
    },
  );
});

it('[AC-CT-06a#15] --list 仅逐行输出新迁移相对路径并排序，不启动 squawk', () => {
  withFixture(
    {
      '0020_second.sql': 'INVALID SQL;',
      '0019_first.sql': 'INVALID SQL;',
      '0018_old.sql': 'INVALID SQL;',
      'notes.txt': 'ignored',
    },
    (root) => {
      const result = run(['--root', root, '--list'], { path: '' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('db/migrations/0019_first.sql\ndb/migrations/0020_second.sql\n');
    },
  );
});

it.each([false, true])(
  '[AC-CT-06a#16] 0019-dash.sql 即使没有可查文件也退出 1（list=%s）',
  (list) => {
    withFixture({ '0019-dash.sql': VALID }, (root) => {
      const result = run(['--root', root, ...(list ? ['--list'] : [])]);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('0019-dash.sql');
      expect(result.stdout).not.toContain('nothing to lint');
    });
  },
);

it('[AC-CT-06a#17] 带双超时的建表、整数比例、普通索引、GRANT 与触发器通过', () => {
  withFixture(
    {
      '0001_old.sql': 'DROP TABLE app.orders;',
      '0018_frozen.sql': '-- squawk-ignore-file\nINVALID SQL;',
      '0019_valid.sql': VALID,
    },
    (root) => {
      const result = run(['--root', root]);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).not.toMatch(/warning:/);
    },
  );
});

it('[AC-CT-06a#15] --list 在没有新迁移时输出空路径列表', () => {
  withFixture({ '0018_frozen.sql': 'INVALID SQL;' }, (root) => {
    const result = run(['--root', root, '--list'], { path: '' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  });
});

it.each([
  ['DROP 列', 'ALTER TABLE app.orders DROP COLUMN old_title;', 'ban-drop-column'],
  ['DROP 表', 'DROP TABLE app.orders;', 'ban-drop-table'],
  ['改类型', 'ALTER TABLE app.orders ALTER COLUMN count TYPE bigint;', 'changing-column-type'],
  ['RENAME 列', 'ALTER TABLE app.orders RENAME COLUMN old_title TO title;', 'renaming-column'],
  ['RENAME 表', 'ALTER TABLE app.orders RENAME TO orders_archive;', 'renaming-table'],
])('[AC-CT-06a#18] %s 被 squawk 拦截，gcc 报告写 stdout', (_label, sql, rule) => {
  withFixture({ '0019_unsafe.sql': TIMEOUTS + sql }, (root) => {
    const result = run(['--root', root]);
    expect(result.status, result.stderr + result.stdout).toBe(1);
    expect(result.stdout).toMatch(new RegExp(`0019_unsafe\\.sql:\\d+:\\d+: warning:.*${rule}`));
  });
});

it.each([
  ['', ['require-lock-timeout', 'require-statement-timeout']],
  ["SET LOCAL lock_timeout = '5s';\n", ['require-statement-timeout']],
  ["SET LOCAL statement_timeout = '30s';\n", ['require-lock-timeout']],
])('[AC-CT-06a#19] 缺失任一种超时都不能通过：%j', (prefix, rules) => {
  withFixture(
    { '0019_timeout.sql': `${prefix}CREATE TABLE app.articles (id bigint PRIMARY KEY);` },
    (root) => {
      const result = run(['--root', root]);
      expect(result.status, result.stderr + result.stdout).toBe(1);
      for (const rule of rules) expect(result.stdout).toContain(rule);
    },
  );
});

it.each([
  ['CREATE TABLE app.articles (amount_fen integer);', 'amount_fen', 'must be bigint'],
  [
    '-- squawk-ignore-file ban-drop-table\nDROP TABLE app.articles;',
    'squawk-ignore-file is not accepted',
    '',
  ],
  [
    '-- squawk-ignore ban-drop-column\nALTER TABLE app.orders DROP COLUMN c;',
    'funds or attribution table orders',
    '',
  ],
  [
    'ALTER TABLE app.orders -- squawk-ignore ban-drop-column\n DROP COLUMN c;',
    'funds or attribution table orders',
    '',
  ],
  [
    '-- squawk-ignore renaming-table\nALTER TABLE app.links RENAME TO old_links;',
    'funds or attribution table links',
    '',
  ],
])('[AC-CT-06a#20] 包装自检优先拒绝 %s，并写 stderr', (sql, message, extra) => {
  withFixture({ '0019_self-check.sql': TIMEOUTS + sql }, (root) => {
    const result = run(['--root', root]);
    expect(result.status, result.stderr + result.stdout).toBe(1);
    expect(result.stderr).toContain(message);
    if (extra) expect(result.stderr).toContain(extra);
    expect(result.stdout).not.toMatch(/:\d+:\d+: warning:/);
  });
});

it('[AC-CT-06a#21] 多文件自检错误都输出，不只检查首文件', () => {
  withFixture(
    {
      '0019_amount.sql': TIMEOUTS + 'CREATE TABLE app.articles (amount_fen integer);',
      '0020_ignore.sql': TIMEOUTS + '-- squawk-ignore-file\nDROP TABLE app.articles;',
      '0021_funds.sql': TIMEOUTS + '-- squawk-ignore ban-drop-table\nDROP TABLE app.orders;',
    },
    (root) => {
      const result = run(['--root', root]);
      expect(result.status, result.stderr).toBe(1);
      for (const message of [
        'must be bigint',
        'squawk-ignore-file is not accepted',
        'funds or attribution table orders',
      ]) {
        expect(
          result.stderr.split('\n').some((line) => line.includes(message)),
          message,
        ).toBe(true);
      }
      expect(result.stdout).not.toMatch(/:\d+:\d+: warning:/);
    },
  );
});

it('[AC-CT-06a#22] 非资金表带原因及语句前 ignore 的 DROP 是合法例外', () => {
  withFixture(
    {
      '0019_exception.sql': `${TIMEOUTS}-- Obsolete article column, backfill already completed.
-- squawk-ignore ban-drop-column
ALTER TABLE app.articles DROP COLUMN old_title;
`,
    },
    (root) => {
      const result = run(['--root', root]);
      expect(result.status, result.stderr + result.stdout).toBe(0);
    },
  );
});

it('[AC-CT-06a#23] 配置缺失退出 2', () => {
  withFixture(
    { '0019_valid.sql': VALID },
    (root) => {
      const result = run(['--root', root]);
      expect(result.status, result.stderr).toBe(2);
    },
    false,
  );
});

it('[AC-CT-06a#24] 没有 squawk 可执行文件时退出 2', () => {
  withFixture({ '0019_valid.sql': VALID }, (root) => {
    // 隔离脚本位置、cwd 与 PATH，不能意外使用真实仓库的 node_modules/.bin。
    expect(existsSync(SCRIPT), '任务要求交付 lint-migrations.ts').toBe(true);
    mkdirSync(join(root, 'tools/ci'), { recursive: true });
    const script = join(root, 'tools/ci/lint-migrations.ts');
    copyFileSync(SCRIPT, script);
    const result = run(['--root', root], { script, cwd: root, path: '' });
    expect(result.status, result.stderr).toBe(2);
  });
});
