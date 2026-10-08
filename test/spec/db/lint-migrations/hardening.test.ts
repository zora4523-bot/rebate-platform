import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { gate, ROOT, run, TIMEOUTS, withFixture } from './kit.ts';

// CLI cases start squawk several times per case; CI runners need more than vitest's 5 s default
// (#18 timed out on CI, rebate-platform#283). Timing only: assertions unchanged.
const CLI_TIMEOUT_MS = 60_000;

// CT-06b §9.2 是本文件的规则来源。通过对照与拒绝样例放在同一断言组，
// 每组都含 CT-06a 尚未实现的行为；不靠修改实现或测试钩子制造先红。
const FILE = '0020_hardening.sql';
const DDL = 'CREATE TABLE app.articles (id bigint PRIMARY KEY);';
const FROZEN_NAMES = [
  '0001_app-schema.sql',
  '0002_pgboss-schema-v42.sql',
  '0003_platform-baseline.sql',
  '0004_idempotency-keys-abandoned.sql',
  '0005_identity-baseline.sql',
  '0006_linking-baseline.sql',
  '0007_orders-baseline.sql',
  '0008_notification-baseline.sql',
  '0009_payout-account-baseline.sql',
  '0010_content-config-baseline.sql',
  '0011_partition-maintenance.sql',
  '0012_link-logs-day-partitions.sql',
  '0013_identity-sessions.sql',
  '0014_risk-baseline.sql',
  '0015_union-accounts-pids.sql',
  '0016_admin-baseline.sql',
  '0017_catalog-baseline.sql',
  '0018_linking-bindings.sql',
  '0019_device-registrations-created-at-insert.sql',
] as const;

async function positionGate() {
  const module = (await gate()) as Awaited<ReturnType<typeof gate>> & {
    fundsTableAt(sql: string, line: number, column: number): string | null;
  };
  expect(typeof module.fundsTableAt).toBe('function');
  return module;
}

async function timeoutGate() {
  const module = (await gate()) as Awaited<ReturnType<typeof gate>> & {
    checkTimeouts(file: string, sql: string): string[];
  };
  expect(typeof module.checkTimeouts).toBe('function');
  return module;
}

function frozenFiles(): Record<string, string> {
  return Object.fromEntries(
    FROZEN_NAMES.map((name) => [name, readFileSync(join(ROOT, 'db/migrations', name), 'utf8')]),
  );
}

// 不存在的显式 binary：若错误地继续调用 squawk，会得到退出 2，而不是约定的 1。
// 这些测试只在编排者的隔离容器里执行。
function refuseBeforeSquawk(root: string, message: string): void {
  const result = run(['--root', root, '--squawk', join(root, 'absent-squawk')]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain('absent-squawk');
  expect(result.stdout).not.toContain('squawk over');
  expect(result.stdout).not.toMatch(/:\d+:\d+: warning:/);
}

function expectProblem(
  problems: ReturnType<Awaited<ReturnType<typeof gate>>['checkMigration']>,
  sql: string,
  message: string,
): void {
  expect(problems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ file: FILE, message: expect.stringContaining(message) }),
    ]),
  );
  for (const problem of problems) {
    expect(Number.isInteger(problem.line)).toBe(true);
    expect(problem.line).toBeGreaterThanOrEqual(1);
    expect(problem.line).toBeLessThanOrEqual(sql.split('\n').length);
  }
}

it('[AC-CT-06b#1] UTF-8 字节列号转换到 JS 下标，覆盖中文与代理对', async () => {
  await gate();
  const url = new URL('../../../../tools/ci/lint-migrations.ts', import.meta.url).href;
  const module = (await import(/* @vite-ignore */ url)) as {
    byteColumnToIndex?: (lineText: string, byteColumn: number) => number;
  };
  expect(typeof module.byteColumnToIndex, '应导出 byteColumnToIndex').toBe('function');
  const convert = module.byteColumnToIndex!;
  expect(convert('', 0)).toBe(0);
  expect(convert('ALTER TABLE', 6)).toBe(6);
  expect(convert('-- 中文; ALTER', 10)).toBe(6);
  expect(convert('中😀; ALTER', 7)).toBe(3);
  expect(convert('中文', 6)).toBe(2);
});

it('[AC-CT-06b#2] fundsTableAt 以零起算行及字节列定位，不能跨到相邻语句', async () => {
  const { fundsTableAt } = await positionGate();
  const first = 'ALTER TABLE app.articles DROP COLUMN a; ';
  const target = 'ALTER TABLE app.orders DROP COLUMN c;';
  expect(fundsTableAt(first + target, 0, first.length)).toBe('app.orders');
  expect(fundsTableAt(first + target, 0, 0)).toBeNull();
  for (const prefix of [`/* ${'中文'.repeat(24)} */ `, `SELECT '${'中文'.repeat(24)}'; `]) {
    const line = first + prefix + target;
    const sql = `-- 前一行也有中文\n${line}\nALTER TABLE app.articles ADD COLUMN title text;`;
    const column = Buffer.byteLength(first + prefix, 'utf8');
    expect(fundsTableAt(sql, 1, column), prefix).toBe('app.orders');
    expect(fundsTableAt(sql, 2, 0)).toBeNull();
  }
});

it(
  '[AC-CT-06b#3] CLI 的真实 squawk 告警含中文前缀时仍禁止资金表借用同行 ignore',
  () => {
    for (const prefix of [`/* ${'中文'.repeat(24)} */ `, `SELECT '${'中文'.repeat(24)}'; `]) {
      // ignore 属于第一条非资金语句；后面的 orders 只能由去掉 ignore 的二次扫描发现。
      const sql = `${TIMEOUTS}-- Obsolete article column.\n-- squawk-ignore ban-drop-column\nALTER TABLE app.articles DROP COLUMN a; ${prefix}ALTER TABLE app.orders DROP COLUMN c;`;
      withFixture({ [FILE]: sql.replace('app.orders', 'app.other_articles') }, (root) => {
        const result = run(['--root', root]);
        expect(result.status, result.stderr + result.stdout).toBe(0);
      });
      withFixture({ [FILE]: sql }, (root) => {
        const result = run(['--root', root]);
        expect(result.status, result.stderr + result.stdout).toBe(1);
        expect(result.stderr).toContain('funds or attribution table orders');
      });
    }
  },
  CLI_TIMEOUT_MS,
);

it('[AC-CT-06b#4] 两种超时必须有效且在 DDL 前设置，零值、取整为零、DEFAULT 与注释均不能绕过', async () => {
  const { checkTimeouts } = await timeoutGate();
  for (const value of ["'5s'", '1', "'1ms'", "'0.001s'"]) {
    expect(
      checkTimeouts(
        FILE,
        `SET LOCAL lock_timeout = ${value}; -- not set to 0\nSET LOCAL statement_timeout = ${value} /* not 0 */;\n${DDL}`,
      ),
    ).toEqual([]);
  }
  const badValues = [
    '0.4',
    "'0.4ms'",
    '0',
    "'0'",
    "'0ms'",
    "'0s'",
    "'0min'",
    "'0h'",
    "'0d'",
    'DEFAULT',
  ];
  for (const setting of ['lock_timeout', 'statement_timeout']) {
    const other = setting === 'lock_timeout' ? 'statement_timeout' : 'lock_timeout';
    const rule = `require-${setting.replace('_', '-')}`;
    for (const value of badValues) {
      for (const operator of ['=', 'TO']) {
        for (const tail of [';', ' /* x */;', '; -- later\n', ' -- x\n;']) {
          const sql = `SET LOCAL ${setting} ${operator} ${value}${tail}\nSET LOCAL ${other} = '5s';\n${DDL}`;
          const problems = checkTimeouts(FILE, sql);
          expect(problems, sql).toHaveLength(1);
          expect(problems[0]).toMatch(
            new RegExp(`^${FILE.replace('.', '\\.')}:\\d+:\\d+: warning: ${rule}\\b`),
          );
        }
      }
    }
    expect(
      checkTimeouts(FILE, `SET LOCAL ${other} = '5s';\n${DDL}\nSET LOCAL ${setting} = '5s';`),
    ).toEqual([expect.stringContaining(rule)]);
  }
});

it('[AC-CT-06b#5] 任意位置 RESET 或重新禁用超时都报错，后来恢复有效值也不能掩盖', async () => {
  const { checkTimeouts } = await timeoutGate();
  expect(
    checkTimeouts(FILE, `${TIMEOUTS}${DDL}\n-- RESET ALL;\nSELECT 'RESET lock_timeout;';`),
  ).toEqual([]);
  const cases = [
    ['RESET ALL;', ['require-lock-timeout', 'require-statement-timeout']],
    ['RESET lock_timeout;', ['require-lock-timeout']],
    ['RESET statement_timeout;', ['require-statement-timeout']],
    ['SET lock_timeout = 0;', ['require-lock-timeout']],
    ['SET SESSION statement_timeout = DEFAULT;', ['require-statement-timeout']],
    ['SET statement_timeout TO 0;', ['require-statement-timeout']],
    ...['lock_timeout', 'statement_timeout'].flatMap((setting) =>
      ['0', "'0ms'", '0.4', "'0.4ms'", 'DEFAULT'].map(
        (value) =>
          [
            `SET LOCAL ${setting} = ${value} /* disabled */;`,
            [`require-${setting.replace('_', '-')}`],
          ] as const,
      ),
    ),
  ] as const;
  for (const [disable, rules] of cases) {
    for (const sql of [
      `${disable}\n${TIMEOUTS}${DDL}`,
      `${TIMEOUTS}${disable}\n${DDL}`,
      `${TIMEOUTS}${DDL}\n${disable}`,
      `${TIMEOUTS}${DDL}\n${disable}\n${TIMEOUTS}`,
    ]) {
      const problems = checkTimeouts(FILE, sql);
      expect(problems, sql).toHaveLength(rules.length);
      for (const rule of rules)
        expect(problems).toEqual(expect.arrayContaining([expect.stringContaining(rule)]));
    }
  }
});

it(
  '[AC-CT-06b#6] CLI 超时错误走 stdout 的 gcc 诊断并在 squawk 前退出',
  () => {
    const cases = [
      [
        "SET LOCAL lock_timeout = 0.4;\nSET LOCAL statement_timeout = '5s';",
        ['require-lock-timeout'],
      ],
      [
        "SET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout TO DEFAULT;",
        ['require-statement-timeout'],
      ],
      [`${TIMEOUTS}${DDL}\nRESET ALL;`, ['require-lock-timeout', 'require-statement-timeout']],
      [`${TIMEOUTS}${DDL}\nSET LOCAL lock_timeout = 0 /* x */;`, ['require-lock-timeout']],
    ] as const;
    withFixture({ [FILE]: TIMEOUTS + DDL }, (root) => {
      expect(run(['--root', root]).status).toBe(0);
    });
    for (const [sql, rules] of cases) {
      withFixture({ [FILE]: sql + '\n' + DDL }, (root) => {
        const result = run(['--root', root, '--squawk', join(root, 'absent-squawk')]);
        expect(result.status).toBe(1);
        for (const rule of rules) {
          expect(result.stdout).toMatch(
            new RegExp(`${FILE.replace('.', '\\.')}:\\d+:\\d+: warning: ${rule}\\b`),
          );
          expect(result.stderr).not.toContain(rule);
        }
        expect(result.stderr).not.toContain('absent-squawk');
        expect(result.stdout).not.toContain('squawk over');
      });
    }
  },
  CLI_TIMEOUT_MS,
);

it('[AC-CT-06b#7] 冻结清单确切收录 19 个原文件及 sha256，保留选择语义和真实仓库空操作', async () => {
  const module = await gate();
  expect(module.GATE_BASELINE).toBe(18);
  const names = [...FROZEN_NAMES, '0021_b.sql', '0020_a.sql', '0019_new.sql', 'README.md'];
  const before = [...names];
  expect(module.selectMigrations(names)).toEqual({
    lint: ['0019_new.sql', '0020_a.sql', '0021_b.sql'],
    badNames: [],
  });
  expect(names).toEqual(before);
  expect(module.selectMigrations(['0018_old.sql', '0019_new.sql'], 17)).toEqual({
    lint: ['0018_old.sql', '0019_new.sql'],
    badNames: [],
  });
  const result = run([]);
  const hasNewMigration = readdirSync(join(ROOT, 'db/migrations')).some(
    (name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) > 19,
  );
  if (!hasNewMigration) {
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('nothing to lint');
  }
  for (const message of [
    'changed after merge',
    'is missing',
    'numbered at or below',
    'not a SQL migration',
  ])
    expect(result.stderr).not.toContain(message);
  const url = new URL('../../../../tools/ci/lint-migrations.ts', import.meta.url).href;
  const exports = (await import(/* @vite-ignore */ url)) as {
    FROZEN_MIGRATIONS?: Readonly<Record<string, string>>;
  };
  expect(exports.FROZEN_MIGRATIONS, '应导出冻结文件及内容哈希').toBeDefined();
  const frozen = exports.FROZEN_MIGRATIONS!;
  expect(Object.keys(frozen).sort()).toEqual([...FROZEN_NAMES].sort());
  for (const name of FROZEN_NAMES) {
    expect(frozen[name]).toMatch(/^[a-f0-9]{64}$/);
    expect(frozen[name], name).toBe(
      createHash('sha256')
        .update(readFileSync(join(ROOT, 'db/migrations', name)))
        .digest('hex'),
    );
  }
});

it.each([false, true])(
  '[AC-CT-06b#8] 完整冻结文件可通过，但改动内容必须拒绝且不运行 squawk（有新迁移=%s）',
  (withNewMigration) => {
    withFixture(frozenFiles(), (root) => {
      const result = run(['--root', root, '--squawk', join(root, 'absent-squawk')]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('nothing to lint');
      if (withNewMigration) writeFileSync(join(root, 'db/migrations/0020_new.sql'), TIMEOUTS + DDL);
      for (const name of [
        '0001_app-schema.sql',
        '0019_device-registrations-created-at-insert.sql',
      ]) {
        const path = join(root, 'db/migrations', name);
        const original = readFileSync(path, 'utf8');
        writeFileSync(path, original.replace('-- Up Migration', '-- Up migration'));
        expect(readFileSync(path, 'utf8')).not.toBe(original);
        refuseBeforeSquawk(root, `${name} changed after merge`);
        writeFileSync(path, original);
      }
    });
  },
  CLI_TIMEOUT_MS,
);

it.each([false, true])(
  '[AC-CT-06b#9] 存在真实冻结文件才拒绝基线内陌生文件名，虚构旧文件名夹具仍通过（有新迁移=%s）',
  (withNewMigration) => {
    const extraFiles: Record<string, string> = withNewMigration
      ? { '0020_new.sql': TIMEOUTS + DDL }
      : {};
    withFixture({ [FILE]: TIMEOUTS + DDL }, (root) => {
      expect(run(['--root', root]).status).toBe(0);
    });
    // 与 CT-06a #14、#17 相同：无真实冻结成员时，不检查虚构旧文件的内容或完整性。
    const fictionalOldFiles = {
      '0001_old.sql': 'DROP TABLE app.orders;',
      '0018_frozen.sql': '-- squawk-ignore-file\nINVALID SQL;',
    };
    withFixture(fictionalOldFiles, (root) => {
      const result = run(['--root', root, '--squawk', join(root, 'absent-squawk')]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('nothing to lint');
    });
    withFixture({ ...fictionalOldFiles, [FILE]: TIMEOUTS + DDL }, (root) => {
      const result = run(['--root', root]);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain(`db/migrations/${FILE}`);
    });
    for (const name of ['0001_replacement.sql', '0018_unknown.sql']) {
      withFixture({ [name]: TIMEOUTS + DDL }, (root) => {
        const result = run(['--root', root, '--squawk', join(root, 'absent-squawk')]);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('nothing to lint');
      });
      withFixture({ ...frozenFiles(), ...extraFiles, [name]: TIMEOUTS + DDL }, (root) => {
        refuseBeforeSquawk(root, `${name} is numbered at or below the gate baseline`);
      });
    }
  },
  CLI_TIMEOUT_MS,
);

it.each([false, true])(
  '[AC-CT-06b#10] 冻结集合有任一成员就必须完整，复制全集后删一个也拒绝（有新迁移=%s）',
  (withNewMigration) => {
    const extraFiles: Record<string, string> = withNewMigration
      ? { '0020_new.sql': TIMEOUTS + DDL }
      : {};
    withFixture({}, (root) => {
      const result = run(['--root', root]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('nothing to lint');
    });
    for (const name of ['0001_app-schema.sql', '0019_device-registrations-created-at-insert.sql']) {
      withFixture({ ...frozenFiles(), ...extraFiles }, (root) => {
        unlinkSync(join(root, 'db/migrations', name));
        refuseBeforeSquawk(root, `${name} is missing`);
      });
    }
  },
  CLI_TIMEOUT_MS,
);

it.each([false, true])(
  '[AC-CT-06b#11] 可执行的非 SQL 迁移全部拒绝，README 与备份不误报（有新迁移=%s）',
  (withNewMigration) => {
    const extraFiles: Record<string, string> = withNewMigration
      ? { '0020_new.sql': TIMEOUTS + DDL }
      : {};
    withFixture({ 'README.md': 'migration notes', '0020_x.sql.bak': 'backup' }, (root) => {
      expect(run(['--root', root]).status).toBe(0);
    });
    for (const extension of ['ts', 'js', 'cjs', 'mjs']) {
      const name = `0020_x.${extension}`;
      withFixture(
        { ...extraFiles, [name]: '// migration tool would execute this file\n' },
        (root) => {
          refuseBeforeSquawk(root, `${name} is not a SQL migration`);
        },
      );
    }
  },
  CLI_TIMEOUT_MS,
);

const DO_SAFE = [
  'DO $$ BEGIN CREATE TABLE app.article_default PARTITION OF app.articles DEFAULT; END $$;',
  "DO $task$ BEGIN INSERT INTO app.articles (id) VALUES (1); RAISE NOTICE 'ready'; END $task$;",
  "DO LANGUAGE plpgsql $$ BEGIN RAISE NOTICE 'ready'; END $$;",
];
const DO_BAD = [
  'DO $$ BEGIN DROP TABLE app.articles; END $$;',
  'do $task$ begin alter table app.articles rename column a to b; end $task$;',
  'DO LANGUAGE plpgsql $$ BEGIN TRUNCATE TABLE app.articles; END $$;',
  'DO $task$ BEGIN ALTER TABLE app.articles ALTER COLUMN a TYPE bigint; END $task$;',
  "DO $$ BEGIN EXECUTE 'DROP TABLE app.articles'; END $$;",
  "DO $$ DECLARE t text := 'articles'; BEGIN EXECUTE format('ALTER TABLE %I RENAME TO x', t); END $$;",
];

it('[AC-CT-06b#12] DO 的匿名或命名正文禁止破坏性 DDL，正常分区、INSERT、RAISE 可通过', async () => {
  const { checkMigration } = await gate();
  for (const sql of DO_SAFE) expect(checkMigration(FILE, sql), sql).toEqual([]);
  for (const sql of DO_BAD) {
    for (const prefix of ['', '-- squawk-ignore ban-drop-table\n']) {
      expectProblem(
        checkMigration(FILE, prefix + sql),
        prefix + sql,
        'destructive DDL inside a DO block',
      );
    }
  }
});

const SCHEMA_BAD = [
  ['ALTER TABLE app.orders SET SCHEMA archive;', 'orders'],
  ['ALTER TABLE IF EXISTS app.orders SET SCHEMA archive;', 'orders'],
  ['ALTER TABLE ONLY app.links SET SCHEMA archive;', 'links'],
  ['ALTER TABLE IF EXISTS ONLY "app"."orders" SET SCHEMA archive;', 'orders'],
] as const;

it('[AC-CT-06b#13] 资金与归属表不能 SET SCHEMA，非资金表和注释不误报', async () => {
  const { checkMigration, isFundsTable } = await gate();
  for (const sql of [
    'ALTER TABLE app.articles SET SCHEMA archive;',
    'ALTER TABLE IF EXISTS ONLY "orders"."articles" SET SCHEMA archive;',
    "-- ALTER TABLE app.orders SET SCHEMA archive;\nSELECT 'ALTER TABLE app.orders SET SCHEMA archive';",
  ])
    expect(checkMigration(FILE, sql), sql).toEqual([]);
  for (const [sql, name] of SCHEMA_BAD) {
    expect(isFundsTable(name)).toBe(true);
    for (const prefix of ['', '-- squawk-ignore ban-drop-table\n']) {
      expectProblem(
        checkMigration(FILE, prefix + sql),
        prefix + sql,
        `funds or attribution table ${name}`,
      );
    }
  }
});

const RENAME_BAD = [
  'ALTER TABLE app.articles RENAME COLUMN amount TO amount_fen;',
  'ALTER TABLE app.articles RENAME amount TO amount_fen;',
  'ALTER TABLE "app"."articles" RENAME COLUMN "amount" TO "amount_fen";',
];

it('[AC-CT-06b#14] 任何表不能通过列改名产出金额列，非金额列改名与 bigint 声明通过', async () => {
  const { checkMigration } = await gate();
  for (const sql of [
    'ALTER TABLE app.articles RENAME COLUMN a TO b;',
    'ALTER TABLE app.articles RENAME a TO amount_fen_note;',
    'CREATE TABLE app.articles (amount_fen bigint);',
  ])
    expect(checkMigration(FILE, sql), sql).toEqual([]);
  for (const sql of RENAME_BAD) {
    for (const prefix of ['', '-- squawk-ignore renaming-column\n']) {
      expectProblem(
        checkMigration(FILE, prefix + sql),
        prefix + sql,
        'money column amount_fen must be declared as bigint, not renamed into',
      );
    }
  }
});

const DERIVED_BAD = [
  'CREATE TABLE app.t AS SELECT 1 AS amount_fen;',
  'CREATE TABLE app.t (amount_fen) AS SELECT 1;',
  'CREATE TABLE app.t AS SELECT amount_fen FROM app.source;',
  'CREATE TABLE app.t AS TABLE app.source_fen;',
  'SELECT 1 AS amount_fen INTO app.t;',
  'SELECT "amount_fen" INTO app.t FROM app.source;',
];
const DERIVED_SAFE = [
  'CREATE TABLE app.t AS SELECT 1 AS amount;',
  'CREATE TABLE app.t AS TABLE app.source;',
  'SELECT 1 AS amount INTO app.t;',
  "CREATE TABLE app.t AS SELECT 'amount_fen' AS note; -- fee_fen\n",
  'CREATE TABLE app.t AS /* fee_fen */ TABLE app.source;',
  "SELECT 'amount_fen' AS note INTO app.t; /* fee_fen */",
  'CREATE TABLE app.t AS SELECT 1 AS amount_fen_note;',
  'CREATE TABLE app.t (amount_fen bigint);',
  'INSERT INTO app.t (amount_fen) SELECT amount_fen FROM app.old;',
  'WITH s AS (SELECT amount_fen FROM app.old) INSERT INTO app.t (amount_fen) SELECT amount_fen FROM s;',
];

it('[AC-CT-06b#15] CTAS、AS TABLE 与 SELECT INTO 含金额标识符时拒绝，字符串和注释不算', async () => {
  const { checkMigration } = await gate();
  for (const sql of DERIVED_SAFE) expect(checkMigration(FILE, sql), sql).toEqual([]);
  for (const sql of DERIVED_BAD) {
    for (const prefix of ['', '-- squawk-ignore ban-drop-table\n']) {
      expectProblem(checkMigration(FILE, prefix + sql), prefix + sql, 'must be declared as bigint');
    }
  }
});

const QUOTED_MONEY_BAD = [
  'CREATE TABLE app.t ("amount_fen"integer);',
  'ALTER TABLE app.t ADD COLUMN"amount_fen"integer;',
];
const QUOTED_FUNDS_BAD = [
  'DROP TABLE"app"."orders"; -- squawk-ignore ban-drop-table',
  'ALTER TABLE"app"."orders"DROP COLUMN c; -- squawk-ignore ban-drop-column',
];

it('[AC-CT-06b#16] 引号金额列紧贴类型或 COLUMN 时照常校验，bigint 与 int8 通过', async () => {
  const { checkMigration } = await gate();
  for (const sql of QUOTED_MONEY_BAD) {
    for (const type of ['bigint', 'int8'])
      expect(checkMigration(FILE, sql.replace('integer', type))).toEqual([]);
    expectProblem(checkMigration(FILE, sql), sql, 'amount_fen must be bigint');
  }
});

it('[AC-CT-06b#17] 引号表名紧贴 TABLE 或 DROP 时照常拒绝资金表 ignore，非资金表通过', async () => {
  const { checkMigration } = await gate();
  for (const sql of QUOTED_FUNDS_BAD) {
    expect(checkMigration(FILE, sql.replace('"orders"', '"articles"'))).toEqual([]);
    expectProblem(checkMigration(FILE, sql), sql, 'funds or attribution table orders');
  }
});

it(
  '[AC-CT-06b#18] CLI 新自检统一写 stderr 并在 squawk 前拒绝，合法紧贴金额声明仍通过',
  () => {
    withFixture(
      { [FILE]: TIMEOUTS + 'CREATE TABLE app.t (id bigint PRIMARY KEY, "amount_fen"bigint);' },
      (root) => {
        expect(run(['--root', root]).status).toBe(0);
      },
    );
    const cases: readonly (readonly [string, string])[] = [
      ...DO_BAD.map((sql) => [sql, 'destructive DDL inside a DO block'] as const),
      ...SCHEMA_BAD.map(([sql, name]) => [sql, `funds or attribution table ${name}`] as const),
      ...RENAME_BAD.map(
        (sql) =>
          [sql, 'money column amount_fen must be declared as bigint, not renamed into'] as const,
      ),
      ...DERIVED_BAD.map((sql) => [sql, 'must be declared as bigint'] as const),
      ...QUOTED_MONEY_BAD.map((sql) => [sql, 'amount_fen must be bigint'] as const),
      ...QUOTED_FUNDS_BAD.map((sql) => [sql, 'funds or attribution table orders'] as const),
    ];
    for (const [sql, message] of cases) {
      withFixture({ [FILE]: TIMEOUTS + sql }, (root) => refuseBeforeSquawk(root, message));
    }
  },
  CLI_TIMEOUT_MS,
);
