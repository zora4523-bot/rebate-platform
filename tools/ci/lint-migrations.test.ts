// The migration gate (tools/ci/lint-migrations.ts): selection by the gate baseline, the wrapper's own
// checks, and squawk itself against fixture migrations (a scratch root with the real .squawk.toml).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import {
  GATE_BASELINE,
  checkMigration,
  checkTimeouts,
  isFundsTable,
  selectMigrations,
} from './lint-migrations.ts';

const REPO = resolve(import.meta.dirname, '../..');
const SCRIPT = join(REPO, 'tools/ci/lint-migrations.ts');
const SCRATCH = join(REPO, '.tmp', `ci-lint-migrations-${process.pid}`);
/** What every new migration starts with (db/AGENTS.md rule 11). */
const TIMEOUTS =
  "-- Up Migration\nSET LOCAL lock_timeout = '10s';\nSET LOCAL statement_timeout = '10min';\n";

let fixtureCount = 0;

/** A scratch repository root with the real .squawk.toml and the given migration files. */
function fixture(files: Record<string, string>): string {
  const root = join(SCRATCH, String(++fixtureCount));
  mkdirSync(join(root, 'db/migrations'), { recursive: true });
  cpSync(join(REPO, '.squawk.toml'), join(root, '.squawk.toml'));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(root, 'db/migrations', name), text);
  }
  return root;
}

function run(root: string, ...extra: string[]) {
  const res = spawnSync(process.execPath, [SCRIPT, '--root', root, ...extra], {
    encoding: 'utf8',
    cwd: REPO,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

it('selects the .sql files numbered above the gate baseline, sorted, and reports misnamed ones', () => {
  const names = [
    '0020_z-last.sql',
    '0018_frozen.sql',
    'README.md',
    '0019_a-b.sql',
    '0001_app-schema.sql',
  ];
  expect(selectMigrations(names)).toEqual({
    lint: ['0019_a-b.sql', '0020_z-last.sql'],
    badNames: [],
  });
  expect(selectMigrations(names, 19)).toEqual({ lint: ['0020_z-last.sql'], badNames: [] });
  expect(selectMigrations(['0021-no-underscore.sql', '21_short.sql', '0022_Upper.sql'])).toEqual({
    lint: [],
    badNames: ['0021-no-underscore.sql', '0022_Upper.sql', '21_short.sql'],
  });
});

it('the baseline is the last migration merged before the gate', () => {
  expect(GATE_BASELINE).toBe(18);
});

it('knows the funds and attribution tables by name, with or without schema and quotes', () => {
  for (const t of [
    'app.orders',
    'order_keys',
    '"app"."order_settlements"',
    'ledger_entries',
    'accounts',
    'withdrawals',
    'payout_accounts',
    'settlement_batches',
    'commission_rates',
    'reconciliation_runs',
    'adjustments',
    'union_bindings',
    'union_pids',
    'links',
    'link_logs',
  ]) {
    expect(isFundsTable(t), t).toBe(true);
  }
  for (const t of [
    'app.articles',
    'users',
    'devices',
    'config_items',
    'product_refs',
    'inbox_messages',
    'linkage',
  ]) {
    expect(isFundsTable(t), t).toBe(false);
  }
});

it('checkMigration: a money column typed anything but bigint is a problem, bigint is not', () => {
  const sql =
    'CREATE TABLE app.t (\n  amount_fen integer NOT NULL,\n  fee_fen bigint NOT NULL,\n  rate_bp integer NOT NULL\n);\nALTER TABLE app.t ALTER COLUMN fee_fen TYPE numeric(12,2);\n';
  const problems = checkMigration('x.sql', sql);
  expect(problems.map((p) => [p.line, p.message])).toEqual([
    [2, 'money column amount_fen must be bigint (ADR-0001 §4), found integer'],
    [6, 'money column fee_fen must be bigint (ADR-0001 §4), found numeric'],
  ]);
  expect(
    checkMigration(
      'y.sql',
      'ALTER TABLE app.t ADD COLUMN total_fen bigint; -- amount_fen int in a comment is fine\n',
    ),
  ).toEqual([]);
});

it('checkMigration: squawk-ignore-file is refused anywhere in the file', () => {
  const problems = checkMigration('x.sql', '-- Up Migration\n-- squawk-ignore-file\nSELECT 1;\n');
  expect(problems).toHaveLength(1);
  expect(problems[0]?.line).toBe(2);
});

it('checkMigration: squawk-ignore on a funds-table statement is refused, before or inside the statement; another table is allowed', () => {
  const before =
    '-- Up Migration\n-- the column is unused\n-- squawk-ignore ban-drop-column\nALTER TABLE app.orders DROP COLUMN note;\n';
  expect(checkMigration('x.sql', before).map((p) => p.line)).toEqual([3]);
  const inside = 'ALTER TABLE app.orders -- squawk-ignore ban-drop-column\n  DROP COLUMN note;\n';
  expect(checkMigration('x.sql', inside).map((p) => p.line)).toEqual([1]);
  const beforeName =
    'ALTER TABLE\n  -- squawk-ignore ban-drop-column\n  app.order_keys DROP COLUMN note;\n';
  expect(checkMigration('x.sql', beforeName).map((p) => p.line)).toEqual([2]);
  const index =
    '-- squawk-ignore require-concurrent-index-creation\nCREATE INDEX x ON app.union_credentials (user_id);\n';
  expect(checkMigration('x.sql', index)).toHaveLength(1);
  const other =
    '-- Up Migration\n-- squawk-ignore ban-drop-column\nALTER TABLE app.articles DROP COLUMN note;\n-- squawk-ignore ban-drop-column\nALTER TABLE ONLY "app"."users" DROP COLUMN IF EXISTS nick;\nALTER TABLE app.devices -- squawk-ignore ban-drop-column\n  DROP COLUMN note;\n';
  expect(checkMigration('x.sql', other)).toEqual([]);
});

it('classifies every table of db/schema.sql: the funds and attribution tables and nothing else', () => {
  const schema = readFileSync(join(REPO, 'db/schema.sql'), 'utf8');
  const tables = [...schema.matchAll(/^CREATE TABLE app\.([a-z0-9_]+)/gm)].map(
    (m) => m[1] as string,
  );
  expect(tables.length).toBeGreaterThan(40);
  const funds = new Set([
    'orders',
    'orders_default',
    'order_keys',
    'order_rights',
    'order_settlements',
    'payout_accounts',
    'payout_account_changes',
    'payout_account_verify_attempts',
    'union_accounts',
    'union_credentials',
    'union_pids',
    'union_bindings',
    'union_auth_sessions',
    'links',
    'link_logs',
    'link_logs_default',
    'link_open_attempts',
  ]);
  for (const name of funds) expect(tables, name).toContain(name);
  for (const name of tables) expect(isFundsTable(`app.${name}`), name).toBe(funds.has(name));
});

it('checkMigration: a trailing same-line ignore after the semicolon, a block-comment ignore, IF EXISTS / ONLY and comma lists all name the funds table', () => {
  const trailing = 'ALTER TABLE app.orders DROP COLUMN c; -- squawk-ignore ban-drop-column\n';
  expect(checkMigration('x.sql', trailing).map((p) => p.message)).toEqual([
    expect.stringContaining('funds or attribution table orders'),
  ]);
  const trailingNext =
    'ALTER TABLE app.articles DROP COLUMN c; -- squawk-ignore ban-drop-column\nALTER TABLE app.orders ADD COLUMN n bigint;\n';
  // The trailing comment belongs to the articles statement; a plain ADD COLUMN on the next line is legal.
  expect(checkMigration('x.sql', trailingNext)).toEqual([]);
  const block = '/* squawk-ignore ban-drop-table */\nDROP TABLE IF EXISTS app.orders;\n';
  expect(checkMigration('x.sql', block).map((p) => p.message)).toEqual([
    expect.stringContaining('funds or attribution table orders'),
  ]);
  for (const sql of [
    '-- squawk-ignore ban-drop-table\nDROP TABLE IF EXISTS app.orders;\n',
    '-- squawk-ignore ban-drop-column\nALTER TABLE ONLY app.orders DROP COLUMN c;\n',
    '-- squawk-ignore renaming-column\nALTER TABLE IF EXISTS app.ledger_entries RENAME COLUMN a TO b;\n',
    '-- squawk-ignore ban-drop-table\nDROP TABLE app.articles, app.orders;\n',
  ]) {
    expect(checkMigration('x.sql', sql), sql).toHaveLength(1);
  }
  expect(checkMigration('x.sql', '/* squawk-ignore-file */\nSELECT 1;\n')).toHaveLength(1);
});

it('checkMigration: money columns in CHECK, trigger expressions and COMMENT are not column definitions; SET DATA TYPE is', () => {
  const ok =
    "CREATE TABLE app.t (amount_fen bigint NOT NULL CHECK (amount_fen > 0), CHECK (x_fen IS NOT NULL));\nCOMMENT ON COLUMN app.t.amount_fen IS 'fen';\nCREATE FUNCTION app.f() RETURNS trigger AS $$ BEGIN IF NEW.x_fen IS DISTINCT FROM OLD.x_fen THEN RAISE EXCEPTION 'no'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;\n";
  expect(checkMigration('x.sql', ok)).toEqual([]);
  for (const sql of [
    'CREATE TABLE app.t (amount_fen text);\n',
    'ALTER TABLE app.t ADD COLUMN amount_fen pg_catalog.int4;\n',
    'ALTER TABLE app.t ADD COLUMN amount_fen character varying(20);\n',
  ]) {
    expect(
      checkMigration('x.sql', sql).map((p) => p.message),
      sql,
    ).toEqual([expect.stringContaining('amount_fen must be bigint')]);
  }
  expect(
    checkMigration('x.sql', 'ALTER TABLE app.t ADD COLUMN amount_fen pg_catalog.int8;\n'),
  ).toEqual([]);
  expect(
    checkMigration(
      'x.sql',
      'ALTER TABLE app.t ALTER COLUMN amount_fen SET DATA TYPE integer;\n',
    ).map((p) => p.message),
  ).toEqual([expect.stringContaining('amount_fen must be bigint')]);
});

it('passes the real repository: every migration is either frozen or accepted', () => {
  const res = run(REPO);
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
});

it('passes with a message when no migration is newer than the baseline', () => {
  const res = run(fixture({ '0018_frozen.sql': 'ALTER TABLE app.t DROP COLUMN c;\n' }));
  expect(res.status).toBe(0);
  expect(res.stdout).toContain('nothing to lint');
});

it('--list prints the files that would be linted, one per line', () => {
  const res = run(
    fixture({ '0019_a.sql': '-- Up Migration\n', '0020_b.sql': '-- Up Migration\n' }),
    '--list',
  );
  expect(res.status).toBe(0);
  expect(res.stdout).toBe('db/migrations/0019_a.sql\ndb/migrations/0020_b.sql\n');
});

it('fails on a DROP COLUMN in a new migration and names the squawk rule', () => {
  const res = run(fixture({ '0019_drop.sql': `${TIMEOUTS}ALTER TABLE app.t DROP COLUMN c;\n` }));
  expect(res.status).toBe(1);
  expect(res.stdout).toContain('ban-drop-column');
});

it('fails on a column type change and a rename in a new migration', () => {
  const res = run(
    fixture({
      '0019_type.sql': `${TIMEOUTS}ALTER TABLE app.t ALTER COLUMN c TYPE bigint;\n`,
      '0020_rename.sql': `${TIMEOUTS}ALTER TABLE app.t RENAME COLUMN a TO b;\n`,
    }),
  );
  expect(res.status).toBe(1);
  expect(res.stdout).toContain('changing-column-type');
  expect(res.stdout).toContain('renaming-column');
});

it('fails when a new migration does not set the lock and statement timeouts first', () => {
  const res = run(
    fixture({
      '0019_no-timeouts.sql': '-- Up Migration\nALTER TABLE app.t ADD COLUMN n bigint;\n',
    }),
  );
  expect(res.status).toBe(1);
  expect(res.stdout).toContain('require-lock-timeout');
  expect(res.stdout).toContain('require-statement-timeout');
});

it('fails on a money column that is not bigint, before squawk runs', () => {
  const res = run(
    fixture({
      '0019_money.sql': `${TIMEOUTS}CREATE TABLE app.t (id uuid PRIMARY KEY, amount_fen integer NOT NULL);\n`,
    }),
  );
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('amount_fen must be bigint');
});

it('fails on squawk-ignore-file and on a squawk-ignore before a funds-table statement (the bypass samples)', () => {
  const res = run(
    fixture({
      '0019_file.sql': `${TIMEOUTS}-- squawk-ignore-file\nALTER TABLE app.articles DROP COLUMN c;\n`,
      '0020_funds.sql': `${TIMEOUTS}-- squawk-ignore ban-drop-column\nALTER TABLE app.orders DROP COLUMN c;\n`,
      '0021_inside.sql': `${TIMEOUTS}ALTER TABLE app.union_accounts -- squawk-ignore ban-drop-column\n  DROP COLUMN c;\n`,
    }),
  );
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('squawk-ignore-file is not accepted');
  expect(res.stderr).toContain('funds or attribution table orders');
  expect(res.stderr).toContain('funds or attribution table union_accounts');
  expect(res.stdout).not.toMatch(/warning: ban-drop-column/);
});

it('accepts a squawk-ignore comment with its reason on the line before a statement on another table', () => {
  const res = run(
    fixture({
      '0019_drop.sql': `${TIMEOUTS}-- app.articles is not a funds table (规划/02 §4.1); the column was never read.\n-- squawk-ignore ban-drop-column\nALTER TABLE app.articles DROP COLUMN c;\n`,
    }),
  );
  expect(res.stderr).toBe('');
  expect(res.stdout).not.toContain('ban-drop-column');
  expect(res.status).toBe(0);
});

it('accepts the DDL patterns the repository uses: timeouts, a new table with its index, a GRANT, a trigger', () => {
  const res = run(
    fixture({
      '0019_new.sql':
        `${TIMEOUTS}` +
        'CREATE TABLE app.t (id uuid PRIMARY KEY, app_id text NOT NULL, amount_fen bigint NOT NULL, rate_bp integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now());\n' +
        'CREATE INDEX t_app_id_idx ON app.t (app_id);\n' +
        'GRANT SELECT, INSERT ON app.t TO couli_app;\n' +
        'CREATE TRIGGER t_no_update BEFORE UPDATE ON app.t FOR EACH ROW EXECUTE FUNCTION app.forbid_update();\n',
    }),
  );
  expect(res.stderr).toBe('');
  expect(res.stdout).not.toContain('warning');
  expect(res.status).toBe(0);
});

it('fails on a misnamed migration file even when there is nothing else to lint', () => {
  const res = run(fixture({ '0019-dash.sql': '-- Up Migration\n' }));
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('0019-dash.sql');
  expect(res.stdout).not.toContain('nothing to lint');
});

it('checkTimeouts: both SET LOCAL timeouts are required, reported under the squawk rule names', () => {
  expect(checkTimeouts('x.sql', TIMEOUTS)).toEqual([]);
  expect(
    checkTimeouts('x.sql', "SET lock_timeout = '5s';\nSET statement_timeout = '1min';\n"),
  ).toEqual([]);
  const missing = checkTimeouts(
    'x.sql',
    "-- SET LOCAL lock_timeout = '5s' (only in a comment)\nCREATE TABLE app.t (id uuid);\n",
  );
  expect(missing).toHaveLength(2);
  expect(missing[0]).toMatch(/^x\.sql:1:0: warning: require-lock-timeout /);
  expect(missing[1]).toMatch(/^x\.sql:1:0: warning: require-statement-timeout /);
});

it('checkMigration: a directive on its own line inside a block comment still counts (squawk strips the newlines)', () => {
  const drop = 'ALTER TABLE app.orders DROP COLUMN c;\n';
  for (const comment of ['/*\nsquawk-ignore-file\n*/\n', '/*\r\n  squawk-ignore-file\r\n*/\r\n']) {
    expect(checkMigration('x.sql', comment + drop).map((p) => p.message)).toEqual([
      expect.stringContaining('squawk-ignore-file is not accepted'),
    ]);
  }
  for (const comment of [
    '/*\n  squawk-ignore ban-drop-column\n*/\n',
    '/*\r\n  squawk-ignore ban-drop-column\r\n*/\r\n',
  ]) {
    expect(checkMigration('x.sql', comment + drop)).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('funds or attribution table orders'),
      }),
    ]);
  }
});

it('checkMigration: an ignore covers every statement on the line after it, as squawk applies it', () => {
  const sql =
    '-- squawk-ignore ban-drop-column\nALTER TABLE app.articles DROP COLUMN a; ALTER TABLE app.orders DROP COLUMN c;\n';
  expect(checkMigration('x.sql', sql)).toEqual([
    expect.objectContaining({
      message: expect.stringContaining('funds or attribution table orders'),
    }),
  ]);
  // A statement two lines below is out of the ignore's reach and is not blamed on it.
  expect(
    checkMigration(
      'x.sql',
      '-- squawk-ignore ban-drop-column\nALTER TABLE app.articles DROP COLUMN a;\nALTER TABLE app.orders ADD COLUMN n bigint;\n',
    ),
  ).toEqual([]);
});

it('checkMigration: spaces around the schema dot and quoted type names do not hide a funds table or a money column', () => {
  expect(
    checkMigration(
      'x.sql',
      '-- squawk-ignore ban-drop-column\nALTER TABLE app . orders DROP COLUMN c;\n',
    ),
  ).toEqual([
    expect.objectContaining({
      message: expect.stringContaining('funds or attribution table orders'),
    }),
  ]);
  expect(
    checkMigration('x.sql', 'CREATE TABLE app.t (amount_fen "int4");').map((p) => p.message),
  ).toEqual([expect.stringContaining('amount_fen must be bigint')]);
  expect(checkMigration('x.sql', 'CREATE TABLE app.t (amount_fen "pg_catalog"."int8");')).toEqual(
    [],
  );
});

it('checkMigration: a trailing ignore after a non-funds statement does not blame a GRANT on a funds table on the next line', () => {
  expect(
    checkMigration(
      'x.sql',
      'ALTER TABLE app.articles DROP COLUMN c; -- squawk-ignore ban-drop-column\nGRANT SELECT ON app.orders TO couli_readonly;\n',
    ),
  ).toEqual([]);
  expect(
    checkMigration(
      'x.sql',
      'ALTER TABLE app.articles DROP COLUMN c; -- squawk-ignore ban-drop-column\nALTER TABLE app.orders DROP COLUMN d;\n',
    ),
  ).toEqual([
    expect.objectContaining({
      message: expect.stringContaining('funds or attribution table orders'),
    }),
  ]);
});

it('checkMigration: a money column declared as an array of bigint is refused', () => {
  for (const sql of [
    'CREATE TABLE app.t (amount_fen bigint[]);',
    'CREATE TABLE app.t (amount_fen int8 ARRAY);',
  ]) {
    expect(checkMigration('x.sql', sql).map((p) => p.message)).toEqual([
      expect.stringContaining('amount_fen must be bigint'),
    ]);
  }
});

it('checkTimeouts: the two settings must come before the first statement that is not a SET', () => {
  expect(
    checkTimeouts(
      'x.sql',
      "CREATE TABLE app.t (id uuid PRIMARY KEY);\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '1min';\n",
    ),
  ).toHaveLength(2);
  expect(
    checkTimeouts(
      'x.sql',
      "SET LOCAL lock_timeout = '5s';\nCREATE TABLE app.t (id uuid PRIMARY KEY);\nSET LOCAL statement_timeout = '1min';\n",
    ),
  ).toEqual([expect.stringMatching(/warning: require-statement-timeout /)]);
  expect(
    checkTimeouts(
      'x.sql',
      "-- Up Migration\nSET LOCAL search_path = app;\nSET LOCAL statement_timeout = '1min';\nSET LOCAL lock_timeout = '5s';\nCREATE TABLE t (id uuid);\n",
    ),
  ).toEqual([]);
});

it('checkMigration: TRUNCATE TABLE with an ignore is refused on a funds table (TABLE is a keyword there, not the name)', () => {
  for (const sql of [
    '-- squawk-ignore ban-truncate-cascade\nTRUNCATE TABLE app.ledger_entries, app.accounts CASCADE;\n',
    '-- squawk-ignore ban-truncate-cascade\nTRUNCATE app.articles, app.orders CASCADE;\n',
  ]) {
    expect(checkMigration('x.sql', sql)).toEqual([
      expect.objectContaining({ message: expect.stringContaining('funds or attribution table') }),
    ]);
  }
});

it('checkMigration: money columns are an allowlist — only bigint / int8 pass, whatever else is declared', () => {
  for (const [sql, type] of [
    ['CREATE TABLE app.order_totals (app_id text NOT NULL, amount_fen DEC(12,2));', 'dec'],
    ['CREATE TABLE app.t (amount_fen app.money_domain NOT NULL);', 'app'],
    ['CREATE TABLE app.t (amount_fen citext);', 'citext'],
    ['CREATE TABLE app.t (amount_fen int8range);', 'int8range'],
    [
      'ALTER TABLE app.t ADD COLUMN note text, ADD COLUMN IF NOT EXISTS fee_fen numeric(12, 2);',
      'numeric',
    ],
    ['ALTER TABLE ONLY app.t ALTER fee_fen TYPE double precision;', 'double'],
  ] as const) {
    expect(checkMigration('x.sql', sql).map((p) => p.message)).toEqual([
      expect.stringContaining(`found ${type}`),
    ]);
  }
  for (const sql of [
    'CREATE TABLE IF NOT EXISTS app.t (id uuid PRIMARY KEY, "amount_fen" BIGINT NOT NULL DEFAULT 0 CHECK (amount_fen >= 0), note text DEFAULT \'a, b (c\');',
    'ALTER TABLE app.t ALTER COLUMN amount_fen SET NOT NULL, ALTER COLUMN amount_fen SET DEFAULT 0;',
    'CREATE INDEX t_amount_idx ON app.t (amount_fen DESC);',
    'ALTER TABLE app.t ADD CONSTRAINT t_amount_fen_ck CHECK (amount_fen > 0);',
    'INSERT INTO app.t (amount_fen) VALUES (1);',
  ]) {
    expect(checkMigration('x.sql', sql)).toEqual([]);
  }
});

it('checkMigration: semicolons and comment markers inside string literals do not split statements or start comments', () => {
  expect(
    checkMigration(
      'x.sql',
      "ALTER TABLE app.orders ADD COLUMN note text DEFAULT ';', DROP COLUMN c; -- squawk-ignore ban-drop-column\n",
    ),
  ).toEqual([
    expect.objectContaining({
      message: expect.stringContaining('funds or attribution table orders'),
    }),
  ]);
  expect(
    checkMigration(
      'x.sql',
      "-- squawk-ignore ban-drop-column\nALTER TABLE app.orders ADD COLUMN note text DEFAULT '--', DROP COLUMN c;\n",
    ),
  ).toEqual([
    expect.objectContaining({
      message: expect.stringContaining('funds or attribution table orders'),
    }),
  ]);
  expect(
    checkMigration('x.sql', "CREATE TABLE app.t (note text DEFAULT '--', amount_fen integer);").map(
      (p) => p.message,
    ),
  ).toEqual([expect.stringContaining('amount_fen must be bigint')]);
});

it('checkTimeouts: a timeout of 0 (no timeout at all) does not count', () => {
  expect(
    checkTimeouts(
      'x.sql',
      "SET LOCAL lock_timeout = 0;\nSET LOCAL statement_timeout = '0';\nCREATE TABLE app.t (id uuid);\n",
    ),
  ).toHaveLength(2);
  expect(
    checkTimeouts(
      'x.sql',
      "SET LOCAL lock_timeout TO '10s';\nSET LOCAL statement_timeout = 600000;\n",
    ),
  ).toEqual([]);
});

it("checkMigration: a statement after a blank line is out of a trailing ignore's reach", () => {
  expect(
    checkMigration(
      'x.sql',
      "ALTER TABLE app.articles ADD CONSTRAINT articles_title_nonempty CHECK (title <> ''); -- squawk-ignore constraint-missing-not-valid\n\nALTER TABLE app.orders ADD COLUMN note text;\n",
    ),
  ).toEqual([]);
  expect(
    checkMigration(
      'x.sql',
      '-- squawk-ignore ban-drop-column\nALTER TABLE app.articles DROP COLUMN a;\n\nALTER TABLE app.orders DROP COLUMN c;\n',
    ),
  ).toEqual([]);
});

it('checkTimeouts: 0 with a unit and DEFAULT (both mean no timeout) do not count', () => {
  expect(
    checkTimeouts(
      'x.sql',
      "SET LOCAL lock_timeout = '0h';\nSET LOCAL statement_timeout TO DEFAULT;\n",
    ),
  ).toHaveLength(2);
});

it("checkMigration: statements an ignore reaches through squawk's line rule are refused only when destructive on a funds table", () => {
  // A plain ADD COLUMN on a funds table on the line after a trailing ignore stays legal.
  expect(
    checkMigration(
      'x.sql',
      'ALTER TABLE app.articles DROP COLUMN old_title; -- squawk-ignore ban-drop-column\nALTER TABLE app.orders ADD COLUMN extra_fen bigint;\n',
    ),
  ).toEqual([]);
  // A funds-table DROP earlier on the same line as the trailing ignore is refused (squawk ignores the whole line).
  expect(
    checkMigration(
      'x.sql',
      'ALTER TABLE app.orders DROP COLUMN a; ALTER TABLE app.articles DROP COLUMN b; -- squawk-ignore ban-drop-column\n',
    ),
  ).toEqual([
    expect.objectContaining({
      message: expect.stringContaining('funds or attribution table orders'),
    }),
  ]);
  // A funds-table RENAME on the next line is refused.
  expect(
    checkMigration(
      'x.sql',
      'ALTER TABLE app.articles DROP COLUMN b; -- squawk-ignore ban-drop-column\nALTER TABLE app.ledger_entries RENAME COLUMN a TO b;\n',
    ),
  ).toEqual([
    expect.objectContaining({
      message: expect.stringContaining('funds or attribution table ledger_entries'),
    }),
  ]);
});

it('checkMigration: a semicolon inside a quoted identifier does not split the statement', () => {
  expect(
    checkMigration(
      'x.sql',
      'CREATE TABLE app.t (id uuid PRIMARY KEY, "note;tag" text, amount_fen integer);',
    ).map((p) => p.message),
  ).toEqual([expect.stringContaining('amount_fen must be bigint')]);
});
