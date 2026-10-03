// Source snippets that the test guard must flag. They live in a file that is not itself a
// test file, so the guard does not flag its own test suite.
export const SKIPPED_TEST = "it.skip('later', () => {});\n";
export const FOCUSED_TEST = "describe.only('x', () => {});\n";
export const CHAINED_SKIP = "it.skip.each([1, 2])('n %i', () => {});\n";
export const CONDITIONAL_SKIP = "it.skipIf(process.platform === 'darwin')('x', () => {});\n";
export const TODO_TEST = "it.todo('write me');\n";
export const X_PREFIXED_TEST = "xit('disabled', () => {});\n";
export const CONTEXT_SKIP = "it('x', (ctx) => {\n  ctx.skip();\n});\n";
export const RETRY_OPTION = "it('flaky', { retry: 3 }, () => {});\n";
export const RETRY_ZERO = "it('steady', { retry: 0 }, () => {});\n";
export const RETRY_SHORTHAND = "it('flaky', { retry }, () => {});\n";
// `retry` as an ordinary field name (a retry policy under test), not a Vitest option.
export const RETRY_FIELD = [
  'const policy = { retry: { maxRetries: 2 } };',
  "const governor = createGovernor('union', { retry: policy.retry }, deps);",
  'function withRetry(retry: Partial<RetryPolicy>) {',
  '  return { ...policy, retry };',
  '}',
  "it('keeps the retry policy', () => {",
  '  expect(withRetry({ retry: 1 } as never)).toEqual({ retry: { maxRetries: 2 } });',
  '});',
  '',
].join('\n');
export const RETRY_OPTION_MULTILINE = [
  'it(',
  "  'flaky', // don't retry (comment with a quote)",
  '  {',
  '    timeout: 5_000,',
  '    /* the option */ retry: 2,',
  '  },',
  '  () => {',
  "    expect(/can't/.test('a')).toBe(false);",
  '  },',
  ');',
  '',
].join('\n');
export const RETRY_OPTION_CHAINS = [
  "describe.concurrent('suite', { retry: 1 }, () => {});",
  "test.each([1, 2])('n %i', { retry: 1 }, () => {});",
  "test.for([1])('n', { retry: { count: 2 } }, () => {});",
  "suite.sequential('s', { 'retry': 1 }, () => {});",
  'it.each`a',
  "${1}`('t', { retry: 1 }, () => {});",
  '',
].join('\n');
export const RETRY_NESTED =
  "describe('s', () => {\n  it('t', { timeout: 1, retry: 4 }, () => {});\n});\n";
export const RETRY_EXTENDED_TEST =
  "const myTest = test.extend({ db: async ({}, use) => use(1) });\nmyTest('t', { retry: 2 }, () => {});\n";
export const RETRY_IMPORTED_TEST =
  "import { myTest } from './kit.ts';\nmyTest('t', { retry: 2 }, async () => {});\n";
export const OPTIONS_VARIABLE_LOCAL =
  "const LONG = { timeout: 60_000 };\nit('t', LONG, () => {});\nit('u', () => {}, 5_000);\n";
export const OPTIONS_VARIABLE_RETRY =
  "const OPTS: TestOptions = { timeout: 1, retry: 3 } as const;\nit('t', OPTS, () => {});\n";
export const OPTIONS_VARIABLE_IMPORTED =
  "import { OPTS } from './kit.ts';\nit('t', OPTS, () => {});\n";
export const OPTIONS_SPREAD = "it('t', { ...base, timeout: 1 }, () => {});\n";
export const ADMIN_URL_READ = "const url = process.env['TEST_PG_ADMIN_URL'];\n";
export const ADMIN_URL_ABSENT = "expect(process.env['TEST_PG_ADMIN_URL']).toBeUndefined();\n";
export const ADMIN_URL_ABSENT_AND_READ =
  'expect(process.env.TEST_PG_ADMIN_URL).toBeUndefined(); connect(process.env.TEST_PG_ADMIN_URL);\n';
export const LISTEN = 'await app.listen(3100);\n';
export const IMPORT_PG = "import pg from 'pg';\n";
export const IMPORT_PG_SUBPATH = "import { Pool } from 'pg/lib/index.js';\n";
export const IMPORT_PG_BOSS = "const { PgBoss } = await import('pg-boss');\n";
export const IMPORT_TESTCONTAINERS = "import { GenericContainer } from 'testcontainers';\n";
export const IMPORT_TESTCONTAINERS_MODULE = "import { X } from '@testcontainers/postgresql';\n";
export const IMPORT_DB_TESTING = "import { createTestDatabase } from '@couli/db/testing';\n";
export const REQUIRE_PG = "const pg = require('pg');\n";
export const IMPORT_HARMLESS = "import { pgTable } from './pg-helpers.ts';\nimport x from 'pgx';\n";
export const DESCRIBE_BLOCK = "describe('round', () => {\n  it('x', () => {});\n});\n";
export const DESCRIBE_EACH = "describe.each([1])('n', () => {});\n";
export const TOP_LEVEL_IT = "it('rounds half up', () => {});\n";
export const MOCK_MONEY = "vi.mock('@couli/money');\n";
export const MOCK_MONEY_RELATIVE = "vi.doMock('../../packages/money/src/index.ts', () => ({}));\n";
export const MOCK_LEDGER = "vi.mock('../../apps/api/src/modules/ledger/index.ts');\n";
export const MOCK_OTHER = "vi.mock('./clock.ts');\n";
export const AC_TITLED = "it('[AC-S1-03] 搜索返回商品卡片', () => {});\n";
export const AC_TITLED_SUFFIX = 'test("[AC-S2-26#2] 并发提现只成功一笔", () => {});\n';
export const AC_UNTITLED = "it('搜索返回商品卡片', () => {});\n";
export const AC_EACH_TITLED = "it.each([[1], [2]])('[AC-S1-04] page %i', () => {});\n";
export const AC_EACH_UNTITLED = "it.each([[1], [2]])('page %i', () => {});\n";
export const AC_DYNAMIC_TITLE = 'it(title, () => {});\n';
export const CONFIG_STRICT =
  'export default { test: { passWithNoTests: false, allowOnly: false, retry: 0 } };\n';
export const CONFIG_RETRY = 'export default { test: { retry: 2 } };\n';
export const CONFIG_PASS_EMPTY = 'export default { test: { passWithNoTests: true } };\n';
export const CONFIG_ALLOW_ONLY = 'export default { test: { allowOnly: true } };\n';
