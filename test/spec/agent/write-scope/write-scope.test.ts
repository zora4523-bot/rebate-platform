// CT-06zu · BR-AI-02 ③ (D10-287, D10-288 Q1): agent may use platform's database connection and
// Redis, but reads and writes only the Agent's own tables and keys. Static scan over the
// TypeScript AST of apps/api/src/modules/agent/** (test files and dist excluded) and
// apps/api/src/app.module.ts; the scan proves itself on in-memory samples. No database, no Redis,
// no listen, no network.
// 口径 ①–④ are spelled out in ./scan.ts.
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
  ]);
  expectClean([
    "await db.insertInto('agent_cards').values(v).execute();",
    "await db.updateTable('app.agent_runs').set(v).execute();",
    "await db.deleteFrom('agent_sessions as s').where('s.id', '=', id).execute();",
    "await db.mergeInto('agent_result_sets').using('orders', 'a', 'b').execute();",
    "await db.deleteFrom(['agent_cards', 'agent_tool_calls']).execute();",
    "await db.withSchema('app').insertInto('agent_messages').values(v).execute();",
    // Reads are not this gate's concern.
    "await db.selectFrom('users').selectAll().execute();",
    "await db.selectFrom('ledger_entries').forUpdate().selectAll().execute();",
  ]);
});

it('[AC-CT-06zu#2][BR-AI-02] agent/** 的 sql 模板与 sql.raw 里的写语句（INSERT INTO / UPDATE / DELETE FROM / MERGE INTO / TRUNCATE）只写 app.agent_*，注释与普通字符串不算，主干零违规；样例自证', () => {
  const scan = scanAgent(agentSources());
  expect(kindOf(scan.violations, '②')).toEqual([]);
  // The scan is not vacuous: it sees agent's real raw writes (deletion, stream/pg).
  expect(scan.sqlTargets).toEqual(
    expect.arrayContaining(['app.agent_runs', 'app.agent_sessions', 'app.agent_messages']),
  );

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
  ]);
  expectClean([
    'await q.query(sql`UPDATE app.agent_runs SET x = ${v} WHERE id = ${id}`);',
    'await q.query(sql`INSERT INTO app.agent_messages (id) VALUES (${id}) ON CONFLICT (id) DO UPDATE SET x = 1`);',
    'await q.query(sql`SELECT * FROM app.orders WHERE id = ${id} FOR NO KEY UPDATE`);',
    'await q.query(sql`SELECT * FROM app.users FOR UPDATE SKIP LOCKED`);',
    'await q.query(sql`delete from agent_cards where id = ${id}`);',
    'await q.query(sql`TRUNCATE app.agent_tool_calls`);',
    "await q.query(sql`UPDATE ${sql.table('app.agent_runs')} SET x = 1`);",
    "await q.query(sql`UPDATE ${sql.id('app', 'agent_runs')} SET x = 1`);",
    "await q.query(sql.raw('UPDATE app.agent_cards SET data = data'));",
    // SQL comments and SQL string literals are not statements.
    'await q.query(sql`-- UPDATE app.users\nSELECT 1 /* DELETE FROM orders */`);',
    "await q.query(sql`SELECT 'DELETE FROM app.users' AS t, last_update, updated_at FROM app.users`);",
    // TypeScript comments, ordinary strings and untagged templates outside .query are not SQL.
    "// the decision UPDATE with this instance's memo\n/* DELETE FROM orders */\nexport {};",
    'const message = "update orders failed"; log(\'DELETE FROM users\');',
    'const m = `UPDATE ${x} with memo`;',
    "const v = sql.lit('agent'); const r = sql.ref('col');",
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

it('[AC-CT-06zu#4][BR-AI-02] app.module.ts 交给 agent 的 Redis 命名空间（AGENT*NAMESPACE 常量、agent 装配内的 .namespace）只用 agent_ 前缀，主干零违规；样例自证', () => {
  const real = scanAppModule(appModuleSource());
  expect(real.violations).toEqual([]);
  // The scan is not vacuous: it resolves the daily counter's namespace through its const.
  expect(real.agentNamespaces).toEqual(expect.arrayContaining(['agent_daily']));

  const root = (text: string): SourceFile => ({ path: APP_MODULE, text });
  const violating = [
    "const AGENT_X_NAMESPACE = 'orders_x';",
    "const AGENT_Y_NAMESPACE = PREFIX + 'y';",
    "let AGENT_Z_NAMESPACE = 'agent_z';",
    "function agentCache(redis: R) { return redis.namespace('step_up'); }",
    "const OTHER = 'orders';\nfunction agentCache(redis: R) { return redis.namespace(OTHER); }",
    'function agentCache(redis: R, name: string) { return redis.namespace(name); }',
    "const ports = { agentCounter: redis.namespace('orders') };",
    "const AGENT_OTHER = 'risk';\nfunction risk(redis: R) { return redis.namespace(AGENT_OTHER); }",
  ];
  for (const text of violating) {
    expect(scanAppModule(root(text)).violations.length, text).toBeGreaterThan(0);
  }
  const allowed = [
    "const AGENT_DAILY_COUNTER_NAMESPACE = 'agent_daily';\nfunction agentDailyCounter(redis: R) {\n  return redis.namespace(AGENT_DAILY_COUNTER_NAMESPACE);\n}",
    "function agentCancel(redis: R) { return redis?.namespace('agent_cancel'); }",
    // Other modules' namespaces assembled in app.module are not the agent's.
    "const PRODUCT_CACHE_NAMESPACE = 'catalog-cache';\nfunction catalog(redis: R) { return redis.namespace(PRODUCT_CACHE_NAMESPACE); }",
  ];
  for (const text of allowed) {
    expect(scanAppModule(root(text)).violations, text).toEqual([]);
  }
});
