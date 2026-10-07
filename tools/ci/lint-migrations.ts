// Migration SQL gate: runs squawk over the migrations added after the gate (CT-06a, 2026-10-07),
// after three checks of its own that squawk cannot express.
// Rules: ADR-0001 §2 "边界与规范" row (squawk); 规划/02 §16.3 "迁移" row (funds tables: no DROP, no
// type change, no RENAME); ADR-0001 §4 (money columns `*_fen` are bigint); db/AGENTS.md rule 11.
// Rule selection lives in /.squawk.toml.
//
// Usage: node tools/ci/lint-migrations.ts [--root <repo dir>] [--squawk <binary>] [--list]
// Exit codes: 0 ok (nothing to lint counts as ok), 1 a check or squawk reported a problem, or a
// migration file name is not NNNN_kebab-name.sql, 2 usage or internal error (squawk missing).
//
// Why a wrapper and not `squawk db/migrations/*.sql`: merged migrations never change (db/AGENTS.md
// rule 2), so the files that predate the gate (0001–0018) are not linted, and squawk exits 1 with
// "Failed to find files" when every path it is given is excluded. The selection is therefore made
// here, and an empty selection passes with a message. The own checks (Codex ledger review of
// rebate-platform#248): a money column typed anything but bigint; a file-level `squawk-ignore-file`;
// a `squawk-ignore` comment on a statement of a funds or attribution table; and both `SET LOCAL`
// timeouts at the top of the file. When an own check fails, squawk is not run (the report would only
// repeat what the gate already refused) and the exit code is 1.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MIGRATIONS_DIR = 'db/migrations';
export const CONFIG_FILE = '.squawk.toml';
/** Highest migration number merged before the gate. Everything above it is linted. Never raise it. */
export const GATE_BASELINE = 18;
/** db/AGENTS.md rule 1: four-digit sequence, a dash-separated lowercase name, `.sql`. */
const MIGRATION_FILE = /^(\d{4})_[a-z0-9][a-z0-9-]*\.sql$/;

/**
 * Funds and attribution tables (规划/02 §16.3; the modules of MONEY_PATHS in tools/ci/evidence-check.ts):
 * orders, ledger, accounts, withdrawals, payouts, settlement, commission, reconciliation, adjustments,
 * vouchers and entries, balances, union accounts / credentials / pids / bindings, links and link logs.
 * Matched by prefix on the bare table name (schema and quotes removed). Extend only through a
 * guard-change task.
 */
export const FUNDS_TABLE_PREFIXES: readonly string[] = [
  'order',
  'ledger',
  'account',
  'withdraw',
  'payout',
  'settle',
  'commission',
  'reconcil',
  'adjust',
  'voucher',
  'entries',
  'balance',
  'union_',
  'link_',
];
export const FUNDS_TABLE_NAMES: readonly string[] = ['links'];

/** Column types a money column (`*_fen`) may have (ADR-0001 §4: integer fen in bigint). */
const MONEY_TYPES_OK = new Set(['bigint', 'int8']);
const COLUMN_TYPE =
  /"?\b([a-z0-9_]+_fen)\b"?\s+(?:(?:SET\s+DATA\s+)?TYPE\s+)?(?:pg_catalog\.)?(bigint|int8|int2|int4|integer|int|smallint|serial|smallserial|bigserial|numeric|decimal|real|double\s+precision|float\d*|money|text|varchar|character(?:\s+varying)?|char|json|jsonb|boolean|bool|uuid|date|timestamptz|timestamp|bytea)\b/gi;
const LOCK_TIMEOUT = /\bSET\s+(?:LOCAL\s+)?lock_timeout\b/i;
const STATEMENT_TIMEOUT = /\bSET\s+(?:LOCAL\s+)?statement_timeout\b/i;
const IGNORE_FILE = /(?:--|\/\*)[ \t]*squawk-ignore-file\b/;
// `-- squawk-ignore …` as a line comment or inside a block comment: squawk honours both forms.
const IGNORE_ANY = /(?:--|\/\*)[ \t]*squawk-ignore\b(?!-file)/g;
/** Identifiers that name a table in a DDL statement: after TABLE, ON (indexes, triggers) and TRUNCATE. */
const IDENT = String.raw`"?[\w]+"?(?:\."?[\w]+"?)?`;
/** Table names in a DDL statement: after TABLE / ON / TRUNCATE, past IF [NOT] EXISTS and ONLY, including a comma list (`DROP TABLE a, b`). */
const TABLE_REF = new RegExp(
  String.raw`\b(?:TABLE|ON|TRUNCATE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?(${IDENT}(?:\s*,\s*${IDENT})*)`,
  'gi',
);

export type Selection = { lint: string[]; badNames: string[] };
export type Problem = { file: string; line: number; message: string };

/** Splits the `.sql` entries of db/migrations into the files to lint and the misnamed ones. */
export function selectMigrations(names: readonly string[], baseline = GATE_BASELINE): Selection {
  const lint: string[] = [];
  const badNames: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.sql')) continue;
    const match = MIGRATION_FILE.exec(name);
    if (match === null) {
      badNames.push(name);
      continue;
    }
    if (Number(match[1]) > baseline) lint.push(name);
  }
  lint.sort();
  badNames.sort();
  return { lint, badNames };
}

/** The table name without schema and quotes, lower-cased. */
export function bareTableName(reference: string): string {
  return reference.replace(/"/g, '').split('.').pop()?.toLowerCase() ?? '';
}

export function isFundsTable(reference: string): boolean {
  const bare = bareTableName(reference);
  return FUNDS_TABLE_NAMES.includes(bare) || FUNDS_TABLE_PREFIXES.some((p) => bare.startsWith(p));
}

/**
 * db/AGENTS.md rule 11: every new migration sets both timeouts (`SET LOCAL lock_timeout`,
 * `SET LOCAL statement_timeout`). squawk's require-*-timeout rules only fire before statements it
 * considers slow, so a migration that only creates tables would pass them without any timeout; the
 * gate requires the two statements regardless. Reported in squawk's gcc format under the rule names.
 */
export function checkTimeouts(file: string, sql: string): string[] {
  const code = withoutComments(sql);
  const lines: string[] = [];
  if (!LOCK_TIMEOUT.test(code)) {
    lines.push(
      `${file}:1:0: warning: require-lock-timeout Missing \`SET LOCAL lock_timeout\` at the top of the migration (db/AGENTS.md rule 11)`,
    );
  }
  if (!STATEMENT_TIMEOUT.test(code)) {
    lines.push(
      `${file}:1:0: warning: require-statement-timeout Missing \`SET LOCAL statement_timeout\` at the top of the migration (db/AGENTS.md rule 11)`,
    );
  }
  return lines;
}

/** SQL with line comments and block comments blanked to spaces: same length, same line breaks. */
function withoutComments(sql: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return sql.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank);
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The checks squawk cannot express, over one migration file. */
export function checkMigration(file: string, sql: string): Problem[] {
  const problems: Problem[] = [];
  const code = withoutComments(sql);
  for (const match of code.matchAll(COLUMN_TYPE)) {
    const type = (match[2] ?? '').toLowerCase().replace(/\s+/g, ' ');
    if (!MONEY_TYPES_OK.has(type)) {
      problems.push({
        file,
        line: lineOf(code, match.index ?? 0),
        message: `money column ${match[1]} must be bigint (ADR-0001 §4), found ${type}`,
      });
    }
  }
  const ignoreFile = IGNORE_FILE.exec(sql);
  if (ignoreFile !== null) {
    problems.push({
      file,
      line: lineOf(sql, ignoreFile.index),
      message: 'squawk-ignore-file is not accepted; ignore single statements with a reason instead',
    });
  }
  for (const ignore of sql.matchAll(IGNORE_ANY)) {
    // The statement the ignore belongs to, whether the comment precedes it or sits inside it:
    // from the `;` before the comment to the `;` after it (comments blanked, positions kept).
    const at = ignore.index ?? 0;
    const prev = code.lastIndexOf(';', at);
    const stop = code.indexOf(';', at);
    let statement = code.slice(prev + 1, stop === -1 ? code.length : stop);
    // A trailing comment on the same line as the `;` belongs to the statement that just ended
    // (squawk honours `… DROP COLUMN c; -- squawk-ignore ban-drop-column`), so that one is checked too.
    if (prev !== -1 && !code.slice(prev + 1, at).includes('\n')) {
      statement = `${code.slice(code.lastIndexOf(';', prev - 1) + 1, prev)}\n${statement}`;
    }
    const names = [...statement.matchAll(TABLE_REF)].flatMap((ref) => (ref[1] ?? '').split(','));
    for (const raw of names) {
      const name = raw.trim();
      if (name !== '' && isFundsTable(name)) {
        problems.push({
          file,
          line: lineOf(sql, at),
          message: `squawk-ignore on a statement of funds or attribution table ${bareTableName(name)} (${name}): no exceptions there (规划/02 §16.3)`,
        });
        break;
      }
    }
  }
  return problems;
}

function usage(): never {
  console.error(
    'usage: node tools/ci/lint-migrations.ts [--root <repo dir>] [--squawk <binary>] [--list]',
  );
  process.exit(2);
}

function main(argv: readonly string[]): number {
  let root = resolve(import.meta.dirname, '../..');
  let squawk: string | undefined;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1] !== undefined) root = resolve(argv[++i] as string);
    else if (arg === '--squawk' && argv[i + 1] !== undefined) squawk = resolve(argv[++i] as string);
    else if (arg === '--list') list = true;
    else usage();
  }
  const dir = join(root, MIGRATIONS_DIR);
  if (!existsSync(dir)) {
    console.error(`lint-migrations: ${dir} does not exist`);
    return 2;
  }
  const { lint, badNames } = selectMigrations(readdirSync(dir));
  for (const name of badNames) {
    console.error(
      `lint-migrations: ${MIGRATIONS_DIR}/${name} is not named NNNN_kebab-name.sql (db/AGENTS.md rule 1)`,
    );
  }
  if (list) {
    for (const name of lint) console.log(`${MIGRATIONS_DIR}/${name}`);
    return badNames.length === 0 ? 0 : 1;
  }
  if (lint.length === 0) {
    if (badNames.length > 0) return 1;
    console.log(
      `lint-migrations: no migration after ${String(GATE_BASELINE).padStart(4, '0')}, nothing to lint`,
    );
    return 0;
  }
  const files = lint.map((name) => `${MIGRATIONS_DIR}/${name}`);
  let failed = badNames.length > 0;
  for (const file of files) {
    const sql = readFileSync(join(root, file), 'utf8');
    for (const problem of checkMigration(file, sql)) {
      console.error(`lint-migrations: ${problem.file}:${problem.line}: ${problem.message}`);
      failed = true;
    }
    for (const line of checkTimeouts(file, sql)) {
      console.log(line);
      failed = true;
    }
  }
  if (failed) {
    console.error('lint-migrations: the gate refused the migrations above; squawk was not run');
    return 1;
  }
  // The squawk-cli package of the root devDependencies: pnpm links its launcher into .bin.
  const binary = squawk ?? join(resolve(import.meta.dirname, '../..'), 'node_modules/.bin/squawk');
  if (!existsSync(binary)) {
    console.error(
      `lint-migrations: ${binary} not found; run pnpm install (squawk-cli is a root devDependency)`,
    );
    return 2;
  }
  const config = join(root, CONFIG_FILE);
  if (!existsSync(config)) {
    console.error(`lint-migrations: ${config} not found`);
    return 2;
  }
  console.log(`lint-migrations: squawk over ${files.join(' ')}`);
  const res = spawnSync(binary, ['-c', config, '--reporter', 'gcc', ...files], {
    cwd: root,
    stdio: 'inherit',
  });
  if (res.error !== undefined) {
    console.error(`lint-migrations: cannot run squawk: ${res.error.message}`);
    return 2;
  }
  if (res.status === null) {
    console.error(`lint-migrations: squawk was killed by signal ${res.signal ?? 'unknown'}`);
    return 2;
  }
  return res.status !== 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`lint-migrations: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
