import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { gate, requiredText, ROOT, run, TIMEOUTS, withFixture } from './kit.ts';

// 规则来源：CT-06c §9.2。每组包含新增拒绝行为和放行对照，CT-06b 上应因断言失败先红。
// 不扩展 checkMigration 的调用契约：当前文件中的对象定义用 SQL 提供，仓库上下文由 CLI 验收。
const FILE = '0020_funds-objects.sql';
const CLI_TIMEOUT_MS = 60_000;
type Gate = Awaited<ReturnType<typeof gate>>;
type ObjectMap = (schemaSql: string, migrationsSql: readonly string[]) => Map<string, string>;

async function objectMap(name: 'indexOwners' | 'fundsTriggerFunctions'): Promise<ObjectMap> {
  await gate();
  const url = new URL('../../../../tools/ci/lint-migrations.ts', import.meta.url).href;
  const module = (await import(/* @vite-ignore */ url)) as Partial<Record<typeof name, ObjectMap>>;
  expect(typeof module[name], `应导出 ${name}`).toBe('function');
  return module[name]!;
}

function refused(check: Gate['checkMigration'], sql: string, message: string): void {
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

function copySchema(root: string): void {
  copyFileSync(join(ROOT, 'db/schema.sql'), join(root, 'db/schema.sql'));
}

function cliRefused(root: string, message: string): void {
  // 不存在的 binary 用于证明自检先于 squawk；误放行会退出 2，使断言失败。
  const result = run(['--root', root, '--squawk', join(root, 'absent-squawk')]);
  expect(result.status, result.stderr + result.stdout).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toContain('absent-squawk');
  expect(result.stdout).not.toContain('squawk over');
}

it('[AC-CT-06c#1] 去重与接口幂等表按整名纳入，相似名字不纳入', async () => {
  const module = (await gate()) as Gate & { FUNDS_TABLE_NAMES?: readonly string[] };
  const schema = requiredText('db/schema.sql');
  for (const table of ['processed_events_archive', 'idempotency_keys_extra']) {
    expect(module.isFundsTable(`app.${table}`), table).toBe(false);
  }
  for (const table of ['processed_events', 'idempotency_keys']) {
    expect(schema).toContain(`CREATE TABLE app.${table} (`);
    expect(module.FUNDS_TABLE_NAMES).toContain(table);
    for (const ref of [table, `app.${table}`, `"${table}"`, `"app"."${table}"`]) {
      expect(module.isFundsTable(ref), ref).toBe(true);
    }
  }
});

it.each(['processed_events', 'idempotency_keys'])(
  '[AC-CT-06c#2] %s 不接受 squawk-ignore，普通表的相同忽略仍可用',
  async (table) => {
    const { checkMigration } = await gate();
    const sql =
      '-- reason\n-- squawk-ignore ban-drop-column\nALTER TABLE app.articles DROP COLUMN c;';
    expect(checkMigration(FILE, sql)).toEqual([]);
    refused(checkMigration, sql.replace('articles', table), `funds or attribution table ${table}`);
  },
);

it.each([
  'DROP TRIGGER append_guard ON app.order_keys;',
  'DROP TRIGGER IF EXISTS "append_guard" ON ONLY "app"."order_keys";',
  'drop /* separator */ trigger append_guard on app.order_keys RESTRICT;',
])('[AC-CT-06c#3] 资金表触发器只删不建必须自检拒绝：%s', async (sql) => {
  const { checkMigration } = await gate();
  expect(checkMigration(FILE, sql.replace('order_keys', 'articles'))).toEqual([]);
  for (const prefix of ['', '-- reason\n-- squawk-ignore ban-drop-table\n']) {
    refused(
      checkMigration,
      prefix + sql,
      'trigger append_guard on funds or attribution table order_keys',
    );
  }
});

it('[AC-CT-06c#4] 触发器例外仅限之后同表同名重建，支持普通、替换与约束触发器', async () => {
  const { checkMigration } = await gate();
  const drop = 'DROP TRIGGER append_guard ON app.order_keys;';
  const create =
    'CREATE TRIGGER append_guard AFTER UPDATE ON app.order_keys FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();';
  for (const head of ['CREATE TRIGGER', 'CREATE OR REPLACE TRIGGER', 'CREATE CONSTRAINT TRIGGER']) {
    expect(checkMigration(FILE, `${drop}\n${create.replace('CREATE TRIGGER', head)}`)).toEqual([]);
  }
  for (const sql of [
    `${create}\n${drop}`,
    `${drop}\n${create.replace('append_guard', 'other_guard')}`,
    `${drop}\n${create.replace('order_keys', 'order_settlements')}`,
    `${drop}\n-- ${create}`,
    `${drop}\nSELECT '${create}';`,
  ]) {
    refused(checkMigration, sql, 'trigger append_guard on funds or attribution table order_keys');
  }
});

it.each(['append_guard', 'ALL', 'USER'])(
  '[AC-CT-06c#5] DISABLE TRIGGER %s 不可用，之后 ENABLE 也不构成例外',
  async (target) => {
    const { checkMigration } = await gate();
    const disable = `ALTER TABLE ONLY app.orders DISABLE TRIGGER ${target};`;
    const enable = `ALTER TABLE ONLY app.orders ENABLE TRIGGER ${target};`;
    expect(checkMigration(FILE, enable)).toEqual([]);
    expect(checkMigration(FILE, disable.replace('orders', 'articles'))).toEqual([]);
    for (const sql of [disable, `${disable}\n${enable}`]) {
      const problems = checkMigration(FILE, sql);
      expect(problems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringMatching(/trigger.*on funds or attribution table orders/i),
          }),
        ]),
      );
    }
  },
);

it.each(['orders', 'processed_events', 'idempotency_keys'])(
  '[AC-CT-06c#6] %s 的约束仅可同名同表后续重建，支持 IF EXISTS 与逗号子命令',
  async (table) => {
    const { checkMigration } = await gate();
    const alter = `ALTER TABLE ONLY "app"."${table}"`;
    const drop = 'DROP CONSTRAINT IF EXISTS "dedupe"';
    const add = 'ADD CONSTRAINT dedupe UNIQUE (id)';
    for (const sql of [
      `${alter} ${drop}, ${add};`,
      `${alter} ${drop};\n${alter} ${add};`,
      'ALTER TABLE app.articles DROP CONSTRAINT dedupe;',
    ])
      expect(checkMigration(FILE, sql), sql).toEqual([]);
    for (const sql of [
      `${alter} ${drop};`,
      `${alter} ADD COLUMN note text, ${drop}, ADD COLUMN seq bigint;`,
      `${alter} ${add}, ${drop};`,
      `${alter} ${drop}; ${alter} ${add.replace('dedupe', 'different_name')};`,
      `${alter} ${drop}; ALTER TABLE app.articles ${add};`,
      `${alter} ${drop}; /* ${alter} ${add}; */`,
    ])
      refused(checkMigration, sql, `constraint dedupe on funds or attribution table ${table}`);
  },
);

it('[AC-CT-06c#7] indexOwners 从真实 schema 与迁移提取索引和约束索引，去 schema、引号并小写', async () => {
  const indexOwners = await objectMap('indexOwners');
  expect(indexOwners('', [])).toEqual(new Map());
  const schema = requiredText('db/schema.sql');
  const known = indexOwners(schema, []);
  expect(known).toBeInstanceOf(Map);
  for (const [index, table] of [
    ['orders_user_paid_idx', 'orders'],
    ['order_keys_pkey', 'order_keys'],
    ['order_keys_identity_key', 'order_keys'],
    ['processed_events_pkey', 'processed_events'],
    ['idempotency_keys_scope_key', 'idempotency_keys'],
  ])
    expect(known.get(index!), index).toBe(table);
  const migrations = Object.freeze([
    'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Dedupe_X" ON ONLY "app"."Processed_Events" (consumer, event_id);',
    'ALTER TABLE app.idempotency_keys ADD CONSTRAINT "Scope_X" UNIQUE (app_id, key), ADD CONSTRAINT pk_x PRIMARY KEY (id);',
    'ALTER TABLE app.orders ADD CONSTRAINT exclusion_x EXCLUDE USING gist (order_id WITH =);',
    'CREATE INDEX ordinary_x ON app.articles (id);',
    "-- CREATE INDEX fake_comment ON app.orders (id);\nSELECT 'CREATE INDEX fake_string ON app.orders (id);';",
  ]);
  const owners = indexOwners(schema, migrations);
  for (const [name, table] of [
    ['dedupe_x', 'processed_events'],
    ['scope_x', 'idempotency_keys'],
    ['pk_x', 'idempotency_keys'],
    ['exclusion_x', 'orders'],
    ['ordinary_x', 'articles'],
  ])
    expect(owners.get(name!), name).toBe(table);
  expect(owners.has('fake_comment')).toBe(false);
  expect(owners.has('fake_string')).toBe(false);
  expect(indexOwners('', [])).toEqual(new Map());
});

it.each([
  [
    'CREATE UNIQUE INDEX dedupe_x ON app.processed_events (consumer, event_id);',
    'processed_events',
  ],
  ['CREATE INDEX CONCURRENTLY IF NOT EXISTS dedupe_x ON ONLY app.orders (order_id);', 'orders'],
  [
    'ALTER TABLE app.idempotency_keys ADD CONSTRAINT dedupe_x UNIQUE (app_id, key);',
    'idempotency_keys',
  ],
  ['ALTER TABLE app.orders ADD CONSTRAINT dedupe_x PRIMARY KEY (order_id);', 'orders'],
  [
    'ALTER TABLE app.orders ADD CONSTRAINT dedupe_x EXCLUDE USING gist (order_id WITH =);',
    'orders',
  ],
])('[AC-CT-06c#8] 无资金前缀的索引仍按所属表保护：%s', async (definition, table) => {
  const { checkMigration } = await gate();
  expect(
    checkMigration(FILE, 'CREATE INDEX ordinary_x ON app.articles (id); DROP INDEX ordinary_x;'),
  ).toEqual([]);
  for (const drop of [
    'DROP INDEX dedupe_x;',
    'DROP INDEX CONCURRENTLY IF EXISTS "app"."dedupe_x";',
    'DROP INDEX ordinary_x, app.dedupe_x, other_x RESTRICT;',
  ])
    refused(
      checkMigration,
      `${definition}\n${drop}`,
      `index dedupe_x on funds or attribution table ${table}`,
    );
});

it('[AC-CT-06c#9] 未知索引按名字套资金规则，已知普通表索引优先采用所属表', async () => {
  const { checkMigration } = await gate();
  expect(checkMigration(FILE, 'DROP INDEX unknown_x RESTRICT;')).toEqual([]);
  expect(
    checkMigration(
      FILE,
      'CREATE INDEX orders_article_idx ON app.articles (id); DROP INDEX orders_article_idx;',
    ),
  ).toEqual([]);
  refused(
    checkMigration,
    'DROP INDEX IF EXISTS app.orders_created_at_idx;',
    'index orders_created_at_idx on funds or attribution table',
  );
});

it('[AC-CT-06c#10] 索引例外只认同一文件之后同名同表 CREATE INDEX', async () => {
  const { checkMigration } = await gate();
  const create = 'CREATE UNIQUE INDEX dedupe_x ON app.orders (order_id);';
  const drop = 'DROP INDEX app.dedupe_x;';
  for (const rebuild of [create, create.replace('UNIQUE ', '')]) {
    expect(checkMigration(FILE, `${create}\n${drop}\n${rebuild}`)).toEqual([]);
  }
  for (const suffix of [
    '',
    create.replace('dedupe_x', 'other_x'),
    create.replace('orders', 'articles'),
    `-- ${create}`,
    `SELECT '${create}';`,
  ]) {
    refused(
      checkMigration,
      `${create}\n${drop}\n${suffix}`,
      'index dedupe_x on funds or attribution table orders',
    );
  }
});

it.each([
  'DROP TABLE app.articles',
  'DROP FUNCTION IF EXISTS app.utility(integer, text)',
  'DROP PROCEDURE IF EXISTS app.utility(integer)',
  'DROP TYPE app.article_kind',
  'DROP DOMAIN app.article_code',
  'DROP VIEW app.article_view',
  'DROP MATERIALIZED VIEW app.article_summary',
  'DROP SCHEMA IF EXISTS old_content',
  'DROP INDEX CONCURRENTLY IF EXISTS app.article_idx',
  'DROP TRIGGER IF EXISTS article_guard ON app.articles',
  'DROP SEQUENCE app.article_seq',
  'ALTER TABLE app.articles DROP COLUMN IF EXISTS old_title',
  'ALTER TABLE app.articles DROP CONSTRAINT IF EXISTS article_key',
])('[AC-CT-06c#11] 所有 DROP CASCADE 拒绝，RESTRICT 与默认方式不由本条拒绝：%s', async (head) => {
  const { checkMigration } = await gate();
  expect(checkMigration(FILE, `${head};`)).toEqual([]);
  expect(checkMigration(FILE, `${head} RESTRICT;`)).toEqual([]);
  for (const tail of [' CASCADE;', ' /* dependency */ cascade /* end */;']) {
    for (const prefix of ['', '-- reason\n-- squawk-ignore ban-drop-table\n']) {
      refused(checkMigration, prefix + head + tail, 'DROP … CASCADE is not accepted');
    }
  }
});

it('[AC-CT-06c#12] 同名重建与逗号子命令不能豁免 CASCADE', async () => {
  const { checkMigration } = await gate();
  const pairs = [
    'DROP TRIGGER guard_x ON app.orders CASCADE; CREATE TRIGGER guard_x BEFORE UPDATE ON app.orders FOR EACH ROW EXECUTE FUNCTION app.guard_fn();',
    'ALTER TABLE app.orders DROP CONSTRAINT dedupe CASCADE, ADD CONSTRAINT dedupe UNIQUE (order_id);',
    'CREATE INDEX dedupe_x ON app.orders (order_id); DROP INDEX dedupe_x CASCADE; CREATE INDEX dedupe_x ON app.orders (order_id);',
    'ALTER TABLE app.articles ADD COLUMN note text, DROP COLUMN old_title CASCADE, ADD COLUMN seq bigint;',
  ];
  for (const sql of pairs) {
    expect(checkMigration(FILE, sql.replace(' CASCADE', ' RESTRICT'))).toEqual([]);
    refused(checkMigration, sql, 'DROP … CASCADE is not accepted');
  }
});

it('[AC-CT-06c#13] fundsTriggerFunctions 读取真实触发器与迁移，忽略普通表和伪造文本', async () => {
  const fundsTriggerFunctions = await objectMap('fundsTriggerFunctions');
  const { isFundsTable } = await gate();
  expect(fundsTriggerFunctions('', [])).toEqual(new Map());
  const schema = requiredText('db/schema.sql');
  expect(schema).toContain(
    'CREATE TRIGGER order_keys_append_only BEFORE DELETE OR UPDATE ON app.order_keys',
  );
  const known = fundsTriggerFunctions(schema, []);
  expect(known).toBeInstanceOf(Map);
  expect(known.get('reject_order_rewrite')).toBe('orders');
  expect(known.get('reject_link_promo_rewrite')).toBe('links');
  expect(known.get('reject_update_delete')).toBeDefined();
  expect(isFundsTable(known.get('reject_update_delete')!)).toBe(true);
  expect(known.has('drop_expired_link_logs_partitions')).toBe(false);
  const migrations = Object.freeze([
    'CREATE OR REPLACE TRIGGER guard_x BEFORE UPDATE ON "app"."Processed_Events" FOR EACH ROW EXECUTE FUNCTION "app"."Dedupe_Fn"();',
    "CREATE CONSTRAINT TRIGGER guard_y AFTER DELETE ON app.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE PROCEDURE app.scope_fn('arg');",
    'CREATE TRIGGER ordinary_guard BEFORE UPDATE ON app.articles FOR EACH ROW EXECUTE FUNCTION app.ordinary_fn();',
    "-- CREATE TRIGGER fake BEFORE UPDATE ON app.orders EXECUTE FUNCTION app.fake_comment();\nSELECT 'CREATE TRIGGER fake BEFORE UPDATE ON app.orders EXECUTE FUNCTION app.fake_string();';",
  ]);
  const functions = fundsTriggerFunctions(schema, migrations);
  expect(functions.get('dedupe_fn')).toBe('processed_events');
  expect(functions.get('scope_fn')).toBe('idempotency_keys');
  for (const name of ['ordinary_fn', 'fake_comment', 'fake_string'])
    expect(functions.has(name)).toBe(false);
  expect(fundsTriggerFunctions('', [])).toEqual(new Map());
});

it.each(['FUNCTION', 'PROCEDURE'])(
  '[AC-CT-06c#14] 资金触发器所用 %s 可保留抛错替换，禁止空替换、删除、改名、换属主与换 schema',
  async (kind) => {
    const { checkMigration } = await gate();
    const trigger = `CREATE TRIGGER guard_x BEFORE UPDATE ON app.orders FOR EACH ROW EXECUTE ${kind} app.guard_fn();`;
    const definition =
      kind === 'FUNCTION'
        ? '() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;'
        : '() LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;';
    expect(checkMigration(FILE, `${trigger}\nCREATE ${kind} app.guard_fn${definition}`)).toEqual(
      [],
    );
    for (const [tag, raise] of [
      ['$$', 'RAISE EXCEPTION'],
      ['$guard$', 'raise exception'],
      ['$Body$', 'RaIsE ExCePtIoN'],
    ]) {
      const returns = kind === 'FUNCTION' ? ' RETURNS trigger' : '';
      const sql = `${trigger}\nCREATE OR REPLACE ${kind} app.guard_fn()${returns} LANGUAGE plpgsql AS ${tag} BEGIN ${raise} 'immutable'; END; ${tag};`;
      expect(checkMigration(FILE, sql), sql).toEqual([]);
    }
    for (const mutation of [
      `DROP ${kind} app.guard_fn;`,
      `DROP ${kind} IF EXISTS "app"."guard_fn"() RESTRICT;`,
      `CREATE OR REPLACE ${kind} app.guard_fn${definition}`,
      `ALTER ${kind} app.guard_fn() RENAME TO another_fn;`,
      `ALTER ${kind} app.guard_fn() OWNER TO app_owner;`,
      `ALTER ${kind} app.guard_fn() SET SCHEMA other_schema;`,
    ]) {
      expect(
        checkMigration(FILE, `${trigger}\n${mutation.replace('guard_fn', 'utility_fn')}`),
      ).toEqual([]);
      refused(
        checkMigration,
        `${trigger}\n${mutation}`,
        'function guard_fn guards funds or attribution table orders',
      );
    }
  },
);

it('[AC-CT-06c#15] 注释、字符串与函数体中的 SQL 文本不充当真实对象操作', async () => {
  const { checkMigration } = await gate();
  const destructive = 'DROP TRIGGER guard_x ON app.orders; DROP TABLE app.articles CASCADE;';
  const sql = `-- ${destructive}\n/* ${destructive} */\nSELECT '${destructive}';\nSELECT $text$${destructive}$text$;\nCREATE FUNCTION app.utility_fn() RETURNS text LANGUAGE sql AS $fn$ SELECT '${destructive}'; $fn$;`;
  expect(checkMigration(FILE, sql)).toEqual([]);
  refused(
    checkMigration,
    `${sql}\nDROP TRIGGER guard_x ON app.orders;`,
    'trigger guard_x on funds or attribution table orders',
  );
});

it(
  '[AC-CT-06c#16] CLI 真实 schema 下同名重建通过，只删触发器在 squawk 前拒绝',
  () => {
    const drop = 'DROP TRIGGER order_keys_append_only ON app.order_keys;';
    const create =
      'CREATE TRIGGER order_keys_append_only BEFORE DELETE OR UPDATE ON app.order_keys FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();';
    withFixture({ [FILE]: `${TIMEOUTS}${drop}\n${create}` }, (root) => {
      copySchema(root);
      const allowed = run(['--root', root]);
      expect(allowed.status, allowed.stderr + allowed.stdout).toBe(0);
      expect(allowed.stdout).toContain('squawk over');
      writeFileSync(join(root, 'db/migrations', FILE), TIMEOUTS + drop);
      cliRefused(root, 'trigger order_keys_append_only on funds or attribution table order_keys');
    });
  },
  CLI_TIMEOUT_MS,
);

it(
  '[AC-CT-06c#17] CLI 从真实 schema 读取幂等唯一索引归属，缺少 schema 的普通迁移仍通过',
  () => {
    withFixture(
      { [FILE]: `${TIMEOUTS}CREATE TABLE app.articles (id bigint PRIMARY KEY);` },
      (root) => {
        const result = run(['--root', root]);
        expect(result.status, result.stderr + result.stdout).toBe(0);
        copySchema(root);
        writeFileSync(
          join(root, 'db/migrations', FILE),
          `${TIMEOUTS}DROP INDEX app.idempotency_keys_scope_key;`,
        );
        cliRefused(
          root,
          'index idempotency_keys_scope_key on funds or attribution table idempotency_keys',
        );
      },
    );
  },
  CLI_TIMEOUT_MS,
);

it(
  '[AC-CT-06c#18] CLI 从真实 schema 读取触发器函数，维护函数放行，空替换拒绝',
  () => {
    withFixture(
      { [FILE]: `${TIMEOUTS}DROP FUNCTION app.drop_expired_link_logs_partitions() RESTRICT;` },
      (root) => {
        copySchema(root);
        const result = run(['--root', root]);
        expect(result.status, result.stderr + result.stdout).toBe(0);
        // CT-06e: whether a guard replacement that still raises passes is decided by CT-06d (it needs
        // APPROVED_GUARD_CHANGES); this case keeps only what holds before and after CT-06d.
        writeFileSync(
          join(root, 'db/migrations', FILE),
          `${TIMEOUTS}CREATE OR REPLACE FUNCTION app.reject_order_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`,
        );
        cliRefused(root, 'function reject_order_rewrite guards funds or attribution table orders');
      },
    );
  },
  CLI_TIMEOUT_MS,
);

it(
  '[AC-CT-06c#21] 含 0020 的真实仓库无参数运行通过，只移除其保护函数抛错的夹具拒绝',
  () => {
    const result = run([], { cwd: join(ROOT, 'test') });
    expect(result.status, result.stderr + result.stdout).toBe(0);

    // 与真实仓库放行配对，确保本组在 CT-06b 上仍因新增拒绝行为缺失而先红。
    // 只改夹具文本；前面的 DO 块仍有 RAISE EXCEPTION，不能冒充函数体的保护。
    const migration = requiredText('db/migrations/0020_union-auth-sessions-issuance.sql');
    const guardRaise =
      /RAISE EXCEPTION 'union_auth_sessions are immutable and used_at is write-once'\s+USING ERRCODE = 'restrict_violation';/;
    expect(migration).toMatch(guardRaise);
    const withoutGuardRaise = migration.replace(guardRaise, 'NULL;');
    withFixture({ [FILE]: withoutGuardRaise }, (root) => {
      copySchema(root);
      cliRefused(
        root,
        'function reject_union_auth_session_rewrite guards funds or attribution table union_auth_sessions',
      );
    });
  },
  CLI_TIMEOUT_MS,
);

it.each([
  [
    'CREATE UNIQUE INDEX dedupe_x ON app.processed_events (consumer, event_id);',
    'DROP INDEX dedupe_x;',
    'index dedupe_x on funds or attribution table processed_events',
  ],
  [
    'ALTER TABLE app.idempotency_keys ADD CONSTRAINT scope_x UNIQUE (app_id, key);',
    'DROP INDEX scope_x;',
    'index scope_x on funds or attribution table idempotency_keys',
  ],
  [
    'CREATE TRIGGER guard_x BEFORE UPDATE ON app.orders FOR EACH ROW EXECUTE FUNCTION app.guard_fn();',
    'DROP FUNCTION app.guard_fn();',
    'function guard_fn guards funds or attribution table orders',
  ],
])(
  '[AC-CT-06c#19] CLI 也读取全部旧 SQL 的对象定义且不要求 schema：%s',
  (definition, drop, message) => {
    // 虚构旧文件名不触发真实冻结集合完整性检查；不复制部分冻结迁移。
    withFixture({ '0001_fixture.sql': definition, [FILE]: TIMEOUTS + drop }, (root) => {
      cliRefused(root, message);
    });
  },
  CLI_TIMEOUT_MS,
);

it.each([
  [
    'DROP TRIGGER guard_x ON app.orders;',
    'CREATE TRIGGER guard_x BEFORE UPDATE ON app.orders FOR EACH ROW EXECUTE FUNCTION app.guard_fn();',
    'trigger guard_x on funds or attribution table orders',
  ],
  [
    'ALTER TABLE app.orders DROP CONSTRAINT dedupe;',
    'ALTER TABLE app.orders ADD CONSTRAINT dedupe UNIQUE (order_id);',
    'constraint dedupe on funds or attribution table orders',
  ],
  [
    'DROP INDEX dedupe_x;',
    'CREATE INDEX dedupe_x ON app.orders (order_id);',
    'index dedupe_x on funds or attribution table orders',
  ],
])(
  '[AC-CT-06c#20] 后一份迁移重建不豁免当前文件的删除：%s',
  (drop, create, message) => {
    withFixture(
      {
        '0001_fixture.sql': create,
        [FILE]: TIMEOUTS + drop,
        '0021_rebuild.sql': TIMEOUTS + create,
      },
      (root) => {
        cliRefused(root, message);
      },
    );
  },
  CLI_TIMEOUT_MS,
);
