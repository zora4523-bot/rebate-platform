// CT-06zu · BR-AI-02 ③ (D10-287, D10-288 Q1): agent may use platform's database connection and
// Redis, but reads and writes only the Agent's own tables and keys. Static scan over the
// TypeScript AST of apps/api/src/modules/agent/** (test files and dist excluded) and
// apps/api/src/app.module.ts; the scan proves itself on in-memory samples. No database, no Redis,
// no listen, no network.
// 口径 ①–⑤ are spelled out in ./scan.ts.
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  AGENT,
  APP_MODULE,
  agentSources,
  appModuleSource,
  scanAgent,
  scanAppModule,
  type Kind,
  type SourceFile,
} from './scan.ts';

/**
 * Namespaces of other modules that app.module may assemble (not the agent's). Source:
 * apps/api/src/app.module.ts `redis.namespace(PRODUCT_CACHE_NAMESPACE)` (catalog product reader),
 * PRODUCT_CACHE_NAMESPACE = 'catalog-cache' in apps/api/src/modules/catalog/infra/product-cache.ts.
 * A new namespace in app.module turns ④ red until it is added here (test/spec only grows).
 */
const NON_AGENT_NAMESPACES = ['catalog-cache'];

function sample(text: string): SourceFile {
  return { path: join(AGENT, 'sample/index.ts'), text };
}

function kindOf(violations: readonly string[], kind: Kind): string[] {
  return violations.filter((v) => v.startsWith(kind));
}

/** Every text is reported under `kind` on its own. */
function expectCaught(kind: Kind, texts: readonly string[]): void {
  for (const text of texts) {
    expect(kindOf(scanAgent([sample(text)]).violations, kind).length, text).toBeGreaterThan(0);
  }
}

/** No text is reported at all. */
function expectClean(texts: readonly string[]): void {
  for (const text of texts) {
    expect(scanAgent([sample(text)]).violations, text).toEqual([]);
  }
}

it('[AC-CT-06zu#1][BR-AI-02] agent/** 的 Kysely 写（insertInto / updateTable / deleteFrom / mergeInto / replaceInto）只写字面量 agent_* 表，主干零违规；样例自证', () => {
  const sources = agentSources();
  expect(sources.length).toBeGreaterThan(0);
  expect(sources.some((s) => s.path.endsWith('.test.ts'))).toBe(false);
  const scan = scanAgent(sources);
  expect(kindOf(scan.violations, '①')).toEqual([]);
  // The scan is not vacuous: it sees agent's real Kysely writes.
  expect(scan.tables).toEqual(expect.arrayContaining(['agent_sessions', 'agent_cards']));

  expectCaught('①', [
    "await db.insertInto('users').values(v).execute();",
    "await db.updateTable('app.withdrawals').set(v).execute();",
    "await db.deleteFrom('orders').where('id', '=', id).execute();",
    "await db.mergeInto('ledger_entries as l').using('agent_cards', 'l.id', 'id').execute();",
    "await db.replaceInto('pgboss.job').values(v).execute();",
    "await db.insertInto('public.agent_cards').values(v).execute();",
    "await db.insertInto('agents').values(v).execute();",
    'await db.insertInto(table).values(v).execute();',
    'await db.insertInto(`agent_${name}`).values(v).execute();',
    "await db.updateTable('agent_' + name).set(v).execute();",
    "await db.deleteFrom(['agent_cards', 'users']).execute();",
    "await db['insertInto']('users').values(v).execute();",
    "await db.withSchema('pgboss').insertInto('agent_cards').values(v).execute();",
    // A method destructured in a callback is still checked when called by its bare name.
    "await db.updateTable('agent_runs').set(({ insertInto }) => insertInto('orders')).execute();",
  ]);
  expectClean([
    "await db.insertInto('agent_cards').values(v).execute();",
    "await db.updateTable('app.agent_runs').set(v).execute();",
    "await db.deleteFrom('agent_sessions as s').where('s.id', '=', id).execute();",
    "await db.mergeInto('agent_result_sets').using('agent_runs', 'a', 'b').execute();",
    "await db.deleteFrom(['agent_cards', 'agent_tool_calls']).execute();",
    "await db.withSchema('app').insertInto('agent_messages').values(v).execute();",
  ]);
});

it('[AC-CT-06zu#2][BR-AI-02] agent/** 的 SQL 文本（sql 模板含别名与命名空间导入、sql.raw、数据库句柄的 .query）里的写语句只写 app.agent_*，DDL / 授权 / 切角色一律违规，注释、字符串与列名不算，主干零违规；样例自证', () => {
  const scan = scanAgent(agentSources());
  expect(kindOf(scan.violations, '②')).toEqual([]);
  // The scan is not vacuous: it sees agent's real raw writes (deletion, stream/pg) and the
  // .query calls on its query handles.
  expect(scan.sqlTargets).toEqual(
    expect.arrayContaining(['app.agent_runs', 'app.agent_sessions', 'app.agent_messages']),
  );
  expect(scan.dbQueries).toBeGreaterThan(0);

  expectCaught('②', [
    'await q.query(sql`INSERT INTO app.users (id) VALUES (${id})`);',
    'await q.query(sql`UPDATE app.ledger_entries SET amount = 0 WHERE id = ${id}`);',
    'await q.query(sql`DELETE FROM withdrawals WHERE id = ${id}`);',
    'await q.query(sql`TRUNCATE app.orders`);',
    'await q.query(sql`truncate table app.agent_runs, app.orders`);',
    'await q.query(sql`MERGE INTO app.payouts p USING app.agent_runs r ON p.id = r.id`);',
    "await q.query(sql.raw('update orders set status = 1'));",
    'await q.query(sql<{ id: string }>`\n  update\n    app.users\n  set phone = null`);',
    'await q.query(sql`WITH d AS (DELETE FROM app.orders RETURNING id) SELECT * FROM d`);',
    'await q.query(sql`UPDATE ONLY "app"."orders" SET x = 1`);',
    'await q.query(sql`INSERT INTO public.agent_runs (id) VALUES (${id})`);',
    "await q.query(sql`UPDATE ${sql.table('users')} SET x = 1`);",
    "await q.query(sql`UPDATE ${sql.id('app', 'orders')} SET x = 1`);",
    "await q.query(sql`UPDATE ${sql.raw('app.users')} SET x = 1`);",
    'await q.query(sql`UPDATE ${table} SET x = 1`);',
    'await q.query(sql`UPDATE ${sql.table(name)} SET x = 1`);',
    'await q.query(sql`DELETE FROM`);',
    'await q.query(sql.raw(text));',
    "await client.query('DELETE FROM app.users WHERE id = $1', [id]);",
    // sql.raw with a template that has substitutions is not a literal.
    'await q.query(sql.raw(`${stmt}`));',
    'await q.query(sql.raw(`UPDATE ${t} SET x = 1`));',
    'await q.query(sql`${sql.raw(`${stmt}`)}`);',
    // sql under another local name, and through a namespace import of kysely.
    "import { sql as s } from 'kysely';\nawait q.query(s`DELETE FROM app.users`);",
    "import * as k from 'kysely';\nawait q.query(k.sql`DELETE FROM app.users`);",
    "import * as k from 'kysely';\nawait q.query(k.sql.raw('UPDATE app.orders SET x = 1'));",
    // .query on a database handle takes a sql tag, a string or a template, nothing else.
    "const Q = 'DELETE FROM app.users';\nawait client.query(Q);",
    "await client.query('DELETE FROM app.' + t);",
    'await this.pool.query(text);',
    'await trx.query(build());',
    'await deps.db.query(`UPDATE ${t} SET x = 1`);',
    "await pgClient.query('UPDATE app.orders SET x = 1');",
    // E'…' backslash escapes and $tag$ quotes do not swallow statements.
    "await q.query(sql`SELECT E'\\\\'' ; UPDATE app.orders SET x = 1`);",
    "await q.query(sql`SELECT $$'$$; UPDATE app.orders SET x = 1; SELECT '1'`);",
    'await q.query(sql`DO $body$ BEGIN UPDATE app.orders SET x = 1; END $body$`);',
    // DDL, privileges, COPY, LOCK, CALL, role switching and SELECT … INTO.
    'await q.query(sql`ALTER TABLE app.agent_runs ADD COLUMN x int`);',
    'await q.query(sql`DROP TABLE app.agent_runs`);',
    'await q.query(sql`CREATE TABLE app.agent_x (id int)`);',
    'await q.query(sql`GRANT SELECT ON app.orders TO PUBLIC`);',
    'await q.query(sql`REVOKE ALL ON app.agent_runs FROM PUBLIC`);',
    'await q.query(sql`COPY app.orders TO STDOUT`);',
    'await q.query(sql`LOCK TABLE app.orders`);',
    'await q.query(sql`CALL app.settle_all()`);',
    'await q.query(sql`SET LOCAL ROLE app_admin`);',
    'await q.query(sql`SET SESSION AUTHORIZATION app_admin`);',
    "await q.query(sql`SELECT pg_catalog.set_config('role', 'app_admin', true)`);",
    'await q.query(sql`SELECT * INTO app.orders_copy FROM app.agent_runs`);',
    // Forbidden keywords at any statement start: after ;, in DO blocks after BEGIN / THEN / ELSE
    // / LOOP, at the start of a $tag$ body.
    'await q.query(sql`SELECT 1;\n  drop table app.agent_runs`);',
    'await q.query(sql`DO $$ BEGIN IF true THEN LOCK TABLE app.orders; ELSE CALL app.settle_all(); END IF; END $$`);',
    'await q.query(sql`DO $$ BEGIN FOR i IN 1..2 LOOP ALTER TABLE app.agent_runs ADD COLUMN x int; END LOOP; END $$`);',
    'await q.query(sql`DO $body$ CREATE TABLE app.agent_x (id int) $body$`);',
    // MERGE: the target and the source are still checked; THEN UPDATE outside MERGE is a statement.
    'await q.query(sql`MERGE INTO app.orders o USING app.agent_runs r ON o.id = r.id WHEN MATCHED THEN UPDATE SET x = 1`);',
    'await q.query(sql`MERGE INTO app.agent_cards c USING app.agent_runs r ON c.id = r.id WHEN MATCHED THEN UPDATE SET x = (SELECT y FROM app.orders)`);',
    'await q.query(sql`MERGE INTO app.agent_cards c USING app.agent_runs r ON c.id = r.id WHEN MATCHED THEN DELETE; UPDATE app.orders SET x = 1`);',
    'await q.query(sql`DO $$ BEGIN IF true THEN UPDATE app.orders SET x = 1; END IF; END $$`);',
    // After an opaque substitution (it may end a statement) and after EXPLAIN [ANALYZE] / (…).
    'await q.query(sql`${head} DROP TABLE app.orders`);',
    'await q.query(sql`${head} ALTER TABLE app.orders DROP COLUMN x`);',
    'await q.query(sql`SELECT 1 ${sep} LOCK TABLE app.orders`);',
    'await q.query(sql`EXPLAIN ANALYZE CREATE TABLE app.orders_copy AS SELECT * FROM app.agent_runs`);',
    'await q.query(sql`EXPLAIN (ANALYZE) CREATE MATERIALIZED VIEW app.mv AS SELECT * FROM app.agent_runs`);',
    'await q.query(sql`EXPLAIN (ANALYZE, BUFFERS) CREATE TABLE app.agent_x AS SELECT 1`);',
    'await q.query(sql`explain analyse verbose create table app.agent_x as select 1`);',
  ]);
  expectClean([
    'await q.query(sql`UPDATE app.agent_runs SET x = ${v} WHERE id = ${id}`);',
    'await q.query(sql`INSERT INTO app.agent_messages (id) VALUES (${id}) ON CONFLICT (id) DO UPDATE SET x = 1`);',
    'await q.query(sql`SELECT * FROM app.agent_runs WHERE id = ${id} FOR NO KEY UPDATE`);',
    'await q.query(sql`SELECT * FROM app.agent_sessions FOR UPDATE SKIP LOCKED`);',
    'await q.query(sql`delete from agent_cards where id = ${id}`);',
    'await q.query(sql`TRUNCATE app.agent_tool_calls`);',
    "await q.query(sql`UPDATE ${sql.table('app.agent_runs')} SET x = 1`);",
    "await q.query(sql`UPDATE ${sql.id('app', 'agent_runs')} SET x = 1`);",
    "await q.query(sql.raw('UPDATE app.agent_cards SET data = data'));",
    'await q.query(sql`SELECT * INTO agent_tmp FROM app.agent_runs`);',
    "import { sql as s } from 'kysely';\nawait q.query(s`UPDATE app.agent_runs SET x = 1`);",
    // SQL comments and SQL string literals are not statements.
    'await q.query(sql`-- UPDATE app.users\nSELECT 1 /* DELETE FROM orders */`);',
    "await q.query(sql`SELECT 'DELETE FROM app.users' AS t, last_update, updated_at FROM app.agent_runs`);",
    "await q.query(sql`SELECT E'it\\\\'s; DELETE FROM app.users' AS t FROM app.agent_runs`);",
    "await q.query(sql`SELECT $$ it's $$ AS t FROM app.agent_runs`);",
    // Column names are not statements.
    'await q.query(sql`SELECT "update", a.update, a.create FROM app.agent_runs a`);',
    // Session settings and advisory locks are not DDL.
    "await q.query(sql`SET LOCAL lock_timeout = '2s'`);",
    'await q.query(sql`SELECT pg_advisory_xact_lock(${key}::bigint)`);',
    // Forbidden keywords away from a statement start are column names or aliases.
    'await q.query(sql`SELECT x AS drop, y AS create FROM app.agent_runs WHERE lock = 1 AND copy IS NULL ORDER BY call`);',
    'await q.query(sql`UPDATE app.agent_runs SET lock = false, alter = 1 WHERE drop IS NULL`);',
    'await q.query(sql`SELECT ${col} AS drop, x AS create FROM app.agent_runs WHERE lock = ${v}`);',
    'await q.query(sql`EXPLAIN SELECT x AS drop FROM app.agent_runs WHERE lock = 1`);',
    'await q.query(sql`EXPLAIN (ANALYZE, COSTS OFF) SELECT * FROM app.agent_runs WHERE copy IS NULL`);',
    // MERGE … WHEN MATCHED THEN UPDATE SET / DELETE / INSERT are actions on the MERGE target.
    'await q.query(sql`MERGE INTO app.agent_cards c USING app.agent_runs r ON c.id = r.id WHEN MATCHED THEN UPDATE SET data = r.data WHEN NOT MATCHED THEN INSERT (id) VALUES (r.id)`);',
    'await q.query(sql`MERGE INTO app.agent_cards c USING app.agent_runs r ON c.id = r.id WHEN MATCHED AND r.gone THEN DELETE`);',
    // TypeScript comments, ordinary strings and untagged templates outside .query are not SQL.
    "// the decision UPDATE with this instance's memo\n/* DELETE FROM orders */\nexport {};",
    'const message = "update orders failed"; log(\'DELETE FROM users\');',
    'const m = `UPDATE ${x} with memo`;',
    "const v = sql.lit('update orders'); const r = sql.ref('col');",
    // .query on anything that is not a database handle is not SQL.
    "const hits = await searchApi.query('delete from cart');",
    'const page = await docs.query(`update the ${topic} docs`);',
  ]);
});

it('[AC-CT-06zu#3][BR-AI-02] agent/** 的 .namespace(name) 只用 agent_ 开头的字面量，主干零违规；样例自证', () => {
  const scan = scanAgent(agentSources());
  expect(kindOf(scan.violations, '③')).toEqual([]);
  expect(scan.namespaces).toEqual(expect.arrayContaining(['agent_cancel']));

  expectCaught('③', [
    "const cache = redis.namespace('step_up');",
    "const cache = redis?.namespace('catalog-cache');",
    'const cache = redis.namespace(name);',
    'const cache = redis.namespace(`agent_${name}`);',
    "const cache = redis['namespace']('orders');",
  ]);
  expectClean([
    "const cache = redis?.namespace('agent_cancel');",
    "const cache = redis.namespace('agent_daily-v2');",
  ]);
});

it('[AC-CT-06zu#4][BR-AI-02] app.module.ts 的每个 .namespace(x) 都解析到字符串，且以 agent_ 开头或在非 agent 命名空间清单里，主干零违规；样例自证', () => {
  const real = scanAppModule(appModuleSource(), NON_AGENT_NAMESPACES);
  expect(real.violations).toEqual([]);
  // The scan is not vacuous: it resolves the daily counter's const and catalog's imported const,
  // and every listed non-agent namespace is still in use.
  expect(real.namespaces).toEqual(expect.arrayContaining(['agent_daily', ...NON_AGENT_NAMESPACES]));

  const root = (text: string): SourceFile => ({ path: APP_MODULE, text });
  const violating = [
    "function cancelSignals(redis: R) { return redis.namespace('stream_cancel'); }",
    "const OTHER = 'orders';\nfunction agentCache(redis: R) { return redis.namespace(OTHER); }",
    'function cache(redis: R, name: string) { return redis.namespace(name); }',
    'const ports = { dailyCounter: redis.namespace(`agent_${x}`) };',
    "let N = 'agent_z';\nconst ns = redis.namespace(N);",
    'const ns = redis.namespace(UNKNOWN_NAMESPACE);',
    "import { NAMESPACE } from './nowhere.ts';\nconst ns = redis.namespace(NAMESPACE);",
    "const ns = redis.namespace('catalog-cache-v2');",
    "const AGENT_NS = 'agent_daily';\nfunction f(AGENT_NS: string) { return redis.namespace(AGENT_NS); }",
    "const { namespace } = redis;\nconst ns = namespace('agent_x');",
    'const make = redis.namespace.bind(redis);',
  ];
  for (const text of violating) {
    const { violations } = scanAppModule(root(text), NON_AGENT_NAMESPACES);
    expect(violations.length, text).toBeGreaterThan(0);
  }
  const allowed = [
    "const AGENT_DAILY_COUNTER_NAMESPACE = 'agent_daily';\nfunction agentDailyCounter(redis: R) {\n  return redis.namespace(AGENT_DAILY_COUNTER_NAMESPACE);\n}",
    "function agentCancel(redis: R) { return redis?.namespace('agent_cancel'); }",
    "const PRODUCT_CACHE_NAMESPACE = 'catalog-cache';\nfunction catalog(redis: R) { return redis.namespace(PRODUCT_CACHE_NAMESPACE); }",
    // Resolved through catalog's index re-export to its infra const.
    "import { PRODUCT_CACHE_NAMESPACE } from './modules/catalog/index.ts';\nconst ns = redis.namespace(PRODUCT_CACHE_NAMESPACE);",
  ];
  for (const text of allowed) {
    const { violations } = scanAppModule(root(text), NON_AGENT_NAMESPACES);
    expect(violations, text).toEqual([]);
  }
});

it('[AC-CT-06zu#5][BR-AI-02] agent/** 的读（Kysely selectFrom / 各种 join / 链上 .from .using，SQL 的 FROM / JOIN / USING）只读 agent_* 表，子查询、CTE、unnest 之类函数与 VALUES 放行，主干零违规；样例自证', () => {
  const scan = scanAgent(agentSources());
  expect(kindOf(scan.violations, '①')).toEqual([]);
  expect(kindOf(scan.violations, '②')).toEqual([]);
  // The scan is not vacuous: it sees agent's real Kysely and SQL reads.
  expect(scan.readTables).toEqual(
    expect.arrayContaining(['agent_sessions', 'agent_result_chains', 'agent_runs as r']),
  );
  expect(scan.sqlReads).toEqual(expect.arrayContaining(['app.agent_runs', 'app.agent_sessions']));

  expectCaught('①', [
    "await db.selectFrom('users').selectAll().execute();",
    "await db.selectFrom('ledger_entries').forUpdate().selectAll().execute();",
    "await db.selectFrom('app.orders as o').selectAll().execute();",
    "await db.selectFrom(['agent_runs', 'orders']).selectAll().execute();",
    'await db.selectFrom(table).selectAll().execute();',
    "await db.selectFrom('agent_runs as r').innerJoin('app.users as u', 'u.id', 'r.user_id').execute();",
    "await db.selectFrom('agent_runs as r').leftJoin('orders as o', 'o.id', 'r.id').execute();",
    "await db.selectFrom('agent_runs as r').rightJoin('payouts', 'a', 'b').execute();",
    "await db.selectFrom('agent_runs as r').fullJoin('withdrawals', 'a', 'b').execute();",
    "await db.selectFrom('agent_runs').crossJoin('orders').execute();",
    "await db.selectFrom('agent_runs').innerJoinLateral((eb) => eb.selectFrom('users').selectAll().as('u'), (j) => j.onTrue()).execute();",
    "await db.selectFrom((eb) => eb.selectFrom('orders').selectAll().as('o')).selectAll().execute();",
    "await db.with('x', (w) => w.selectFrom('orders').selectAll()).selectFrom('x').selectAll().execute();",
    "await db.updateTable('agent_runs').from('orders').set(v).execute();",
    "await db.deleteFrom('agent_runs').using('orders').execute();",
    "await db.mergeInto('agent_result_sets').using('orders', 'a', 'b').execute();",
    // selectFrom destructured in an expression-builder callback is checked when called.
    "await db.selectFrom('agent_runs').where(({ exists, selectFrom }) => exists(selectFrom('orders').select('id'))).selectAll().execute();",
    "await db.selectFrom('agent_runs').where(({ selectFrom }) => selectFrom(table).select('id')).selectAll().execute();",
    "await db.selectFrom('agent_runs').where(({ exists, selectFrom }) => exists(selectFrom('agent_cards as c').innerJoin('users as u', 'u.id', 'c.user_id').select('c.id'))).selectAll().execute();",
  ]);
  expectCaught('②', [
    'await q.query(sql`SELECT * FROM app.orders`);',
    'await q.query(sql`SELECT * FROM ONLY app.orders`);',
    'await q.query(sql`SELECT * FROM app.agent_runs r, app.users u WHERE r.user_id = u.id`);',
    'await q.query(sql`SELECT * FROM app.agent_runs r JOIN app.orders o ON o.id = r.id`);',
    'await q.query(sql`SELECT * FROM app.agent_runs r LEFT OUTER JOIN app.users u ON true`);',
    'await q.query(sql`UPDATE app.agent_runs SET x = o.x FROM app.orders o WHERE o.id = id`);',
    'await q.query(sql`DELETE FROM app.agent_runs USING app.users u WHERE u.id = user_id`);',
    'await q.query(sql`INSERT INTO app.agent_runs SELECT * FROM app.orders`);',
    'await q.query(sql`SELECT * FROM ${table}`);',
    "await q.query(sql`SELECT * FROM ${sql.table('orders')}`);",
    'await q.query(sql`SELECT * FROM (SELECT * FROM app.orders) t`);',
    'await q.query(sql`WITH x AS (SELECT * FROM app.orders) SELECT * FROM x`);',
    'await q.query(sql`SELECT * FROM app.agent_runs WHERE id IN (SELECT run_id FROM app.payouts)`);',
    'await q.query(sql`SELECT "a"FROM app.orders`);',
    'await q.query(sql`SELECT * FROM`);',
    "await client.query('SELECT phone FROM app.users WHERE id = $1', [id]);",
  ]);
  expectClean([
    "await db.selectFrom('agent_runs as r').innerJoin('agent_sessions as s', 's.id', 'r.session_id').selectAll().execute();",
    "await db.withSchema('app').selectFrom('agent_cards').leftJoin('app.agent_runs', 'a', 'b').selectAll().execute();",
    "await db.selectFrom(['agent_runs', 'app.agent_cards']).selectAll().execute();",
    "await db.updateTable('agent_runs').from('agent_sessions').set(v).execute();",
    "await db.deleteFrom('agent_runs').using('agent_sessions').execute();",
    "await db.with('recent', (w) => w.selectFrom('agent_runs').selectAll()).selectFrom('recent').selectAll().execute();",
    "await db.selectFrom((eb) => eb.selectFrom('agent_runs').selectAll().as('r')).selectAll().execute();",
    "await db.selectFrom('agent_runs').where(({ exists, selectFrom }) => exists(selectFrom('agent_cards').select('id'))).selectAll().execute();",
    "await db.selectFrom('agent_runs').where((eb) => eb.exists(eb.selectFrom('agent_cards').select('id'))).selectAll().execute();",
    "const parts = Array.from(text); const key = Buffer.from(raw, 'utf8');",
    'await q.query(sql`SELECT s.id FROM app.agent_sessions s JOIN app.agent_runs r ON r.id = s.run_lock_run_id`);',
    'await q.query(sql`SELECT DISTINCT k FROM unnest(${keys}::text[]) AS t(k)`);',
    'await q.query(sql`SELECT * FROM app.agent_runs r, LATERAL jsonb_array_elements(r.final_event) AS e`);',
    'await q.query(sql`WITH recent AS (SELECT * FROM app.agent_runs) SELECT * FROM recent`);',
    'await q.query(sql`SELECT * FROM (VALUES (1), (2)) AS v(x)`);',
    "await q.query(sql`SELECT extract(epoch FROM accepted_at), substring(t FROM 1 FOR 3), trim(both ' ' FROM t) FROM app.agent_runs`);",
    "await q.query(sql`SELECT * FROM app.agent_runs WHERE settle_result IS DISTINCT FROM 'refunded'`);",
    'await q.query(sql`SELECT * FROM app.agent_runs a JOIN app.agent_cards c USING (run_id)`);',
    "await q.query(sql`SELECT 'FROM app.orders' AS t FROM agent_runs`);",
    'await q.query(sql`SELECT * FROM app.agent_runs ORDER BY id USING >`);',
    'await q.query(sql`SELECT g FROM generate_series(1, 3) g`);',
  ]);
});

it('[AC-CT-06zu#6][BR-AI-02] agent/** 不绕过构造器：executeQuery / CompiledQuery、db.schema.*、解构或 .call / .bind 间接取表方法与 namespace、db[变量]、改名传递 sql 一律违规，主干零违规；样例自证', () => {
  const scan = scanAgent(agentSources());
  expect(kindOf(scan.violations, '⑤')).toEqual([]);
  // The scan is not vacuous: it sees agent's direct table / withSchema / namespace calls.
  expect(scan.directCalls).toBeGreaterThan(0);

  expectCaught('⑤', [
    "await db.executeQuery(CompiledQuery.raw('DELETE FROM app.users'));",
    "import { CompiledQuery as C } from 'kysely';\nawait run(C.raw('SELECT 1'));",
    "await db.schema.createTable('app.orders').execute();",
    "await db.schema.dropTable('agent_runs').execute();",
    "await db.schema['alterTable']('agent_runs').execute();",
    'const { schema } = db;',
    "const { insertInto } = db;\nawait insertInto('users').execute();",
    'const { selectFrom: from } = trx;',
    "await db.insertInto.call(db, 'users').execute();",
    'const insert = db.insertInto.bind(db);',
    "await db['selectFrom'].apply(db, ['users']);",
    "const m = 'insertInto';\nawait db[m]('users').execute();",
    "const { namespace } = redis;\nnamespace('orders');",
    "redis.namespace.call(redis, 'orders');",
    'const ns = redis[key];',
    'const s = sql;\nawait q.query(s`DELETE FROM app.users`);',
    'run(sql);',
    // .schema on (or destructured from) a database handle, by name or by parameter type.
    'const s = db.schema;',
    "await this.trx.schema.dropTable('agent_runs').execute();",
    'const { schema } = deps.db;',
    "function migrate({ schema }: Kysely<DB>) { return schema.dropTable('agent_runs'); }",
    // .namespace taken from (or destructured from) a redis receiver, by name or parameter type.
    'const ns = this.redis.namespace;',
    'const { namespace } = deps.redis;',
    "function f({ namespace }: RedisHandle) { return namespace('agent_x'); }",
    "const make = redisHandle['namespace'];",
    // Destructuring a table method: renamed, outside a callback argument, or passed on.
    "await db.selectFrom('agent_runs').where(({ exists, selectFrom: from }) => exists(from('agent_cards'))).execute();",
    "await db.selectFrom('agent_runs').where(({ selectFrom }) => { const f = selectFrom; return f('orders'); }).execute();",
    "await db.selectFrom('agent_runs').where(({ selectFrom }) => run({ selectFrom })).execute();",
    "function reader({ selectFrom }: Kysely<DB>) { return selectFrom('agent_runs'); }",
    "const read = ({ selectFrom }: Kysely<DB>) => selectFrom('agent_runs');",
    // A SchemaModule DDL method after .schema, whatever the receiver is named or how it is reached.
    "await db.transaction().execute(async (t) => t.schema.dropTable('orders').execute());",
    "await db.transaction().execute(async ({ schema }) => schema.dropTable('orders').execute());",
    "await getDb().schema.createTable('app.x').execute();",
    "const d = (db as any).schema.dropTable('orders');",
    "await this.store.schema.alterTable('orders').renameTo('o').execute();",
    "async function f(k: Transaction<DB>) { await k.schema.dropTable('orders').execute(); }",
    "const g = ({ schema }: Transaction<DB>) => schema.createIndex('i').on('orders').column('x');",
    "await t.schema.withSchema('app').dropTable('orders').execute();",
    "await t.schema['dropView']('v').execute();",
    "const v = (t['schema'] as SchemaModule).createView('v').as(q);",
    "const { schema: s } = getDb();\nawait s.createSchema('x').execute();",
    "const s = this.store.schema;\nawait s.refreshMaterializedView('mv').execute();",
    "await k.schema.createType('mood').asEnum(['a']).execute();",
    "await k.schema.dropType('mood').execute();",
    "await k.schema.dropIndex('i').execute();",
    "await k.schema.dropSchema('x').execute();",
    "await k.schema.renameTable('orders', 'o').execute();",
  ]);
  expectClean([
    "await db.selectFrom('agent_runs').selectAll().execute();",
    'const write = this.ctx.card.bind(this.ctx); read.call(store, a);',
    'const first = rows[0]; const it = body[Symbol.asyncIterator]();',
    "import { sql } from 'kysely';\nawait sql`SELECT 1`.execute(db);",
    'const v = schema.parse(x); const s = validator.schema;',
    'interface Port { namespace(name: string): Ns; insertInto: number }',
    // .schema on anything that is not a database handle (tool JSON schemas, Zod-style schemas).
    'const props = tool.schema.properties; const t = def.parameters.schema.type;',
    'const v = Message.schema.parse(x); const { schema } = tool;',
    'function register({ schema }: ToolDef) { return schema; }',
    // Non-DDL methods after .schema on any receiver stay clean.
    'const props = t.schema.properties; const ok = getDb().schema.parse(x);',
    'const r = (tool as any).schema.safeParse(x); const k = this.store.schema.keys();',
    'const h = ({ schema }) => schema.parse(x); const s = def.schema;\ns.validate(y);',
    "const v = schema.extend({ a: z.string() }); const c = search.createIndex('docs');",
    // .namespace on anything that is not a redis handle.
    'const ns = config.namespace; log.info({ namespace: opts.namespace });',
    'function f({ namespace }: Options) { return namespace; }\nconst g = ({ namespace }) => namespace;',
    'const { namespace: n } = config;',
    // A Kysely expression-builder callback destructures exists / selectFrom.
    "await db.selectFrom('agent_runs').where(({ exists, selectFrom }) => exists(selectFrom('agent_cards').select('id'))).selectAll().execute();",
  ]);
});
