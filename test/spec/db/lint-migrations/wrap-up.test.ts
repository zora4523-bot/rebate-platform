import { expect, it } from 'vitest';
import {
  classOfPath,
  findProtectedHits,
  loadProtected,
} from '../../../../tools/guard/lib/protected.ts';
import { gate, ROOT, run, TIMEOUTS, withFixture } from './kit.ts';

// CT-06d §9.2②～⑦；放行与拒绝配对，每组均含 CT-06c 尚未实现的行为。
const FILE = '0021_wrap-up.sql';
const CLI_TIMEOUT_MS = 60_000;
type Check = Awaited<ReturnType<typeof gate>>['checkMigration'];

function refused(check: Check, sql: string, message: string): void {
  const problems = check(FILE, sql);
  expect(problems, sql).toEqual(
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

async function timeoutChecker(): Promise<(file: string, sql: string) => string[]> {
  const module = (await gate()) as Awaited<ReturnType<typeof gate>> & {
    checkTimeouts?: (file: string, sql: string) => string[];
  };
  expect(typeof module.checkTimeouts).toBe('function');
  return module.checkTimeouts!;
}

it('[AC-CT-06d#9] 资金表索引和触发器改名均拒绝，普通表对象不受此限制', async () => {
  const { checkMigration: check } = await gate();
  for (const [definition, mutation, message] of [
    [
      'CREATE INDEX neutral_idx ON app.orders (order_id);',
      'ALTER INDEX app.neutral_idx RENAME TO renamed_idx;',
      'index neutral_idx on funds or attribution table orders',
    ],
    [
      'CREATE INDEX neutral_idx ON app.orders (order_id);',
      'ALTER INDEX IF EXISTS "app"."neutral_idx" RENAME TO renamed_idx;',
      'index neutral_idx on funds or attribution table orders',
    ],
    [
      '',
      'ALTER TRIGGER orders_no_rewrite ON app.orders RENAME TO renamed_guard;',
      'trigger orders_no_rewrite on funds or attribution table orders',
    ],
  ] as const) {
    const sql = definition + '\n' + mutation;
    expect(check(FILE, sql.replaceAll('app.orders', 'app.articles'))).toEqual([]);
    refused(check, sql, message);
  }
  // 原名随后重建也不能豁免改名。
  refused(
    check,
    'CREATE INDEX neutral_idx ON app.orders (order_id); ALTER INDEX neutral_idx RENAME TO old_idx; CREATE INDEX neutral_idx ON app.orders (order_id);',
    'index neutral_idx on funds or attribution table orders',
  );
});

it('[AC-CT-06d#10] 资金约束改名须指出对象归属，紧贴引号与普通写法等价', async () => {
  const { checkMigration: check } = await gate();
  for (const sql of [
    'ALTER TABLE app.idempotency_keys RENAME CONSTRAINT idempotency_keys_scope_key TO renamed_key;',
    'ALTER TABLE "app"."idempotency_keys" RENAME CONSTRAINT"idempotency_keys_scope_key"TO"renamed_key";',
  ]) {
    expect(check(FILE, sql.replaceAll('idempotency_keys', 'articles'))).toEqual([]);
    refused(
      check,
      sql,
      'constraint idempotency_keys_scope_key on funds or attribution table idempotency_keys',
    );
  }
});

it('[AC-CT-06d#11] ENABLE REPLICA 与停用同拒，ENABLE 和 ENABLE ALWAYS 放行', async () => {
  const { checkMigration: check } = await gate();
  for (const target of ['orders_no_rewrite', '"orders_no_rewrite"']) {
    for (const mode of ['ENABLE', 'ENABLE ALWAYS'])
      expect(check(FILE, `ALTER TABLE app.orders ${mode} TRIGGER ${target};`)).toEqual([]);
    expect(check(FILE, `ALTER TABLE app.articles ENABLE REPLICA TRIGGER ${target};`)).toEqual([]);
    const sql = `ALTER TABLE app.orders ENABLE REPLICA TRIGGER ${target};`;
    for (const suffix of ['', ` ALTER TABLE app.orders ENABLE ALWAYS TRIGGER ${target};`])
      refused(
        check,
        sql + suffix,
        'trigger orders_no_rewrite on funds or attribution table orders',
      );
  }
});

it('[AC-CT-06d#12] 未知索引按资金表名前缀归属，仅在该表同名重建可通过', async () => {
  const { checkMigration: check } = await gate();
  for (const table of ['orders', 'order_keys', 'idempotency_keys']) {
    const name = `${table}_wrap_idx`;
    const drop = `DROP INDEX app.${name};`;
    const create = `CREATE INDEX ${name} ON app.${table} (app_id);`;
    expect(check(FILE, drop + create)).toEqual([]);
    for (const other of ['articles', 'processed_events'])
      refused(
        check,
        drop + create.replace(`app.${table}`, `app.${other}`),
        `index ${name} on funds or attribution table ${table}`,
      );
  }
});

it.each([
  {
    spaced: 'ALTER TABLE app.idempotency_keys DROP CONSTRAINT "idempotency_keys_scope_key";',
    tight: 'ALTER TABLE app.idempotency_keys DROP CONSTRAINT"idempotency_keys_scope_key";',
    rebuild:
      'ALTER TABLE app.idempotency_keys ADD CONSTRAINT"idempotency_keys_scope_key" UNIQUE (app_id, key);',
    message: 'constraint idempotency_keys_scope_key on funds or attribution table idempotency_keys',
  },
  {
    spaced: 'DROP TRIGGER "order_keys_append_only" ON "app"."order_keys";',
    tight: 'DROP TRIGGER"order_keys_append_only"ON"app"."order_keys";',
    rebuild:
      'CREATE TRIGGER"order_keys_append_only" BEFORE DELETE OR UPDATE ON"app"."order_keys" FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();',
    message: 'trigger order_keys_append_only on funds or attribution table order_keys',
  },
  {
    spaced: 'DROP INDEX "app"."orders_wrap_idx";',
    tight: 'DROP INDEX"app"."orders_wrap_idx";',
    rebuild: 'CREATE INDEX"orders_wrap_idx"ON"app"."orders" (app_id);',
    message: 'index orders_wrap_idx on funds or attribution table orders',
  },
])(
  '[AC-CT-06d#13] 关键字紧贴引号仍识别对象操作：$tight',
  async ({ spaced, tight, rebuild, message }) => {
    const { checkMigration: check } = await gate();
    expect(check(FILE, tight + rebuild)).toEqual([]);
    refused(check, spaced, message);
    refused(check, tight, message);
  },
);

it.each(['lock_timeout', 'statement_timeout'] as const)(
  '[AC-CT-06d#14] set_config 在任意位置关闭 %s 均拒，另一超时不受影响',
  async (setting) => {
    const check = await timeoutChecker();
    const rule = `require-${setting.replace('_', '-')}`;
    const other = setting === 'lock_timeout' ? 'require-statement-timeout' : 'require-lock-timeout';
    expect(check(FILE, TIMEOUTS + `SELECT set_config('${setting}', '1ms', true);`)).toEqual([]);
    expect(
      check(FILE, TIMEOUTS + `-- SELECT set_config('${setting}', '0', true);\nSELECT 1;`),
    ).toEqual([]);
    for (const value of ['0', '0ms', '']) {
      for (const local of ['true', 'false']) {
        const disable = `SELECT set_config('${setting}', '${value}', ${local});`;
        for (const sql of [disable + TIMEOUTS, TIMEOUTS + disable, TIMEOUTS + disable + TIMEOUTS]) {
          const result = check(FILE, sql);
          expect(result.join('\n'), sql).toContain(rule);
          // 设置在文件头时，只应失去被关闭的那一个超时。
          if (sql.startsWith(TIMEOUTS)) expect(result.join('\n')).not.toContain(other);
        }
      }
    }
  },
);

it.each(['lock_timeout', 'statement_timeout'] as const)(
  '[AC-CT-06d#15] %s 的引号参数名和 E/U& 字面量不能绕过关闭检测',
  async (setting) => {
    const check = await timeoutChecker();
    const rule = `require-${setting.replace('_', '-')}`;
    for (const name of [setting, `"${setting}"`]) {
      const other = setting === 'lock_timeout' ? 'statement_timeout' : 'lock_timeout';
      for (const value of ["E'1ms'", "U&'1ms'"])
        expect(
          check(FILE, `SET LOCAL ${name} = ${value}; SET LOCAL ${other} = '1s'; SELECT 1;`),
        ).toEqual([]);
      for (const value of ['0', "E'0'", "U&'0'", "E'0ms'", "U&'0ms'"]) {
        const sql = TIMEOUTS + `SET LOCAL ${name} = ${value};`;
        expect(check(FILE, sql).join('\n'), sql).toContain(rule);
      }
    }
  },
);

it.each(['pg_catalog.set_config', '"set_config"', '"pg_catalog"."set_config"'])(
  '[AC-CT-06d#28] %s 的 schema 前缀和函数名引号不能绕过关闭超时检测',
  async (fn) => {
    const check = await timeoutChecker();
    for (const setting of ['lock_timeout', 'statement_timeout']) {
      const rule = `require-${setting.replace('_', '-')}`;
      const other =
        setting === 'lock_timeout' ? 'require-statement-timeout' : 'require-lock-timeout';
      expect(check(FILE, TIMEOUTS + `SELECT ${fn}('${setting}', '1ms', true);`)).toEqual([]);
      expect(
        check(FILE, TIMEOUTS + `-- SELECT ${fn}('${setting}', '0', true);\nSELECT 1;`),
      ).toEqual([]);
      for (const local of ['true', 'false']) {
        for (const value of ['0', '0ms', '']) {
          const disable = `SELECT ${fn}('${setting}', '${value}', ${local});`;
          for (const sql of [TIMEOUTS + disable, TIMEOUTS + disable + TIMEOUTS]) {
            const result = check(FILE, sql).join('\n');
            expect(result, sql).toContain(rule);
            expect(result, sql).not.toContain(other);
          }
        }
      }
    }
  },
);

it.each(['lock_timeout', 'statement_timeout'] as const)(
  '[AC-CT-06d#16] DO 内 SET、RESET、set_config 关闭 %s，普通和美元引号正文都检查',
  async (setting) => {
    const check = await timeoutChecker();
    const rule = `require-${setting.replace('_', '-')}`;
    expect(check(FILE, TIMEOUTS + `DO $$ BEGIN SET LOCAL ${setting} = '1ms'; END $$;`)).toEqual([]);
    for (const statement of [
      `SET LOCAL ${setting} = 0;`,
      `RESET ${setting};`,
      `PERFORM set_config('${setting}', '0ms', false);`,
    ]) {
      for (const block of [
        `DO $$ BEGIN ${statement} END $$;`,
        `DO LANGUAGE plpgsql 'BEGIN ${statement.replaceAll("'", "''")} END';`,
      ])
        expect(check(FILE, TIMEOUTS + block).join('\n'), block).toContain(rule);
    }
  },
);

it.each(['lock_timeout', 'statement_timeout'] as const)(
  '[AC-CT-06d#17] %s 按毫秒取整：0.5ms 与 500us 是零，1ms 与 600us 非零',
  async (setting) => {
    const check = await timeoutChecker();
    const other = setting === 'lock_timeout' ? 'statement_timeout' : 'lock_timeout';
    for (const value of ["'1ms'", "'600us'"])
      expect(
        check(FILE, `SET LOCAL ${setting} = ${value}; SET LOCAL ${other} = '1s'; SELECT 1;`),
      ).toEqual([]);
    for (const value of ['0.5', "'0.5 ms'", "'500us'"])
      expect(
        check(FILE, `SET LOCAL ${setting} = ${value}; SET LOCAL ${other} = '1s'; SELECT 1;`).join(
          '\n',
        ),
        value,
      ).toContain(`require-${setting.replace('_', '-')}`);
  },
);

it('[AC-CT-06d#18] DO 中仅 ALTER COLUMN TYPE 算改类型，type 列与 ALTER TYPE 枚举不误拒', async () => {
  const { checkMigration: check } = await gate();
  for (const sql of [
    'DO $$ BEGIN ALTER TABLE app.articles ALTER COLUMN type SET NOT NULL; END $$;',
    "DO $$ BEGIN ALTER TYPE app.article_kind ADD VALUE 'x'; END $$;",
    'DO $$ BEGIN ALTER TABLE app.articles ALTER "type" SET NOT NULL; END $$;',
  ])
    expect(check(FILE, sql), sql).toEqual([]);
  for (const clause of [
    'ALTER COLUMN amount TYPE bigint',
    'ALTER amount TYPE bigint',
    'ALTER COLUMN amount SET DATA TYPE bigint',
  ])
    refused(
      check,
      `DO $$ BEGIN ALTER TABLE app.articles ${clause}; END $$;`,
      'destructive DDL inside a DO block',
    );
});

it('[AC-CT-06d#19] DO 的 RAISE 消息文字不算 DDL，EXECUTE 字符串中的破坏性 DDL 仍拒', async () => {
  const { checkMigration: check } = await gate();
  for (const level of ['NOTICE', 'WARNING', 'EXCEPTION']) {
    const sql = `DO $$ BEGIN RAISE ${level} 'drop old rows; rename; truncate; ALTER TABLE t ALTER x TYPE bigint'; END $$;`;
    expect(check(FILE, sql), sql).toEqual([]);
  }
  refused(
    check,
    "DO $$ BEGIN EXECUTE 'DROP TABLE app.articles'; END $$;",
    'destructive DDL inside a DO block',
  );
});

it.each(['DO', 'DO LANGUAGE plpgsql'])(
  '[AC-CT-06d#20] %s 普通字符串正文与美元引号正文一样禁止破坏性 DDL',
  async (head) => {
    const { checkMigration: check } = await gate();
    expect(check(FILE, `${head} 'BEGIN RAISE NOTICE ''drop old rows''; END';`)).toEqual([]);
    for (const body of [
      "BEGIN EXECUTE 'DROP TABLE app.articles'; END",
      'BEGIN TRUNCATE TABLE app.articles; END',
      'BEGIN ALTER TABLE app.articles RENAME TO old_articles; END',
      'BEGIN ALTER TABLE app.articles ALTER COLUMN amount SET DATA TYPE bigint; END',
    ])
      refused(
        check,
        `${head} '${body.replaceAll("'", "''")}';`,
        'destructive DDL inside a DO block',
      );
  },
);

it('[AC-CT-06d#21] SELECT INTO 的 update 别名、FOR UPDATE 与 WITH 前缀不能隐藏金额列', async () => {
  const { checkMigration: check } = await gate();
  for (const sql of [
    'SELECT amount_fen AS "update" INTO app.copy FROM app.source;',
    'SELECT amount_fen INTO app.copy FROM app.source FOR UPDATE;',
    'WITH s AS (SELECT amount_fen FROM app.source) SELECT amount_fen AS "update" INTO app.copy FROM s;',
    'WITH s AS (SELECT amount_fen FROM app.source) SELECT amount_fen INTO app.copy FROM s FOR UPDATE;',
  ]) {
    expect(check(FILE, sql.replaceAll('amount_fen', 'amount')), sql).toEqual([]);
    refused(check, sql, 'money column amount_fen must be declared as bigint');
  }
  for (const sql of [
    'WITH s AS (SELECT amount_fen FROM app.source) INSERT INTO app.copy (amount_fen) SELECT amount_fen FROM s;',
    'WITH s AS (SELECT amount_fen FROM app.source) UPDATE app.copy SET amount_fen = s.amount_fen FROM s;',
    'SELECT amount_fen FROM app.source FOR UPDATE;',
  ])
    expect(check(FILE, sql), sql).toEqual([]);
});

it('[AC-CT-06d#22] CTAS 的 ON COMMIT、WITH、TABLESPACE 和列名清单不能隐藏金额列', async () => {
  const { checkMigration: check } = await gate();
  for (const sql of [
    'CREATE TEMP TABLE t ON COMMIT DROP AS SELECT amount_fen FROM app.source;',
    'CREATE TEMP TABLE t ON COMMIT DELETE ROWS AS SELECT amount_fen FROM app.source;',
    'CREATE TEMP TABLE t ON COMMIT PRESERVE ROWS AS SELECT amount_fen FROM app.source;',
    'CREATE TABLE app.t WITH (fillfactor = 70) AS SELECT amount_fen FROM app.source;',
    'CREATE TABLE app.t TABLESPACE pg_default AS SELECT amount_fen FROM app.source;',
    'CREATE TEMP TABLE t (amount_fen) WITH (fillfactor = 70) ON COMMIT DROP TABLESPACE pg_default AS SELECT 1;',
  ]) {
    expect(check(FILE, sql.replaceAll('amount_fen', 'amount')), sql).toEqual([]);
    refused(check, sql, 'money column amount_fen must be declared as bigint');
  }
});

it.each(['cts', 'mts', 'jsx', 'tsx'])(
  '[AC-CT-06d#23] CLI 拒绝可执行的 .%s 迁移，README、备份、普通文本维持兼容',
  (extension) => {
    for (const suffix of ['js', 'cjs', 'mjs', 'ts', extension]) {
      const filename = `0021_script.${suffix}`;
      withFixture({ [filename]: 'export {};\n' }, (root) => {
        const result = run(['--root', root]);
        expect(result.status, result.stderr + result.stdout).toBe(1);
        expect(result.stderr).toContain(`${filename} is not a SQL migration`);
      });
    }
    withFixture(
      { 'README.md': '# Migrations', 'notes.txt': 'notes', '0021_x.sql.bak': 'backup' },
      (root) => {
        const result = run(['--root', root]);
        expect(result.status, result.stderr + result.stdout).toBe(0);
      },
    );
  },
  CLI_TIMEOUT_MS,
);

it('[AC-CT-06d#24] 迁移登记为第一类：旧文件修改、删除、改名命中，新增放行', () => {
  const config = loadProtected(ROOT);
  expect(config.class1_add_only).toContain('db/migrations/**');
  const path = 'db/migrations/0001_app-schema.sql';
  expect(classOfPath(path, config)).toBe(1);
  const readers = { readBase: () => '-- old', readWork: () => '-- changed' };
  for (const status of ['M', 'D', 'R'] as const) {
    const change =
      status === 'R'
        ? { status, path: 'db/migrations/0021_renamed.sql', oldPath: path }
        : { status, path };
    expect(findProtectedHits([change], config, readers)).toEqual([
      {
        path,
        class: 1,
        rule: 'db/migrations/**',
        change: { M: 'modified', D: 'deleted', R: 'renamed' }[status],
      },
    ]);
  }
  expect(
    findProtectedHits([{ status: 'R', path: 'archive/old.sql', oldPath: path }], config, readers),
  ).toEqual([{ path, class: 1, rule: 'db/migrations/**', change: 'renamed' }]);
  for (const status of ['A', '?'] as const)
    expect(
      findProtectedHits([{ status, path: 'db/migrations/0021_new.sql' }], config, readers),
    ).toEqual([]);
});
