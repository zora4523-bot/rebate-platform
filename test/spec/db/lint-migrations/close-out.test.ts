import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  checkMigration,
  checkTimeouts,
  normaliseDefinition,
  type MigrationContext,
  type Problem,
} from '../../../../tools/ci/lint-migrations.ts';
import { ROOT, SCRIPT, TIMEOUTS } from './kit.ts';

// CT-06f §9.2①～⑤。只在编排者的隔离容器运行；每组配对放行与拒绝，
// 保留已支持行为的回归断言，并包含 CT-06d 尚未支持的新契约断言。
const FILE = '0022_close-out.sql';
const CLI_TIMEOUT_MS = 60_000;
const EMPTY: MigrationContext = { schemaSql: '', migrationsSql: [], approved: false };
const DO_GUARD = 'guard change inside a DO block: write it as plain SQL';

function refused(sql: string, message: string, context: MigrationContext = EMPTY): void {
  const problems: Problem[] = checkMigration(FILE, sql, context);
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

function quoted(body: string): string {
  return `'${body.replaceAll("'", "''")}'`;
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
  const scratch = join(ROOT, '.tmp/ct-06f');
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

it('[AC-CT-06f#1] 资金与归属表索引必须有名，各可选修饰不能隐藏缺名', () => {
  for (const table of ['orders', 'ledger_entries', 'union_bindings', 'idempotency_keys']) {
    for (const modifiers of ['', 'UNIQUE ']) {
      for (const options of [
        '',
        'CONCURRENTLY ',
        'IF NOT EXISTS ',
        'CONCURRENTLY IF NOT EXISTS ',
      ]) {
        for (const target of [`app.${table}`, `ONLY "app"."${table}"`]) {
          const head = `CREATE ${modifiers}INDEX ${options}`;
          expect(
            checkMigration(FILE, `${head}"explicit_idx" ON ${target} (app_id);`, EMPTY),
          ).toEqual([]);
          expect(checkMigration(FILE, `${head}ON app.articles (app_id);`, EMPTY)).toEqual([]);
          refused(
            `${head}ON ${target} (app_id);`,
            `unnamed index on funds or attribution table ${table}`,
          );
        }
      }
    }
  }
});

const COLUMN_CONSTRAINTS = [
  'PRIMARY KEY',
  'UNIQUE',
  'CHECK (id >= 0)',
  'REFERENCES app.articles (id)',
];
const TABLE_CONSTRAINTS = [
  'PRIMARY KEY (id)',
  'UNIQUE (id)',
  'CHECK (id >= 0)',
  'FOREIGN KEY (id) REFERENCES app.articles (id)',
  'EXCLUDE USING btree (id WITH =)',
];

it('[AC-CT-06f#2] CREATE TABLE 的列约束与表约束均须逐个命名', () => {
  for (const constraint of COLUMN_CONSTRAINTS) {
    expect(
      checkMigration(
        FILE,
        `CREATE TABLE app.orders (id bigint CONSTRAINT explicit_guard ${constraint});`,
        EMPTY,
      ),
    ).toEqual([]);
    expect(
      checkMigration(FILE, `CREATE TABLE app.articles (id bigint ${constraint});`, EMPTY),
    ).toEqual([]);
    refused(
      `CREATE TABLE "app"."orders" (id bigint ${constraint});`,
      'unnamed constraint on funds or attribution table orders',
    );
  }
  for (const constraint of TABLE_CONSTRAINTS) {
    expect(
      checkMigration(
        FILE,
        `CREATE TABLE app.orders (id bigint, CONSTRAINT explicit_guard ${constraint});`,
        EMPTY,
      ),
    ).toEqual([]);
    expect(
      checkMigration(FILE, `CREATE TABLE app.articles (id bigint, ${constraint});`, EMPTY),
    ).toEqual([]);
    refused(
      `CREATE TABLE app.orders (id bigint, ${constraint});`,
      'unnamed constraint on funds or attribution table orders',
    );
  }
});

it('[AC-CT-06f#3] ALTER TABLE ADD 的列约束和表约束须命名，逗号后的子命令也检查', () => {
  for (const column of ['COLUMN ', '']) {
    for (const constraint of COLUMN_CONSTRAINTS) {
      const named = `ALTER TABLE ONLY "app"."orders" ADD ${column}id bigint CONSTRAINT explicit_guard ${constraint};`;
      expect(checkMigration(FILE, named, EMPTY)).toEqual([]);
      const unnamed = named.replace('CONSTRAINT explicit_guard ', '');
      expect(checkMigration(FILE, unnamed.replace('"orders"', '"articles"'), EMPTY)).toEqual([]);
      refused(unnamed, 'unnamed constraint on funds or attribution table orders');
    }
  }
  for (const constraint of TABLE_CONSTRAINTS) {
    const head = 'ALTER TABLE app.orders ADD COLUMN note text, ADD ';
    expect(checkMigration(FILE, `${head}CONSTRAINT explicit_guard ${constraint};`, EMPTY)).toEqual(
      [],
    );
    expect(
      checkMigration(FILE, `${head.replace('app.orders', 'app.articles')}${constraint};`, EMPTY),
    ).toEqual([]);
    refused(`${head}${constraint};`, 'unnamed constraint on funds or attribution table orders');
  }
});

it('[AC-CT-06f#4] NOT NULL、DEFAULT、GENERATED 与文本不算待命名约束，一个名字不覆盖后续约束', () => {
  const columns = `id bigint GENERATED ALWAYS AS IDENTITY,
    amount_fen bigint NOT NULL DEFAULT 0,
    label text DEFAULT 'PRIMARY KEY UNIQUE CHECK REFERENCES EXCLUDE',
    doubled bigint GENERATED ALWAYS AS (amount_fen * 2) STORED,
    other_id bigint CONSTRAINT explicit_check CHECK (other_id >= 0)`;
  expect(checkMigration(FILE, `CREATE TABLE app.orders (${columns});`, EMPTY)).toEqual([]);
  expect(
    checkMigration(
      FILE,
      "ALTER TABLE app.orders ADD COLUMN label text NOT NULL DEFAULT 'CHECK UNIQUE';",
      EMPTY,
    ),
  ).toEqual([]);
  for (const sql of [
    `CREATE TABLE app.orders (${columns} UNIQUE);`,
    `CREATE TABLE app.orders (${columns}, UNIQUE (id));`,
    'ALTER TABLE app.orders ADD COLUMN other_id bigint CONSTRAINT explicit_check CHECK (other_id >= 0) REFERENCES app.articles (id);',
    'ALTER TABLE app.orders ADD CONSTRAINT explicit_check CHECK (id >= 0), ADD UNIQUE (id);',
  ])
    refused(sql, 'unnamed constraint on funds or attribution table orders');
});

it.each(['CHECK (amount_fen >= 0)', 'FOREIGN KEY (app_id) REFERENCES app.articles (app_id)'])(
  '[AC-CT-06f#5] %s 的同定义 NOT VALID 重建仅在本文件稍后验证同表同名约束时放行',
  (definition) => {
    const original = `ALTER TABLE app.orders ADD CONSTRAINT orders_guard ${definition};`;
    const drop = 'ALTER TABLE app.orders DROP CONSTRAINT orders_guard;\n';
    const add = `ALTER TABLE ONLY "app"."orders" ADD CONSTRAINT "orders_guard" ${definition} NOT VALID;\n`;
    const validate = 'ALTER TABLE orders VALIDATE CONSTRAINT "orders_guard";';
    const message =
      'constraint orders_guard on funds or attribution table orders recreated with a different definition';
    for (const context of [
      { ...EMPTY, schemaSql: original },
      { ...EMPTY, migrationsSql: [original] },
    ]) {
      expect(checkMigration(FILE, drop + original, context)).toEqual([]);
      expect(checkMigration(FILE, drop + add + validate, context)).toEqual([]);
      for (const suffix of [
        '',
        'ALTER TABLE app.articles VALIDATE CONSTRAINT orders_guard;',
        'ALTER TABLE app.orders VALIDATE CONSTRAINT another_guard;',
        `-- ${validate}\nSELECT 1;`,
      ])
        refused(drop + add + suffix, message, context);
      refused(validate + '\n' + drop + add, message, context);
      // VALIDATE 不会使真正改变的谓词或外键目标变回原定义。
      refused(
        drop + add.replace('>= 0', '> 0').replace('app.articles', 'app.other_articles') + validate,
        message,
        context,
      );
      // 先前文件里有 VALIDATE 不能替代本次 ADD 之后的验证。
      refused(drop + add, message, { ...context, migrationsSql: [original, validate] });
    }
  },
);

const TIMEOUT_LITERALS = [
  { label: 'E 十六进制', off: String.raw`E'\x30ms'`, on: String.raw`E'\x35s'` },
  { label: 'E 八进制', off: String.raw`E'\060ms'`, on: String.raw`E'\065s'` },
  { label: 'E Unicode 四位', off: String.raw`E'\u0030ms'`, on: String.raw`E'\u0035s'` },
  { label: 'E Unicode 八位', off: String.raw`E'\U00000030ms'`, on: String.raw`E'\U00000035s'` },
  { label: 'U& 四位', off: String.raw`U&'\0030ms'`, on: String.raw`U&'\0035s'` },
  { label: 'U& 六位', off: String.raw`U&'\+000030ms'`, on: String.raw`U&'\+000035s'` },
  { label: 'U& UESCAPE', off: "U&'!0030ms' UESCAPE '!'", on: "U&'!0035s' UESCAPE '!'" },
  { label: '美元引号', off: '$$0ms$$', on: '$$5s$$' },
  { label: '带标签美元引号', off: '$value$0ms$value$', on: '$value$5s$value$' },
  { label: 'E 空白转义', off: String.raw`E'\t0ms\n'`, on: String.raw`E'\t5s\r\n'` },
];

it.each(TIMEOUT_LITERALS)(
  '[AC-CT-06f#6] $label 在 SET、set_config、DO 与 EXECUTE 中都按解码后的超时取值',
  ({ off, on }) => {
    for (const setting of ['lock_timeout', 'statement_timeout']) {
      const rule = `require-${setting.replace('_', '-')}`;
      const other = setting === 'lock_timeout' ? 'statement_timeout' : 'lock_timeout';
      const contexts = [
        (value: string) => `SET LOCAL ${setting} = ${value}; SET LOCAL ${other} = '30s'; SELECT 1;`,
        (value: string) => TIMEOUTS + `SELECT set_config('${setting}', ${value}, true);`,
        (value: string) =>
          TIMEOUTS + `DO $body$ BEGIN SET LOCAL ${setting} = ${value}; END $body$;`,
        (value: string) =>
          TIMEOUTS +
          `DO $body$ BEGIN PERFORM set_config('${setting}', ${value}, false); END $body$;`,
        (value: string) =>
          TIMEOUTS +
          `DO $body$ BEGIN EXECUTE ${quoted(`SET LOCAL ${setting} = ${value}`)}; END $body$;`,
      ];
      for (const sql of contexts) {
        expect(checkTimeouts(FILE, sql(on)), sql(on)).toEqual([]);
        const problems = checkTimeouts(FILE, sql(off)).join('\n');
        expect(problems, sql(off)).toContain(rule);
        expect(problems, sql(off)).not.toContain(`require-${other.replace('_', '-')}`);
      }
    }
  },
);

it('[AC-CT-06f#7] 未知 E 转义与格式错误的 U& 转义不能被当作已设置超时', () => {
  for (const setting of ['lock_timeout', 'statement_timeout']) {
    for (const value of [
      String.raw`E'5\qs'`,
      String.raw`E'\xZ5s'`,
      String.raw`E'\u035s'`,
      String.raw`U&'\03Z0ms'`,
      String.raw`U&'\+0030ms'`,
      "U&'!03Z0ms' UESCAPE '!'",
    ]) {
      const accepted = TIMEOUTS + `SELECT set_config('${setting}', '5s', true);`;
      expect(checkTimeouts(FILE, accepted)).toEqual([]);
      for (const sql of [
        TIMEOUTS + `SET LOCAL ${setting} = ${value};`,
        TIMEOUTS + `SELECT set_config('${setting}', ${value}, true);`,
        TIMEOUTS + `DO $$ BEGIN SET LOCAL ${setting} = ${value}; END $$;`,
        TIMEOUTS + `DO $$ BEGIN EXECUTE ${quoted(`SET LOCAL ${setting} = ${value}`)}; END $$;`,
      ])
        expect(checkTimeouts(FILE, sql).join('\n'), sql).toContain(
          `require-${setting.replace('_', '-')}`,
        );
    }
  }
});

const EQUIVALENT_LITERALS = [
  [String.raw`E'a\'b'`, "'a''b'"],
  [String.raw`E'a\\b'`, String.raw`'a\b'`],
  [String.raw`E'a\bb'`, "'a\bb'"],
  [String.raw`E'a\fb'`, "'a\fb'"],
  [String.raw`E'a\nb'`, "'a\nb'"],
  [String.raw`E'a\rb'`, "'a\rb'"],
  [String.raw`E'a\tb'`, "'a\tb'"],
  [String.raw`E'\1Z'`, "'\u0001Z'"],
  [String.raw`E'\12Z'`, "'\nZ'"],
  [String.raw`E'\141Z'`, "'aZ'"],
  [String.raw`E'\x6Z'`, "'\u0006Z'"],
  [String.raw`E'\x61Z'`, "'aZ'"],
  [String.raw`E'\u0061Z'`, "'aZ'"],
  [String.raw`E'\U0001F642Z'`, "'🙂Z'"],
  [String.raw`U&'\0061Z'`, "'aZ'"],
  [String.raw`U&'\+01F642Z'`, "'🙂Z'"],
  ["U&'!0061Z' UESCAPE '!'", "'aZ'"],
] as const;

it.each(EQUIVALENT_LITERALS)(
  '[AC-CT-06f#8] 定义比对解码 %s；后续字符串的大小写仍有意义',
  (escaped, plain) => {
    const definition = (literal: string) =>
      `CREATE INDEX orders_guard_idx ON app.orders (app_id) WHERE label = ${literal} AND status = 'ACTIVE';`;
    const original = definition(escaped);
    const equivalent = definition(plain);
    expect(normaliseDefinition(original)).toBe(normaliseDefinition(equivalent));
    // 两边都使用带转义单引号的写法，防止切分错误把后续 ACTIVE 当成 SQL 小写化。
    expect(normaliseDefinition(original)).not.toBe(
      normaliseDefinition(original.replace("'ACTIVE'", "'active'")),
    );
    const context = { ...EMPTY, migrationsSql: [original] };
    const drop = 'DROP INDEX app.orders_guard_idx;\n';
    expect(checkMigration(FILE, drop + equivalent, context)).toEqual([]);
    refused(
      drop + original.replace("'ACTIVE'", "'active'"),
      'index orders_guard_idx on funds or attribution table orders recreated with a different definition',
      context,
    );
  },
);

it('[AC-CT-06f#9] 字面量解码同样用于约束和触发器重建，不能只修复索引比较', () => {
  for (const object of [
    {
      kind: 'constraint',
      name: 'orders_label_guard',
      drop: 'ALTER TABLE app.orders DROP CONSTRAINT orders_label_guard;',
      original: String.raw`ALTER TABLE app.orders ADD CONSTRAINT orders_label_guard CHECK (label = E'a\'b' AND status = 'ACTIVE');`,
    },
    {
      kind: 'trigger',
      name: 'orders_label_guard',
      drop: 'DROP TRIGGER orders_label_guard ON app.orders;',
      original: String.raw`CREATE TRIGGER orders_label_guard BEFORE UPDATE OR DELETE ON app.orders FOR EACH ROW WHEN (OLD.label = E'a\'b' AND OLD.status = 'ACTIVE') EXECUTE FUNCTION app.reject_update_delete();`,
    },
  ]) {
    const context = { ...EMPTY, migrationsSql: [object.original] };
    const equivalent = object.original.replace(String.raw`E'a\'b'`, "'a''b'");
    expect(checkMigration(FILE, object.drop + equivalent, context)).toEqual([]);
    refused(
      object.drop + equivalent.replace("'ACTIVE'", "'active'"),
      `${object.kind} ${object.name} on funds or attribution table orders recreated with a different definition`,
      context,
    );
  }
});

const GUARD_STATEMENTS = [
  'CREATE OR REPLACE TRIGGER guard BEFORE UPDATE ON app.articles FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();',
  'CREATE OR REPLACE CONSTRAINT TRIGGER guard AFTER UPDATE ON app.articles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();',
  "CREATE OR REPLACE FUNCTION app.guard() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'immutable'; END $fn$;",
  "CREATE OR REPLACE PROCEDURE app.guard() LANGUAGE plpgsql AS $fn$ BEGIN RAISE NOTICE 'ok'; END $fn$;",
  'DROP TRIGGER guard ON app.articles;',
  'DROP FUNCTION app.guard();',
  'DROP PROCEDURE app.guard();',
  'DROP INDEX app.articles_guard_idx;',
  'ALTER TABLE app.articles DROP CONSTRAINT guard;',
  'ALTER TABLE app.articles DISABLE TRIGGER guard;',
  'ALTER TABLE app.articles ENABLE REPLICA TRIGGER guard;',
];

it.each(GUARD_STATEMENTS)(
  '[AC-CT-06f#10] DO 内保护对象操作一律要求写成普通 SQL：%s',
  (statement) => {
    // 普通表的相同操作写在顶层不受资金表保护限制。
    expect(checkMigration(FILE, statement, EMPTY)).toEqual([]);
    for (const table of ['articles', 'orders']) {
      const body = `BEGIN ${statement.replaceAll('app.articles', `app.${table}`)} END`;
      for (const sql of [
        `DO $body$ ${body} $body$;`,
        `DO LANGUAGE plpgsql ${quoted(body)};`,
        `DO $body$ BEGIN EXECUTE ${quoted(statement.replaceAll('app.articles', `app.${table}`))}; END $body$;`,
      ])
        refused(sql, DO_GUARD);
    }
  },
);

it('[AC-CT-06f#11] DO 的建分区、数据操作、带名索引、RAISE 和注释不误拒', () => {
  for (const statement of [
    'CREATE TABLE app.orders_default PARTITION OF app.orders DEFAULT;',
    'INSERT INTO app.articles (id) VALUES (1);',
    "UPDATE app.articles SET title = 'new' WHERE id = 1;",
    'CREATE INDEX articles_title_idx ON app.articles (title);',
    "RAISE NOTICE 'CREATE OR REPLACE CONSTRAINT TRIGGER; DROP INDEX; ALTER TABLE app.orders DISABLE TRIGGER ALL';",
    "-- DROP FUNCTION app.guard();\nRAISE NOTICE 'ok';",
    "/* CREATE OR REPLACE FUNCTION app.guard() */ RAISE NOTICE 'ok';",
  ]) {
    for (const sql of [
      `DO $body$ BEGIN ${statement} END $body$;`,
      `DO ${quoted(`BEGIN ${statement} END`)};`,
    ])
      expect(checkMigration(FILE, sql, EMPTY), sql).toEqual([]);
  }
  expect(
    checkMigration(
      FILE,
      "DO $$ BEGIN EXECUTE 'CREATE INDEX articles_title_idx ON app.articles (title)'; END $$;",
      EMPTY,
    ),
  ).toEqual([]);
  refused('DO $$ BEGIN ALTER TABLE app.articles DISABLE TRIGGER ALL; END $$;', DO_GUARD);
});

it('[AC-CT-06f#12] EXECUTE 与字符串 DO 正文须先解码，转义后的关键字不能隐藏保护对象替换', () => {
  for (const keyword of [
    String.raw`E'\x43REATE`,
    String.raw`E'\103REATE`,
    String.raw`E'\u0043REATE`,
    String.raw`E'\U00000043REATE`,
    String.raw`U&'\0043REATE`,
  ]) {
    const safe = `${keyword} INDEX articles_guard_idx ON app.articles (id)'`;
    const unsafe = `${keyword} OR REPLACE CONSTRAINT TRIGGER guard AFTER UPDATE ON app.articles FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete()'`;
    expect(checkMigration(FILE, `DO $$ BEGIN EXECUTE ${safe}; END $$;`, EMPTY)).toEqual([]);
    refused(`DO $$ BEGIN EXECUTE ${unsafe}; END $$;`, DO_GUARD);
  }
  const body = String.raw`E'BEGIN \x43REATE OR REPLACE TRIGGER guard BEFORE UPDATE ON app.articles FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete(); END'`;
  expect(
    checkMigration(
      FILE,
      String.raw`DO E'BEGIN \x43REATE INDEX articles_guard_idx ON app.articles (id); END';`,
      EMPTY,
    ),
  ).toEqual([]);
  refused(`DO ${body};`, DO_GUARD);
});

it('[AC-CT-06f#13] EXECUTE 的 E、U& 与美元字符串解码后还须检查关闭超时', () => {
  for (const setting of ['lock_timeout', 'statement_timeout']) {
    for (const value of [
      String.raw`E'\x53ET LOCAL ${setting} = \'0ms\''`,
      String.raw`E'\123ET LOCAL ${setting} = \'0ms\''`,
      String.raw`E'\u0053ET LOCAL ${setting} = \'0ms\''`,
      String.raw`U&'\0053ET LOCAL ${setting} = ''0ms'''`,
      `$sql$SET LOCAL ${setting} = '0ms'$sql$`,
    ]) {
      expect(
        checkTimeouts(
          FILE,
          TIMEOUTS + `DO $body$ BEGIN EXECUTE ${value.replace('0ms', '5s')}; END $body$;`,
        ),
      ).toEqual([]);
      const sql = TIMEOUTS + `DO $body$ BEGIN EXECUTE ${value}; END $body$;`;
      expect(checkTimeouts(FILE, sql).join('\n'), sql).toContain(
        `require-${setting.replace('_', '-')}`,
      );
    }
  }
});

it.each(['FROM', '子查询', 'CTE'])(
  '[AC-CT-06f#14] set_config 在 %s 中的调用仍检查超时；后来重新设置不能抹去关闭记录',
  (position) => {
    const wrap = (call: string) =>
      position === 'FROM'
        ? `SELECT 1 FROM ${call};`
        : position === '子查询'
          ? `SELECT (SELECT ${call});`
          : `WITH s AS (SELECT ${call}) SELECT 1;`;
    for (const setting of ['lock_timeout', 'statement_timeout']) {
      for (const fn of ['set_config', 'pg_catalog.set_config', '"pg_catalog"."set_config"']) {
        for (const local of ['true', 'false']) {
          expect(
            checkTimeouts(FILE, TIMEOUTS + wrap(`${fn}('${setting}', '5s', ${local})`)),
          ).toEqual([]);
          for (const value of ["'0'", "'0ms'", String.raw`E'\x30ms'`, '$v$0ms$v$']) {
            const disable = wrap(`${fn}('${setting}', ${value}, ${local})`);
            for (const sql of [TIMEOUTS + disable, TIMEOUTS + disable + TIMEOUTS]) {
              const problems = checkTimeouts(FILE, sql).join('\n');
              expect(problems, sql).toContain(`require-${setting.replace('_', '-')}`);
              const other = setting === 'lock_timeout' ? 'statement_timeout' : 'lock_timeout';
              expect(problems, sql).not.toContain(`require-${other.replace('_', '-')}`);
            }
          }
        }
      }
    }
  },
);

it(
  '[AC-CT-06f#15] 真实仓库无参数运行通过；CLI 对未命名资金对象写 stderr、退出 1 且不跑 squawk',
  () => {
    // 沿用 CT-06a #13：只要求退出成功，不假设仍然只有冻结迁移。
    const real = cli([], join(ROOT, 'test'));
    expect(real.status, real.stderr + real.stdout).toBe(0);
    for (const [sql, message] of [
      [
        'CREATE INDEX ON app.orders (app_id);',
        'unnamed index on funds or attribution table orders',
      ],
      [
        'CREATE TABLE app.orders (id bigint PRIMARY KEY);',
        'unnamed constraint on funds or attribution table orders',
      ],
      [
        'ALTER TABLE app.orders ADD COLUMN id bigint CHECK (id >= 0);',
        'unnamed constraint on funds or attribution table orders',
      ],
    ]) {
      fixture({ [FILE]: TIMEOUTS + sql }, (root) => {
        // 不存在的 squawk 是哨兵：自检先拒绝，不得走到外部检查器的启动分支。
        const result = cli(['--root', root, '--squawk', join(root, 'absent-squawk')]);
        expect(result.status, result.stderr + result.stdout).toBe(1);
        expect(result.stderr).toContain(message);
        expect(result.stderr).toContain(`${FILE}:`);
        expect(result.stderr).not.toContain('absent-squawk');
        expect(result.stdout).not.toContain('squawk over');
      });
    }
  },
  CLI_TIMEOUT_MS,
);
