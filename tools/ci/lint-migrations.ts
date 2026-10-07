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
// rule 2), so the files that predate the gate (0001–0018 and FROZEN_AFTER_BASELINE) are not linted, and squawk exits 1 with
// "Failed to find files" when every path it is given is excluded. The selection is therefore made
// here, and an empty selection passes with a message. The own checks (Codex ledger review of
// rebate-platform#248): a money column typed anything but bigint; a file-level `squawk-ignore-file`;
// a `squawk-ignore` comment on a statement of a funds or attribution table; and both `SET LOCAL`
// timeouts at the top of the file. When an own check fails, squawk is not run (the report would only
// repeat what the gate already refused) and the exit code is 1.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const MIGRATIONS_DIR = 'db/migrations';
export const CONFIG_FILE = '.squawk.toml';
/** Highest migration number merged before the gate. Everything above it is linted. Never raise it. */
export const GATE_BASELINE = 18;
/**
 * Migrations above the baseline that were merged before the gate itself (db/AGENTS.md rule 2: merged
 * migrations never change), by exact file name. Only ever extended by the PR that lands the gate.
 */
export const FROZEN_AFTER_BASELINE: readonly string[] = [
  '0019_device-registrations-created-at-insert.sql', // B1-02n (#233), merged while CT-06a was in review
];
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

/** Column types a money column (`*_fen`) may have (ADR-0001 §4: integer fen in bigint); anything else is refused. */
const MONEY_TYPES_OK = new Set(['bigint', 'int8']);
/** A `*_fen` column name at the start of a column definition or ALTER TABLE subcommand, and the text after it. */
const MONEY_COLUMN_DEF = /^\s*"?([a-z0-9_]+_fen)"?\s+([\s\S]*)$/i;
const MONEY_COLUMN_ADD =
  /^\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+_fen)"?\s+([\s\S]*)$/i;
const MONEY_COLUMN_ALTER =
  /^\s*ALTER\s+(?:COLUMN\s+)?"?([a-z0-9_]+_fen)"?\s+(?:SET\s+DATA\s+)?TYPE\s+([\s\S]*)$/i;
/** The type name at the start of a column type: optional pg_catalog qualifier, quoted or bare first word, and what follows. */
const TYPE_HEAD = /^(?:"?pg_catalog"?\s*\.\s*)?(?:"([^"]+)"|([a-z_][a-z0-9_]*))([\s\S]*)$/i;
const LOCK_TIMEOUT = /\bSET\s+(?:LOCAL\s+)?lock_timeout\b/i;
const STATEMENT_TIMEOUT = /\bSET\s+(?:LOCAL\s+)?statement_timeout\b/i;
// Matched anywhere in the file, not only right after `--` or the comment opener: squawk strips the
// whitespace (newlines included) inside a block comment before it reads the directive, so a
// directive on its own line inside a block comment counts. Erring towards refusal is fine here.
const IGNORE_FILE = /squawk-ignore-file\b/;
// `squawk-ignore …` as a line comment or inside a block comment: squawk honours both forms.
const IGNORE_ANY = /squawk-ignore\b(?!-file)/g;
/** Identifiers that name a table in a DDL statement: after TABLE, ON (indexes, triggers) and TRUNCATE. */
const IDENT = String.raw`"?[\w]+"?(?:\s*\.\s*"?[\w]+"?)?`;
/** Table names in a DDL statement: after TABLE / ON / TRUNCATE, past IF [NOT] EXISTS and ONLY, including a comma list (`DROP TABLE a, b`). */
const TABLE_REF = new RegExp(
  String.raw`\b(?:TABLE|ON|TRUNCATE(?:\s+TABLE)?)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?(${IDENT}(?:\s*,\s*${IDENT})*)`,
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
    if (Number(match[1]) > baseline && !FROZEN_AFTER_BASELINE.includes(name)) lint.push(name);
  }
  lint.sort();
  badNames.sort();
  return { lint, badNames };
}

/** The table name without schema and quotes, lower-cased. */
export function bareTableName(reference: string): string {
  return reference.replace(/"/g, '').split('.').pop()?.trim().toLowerCase() ?? '';
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
  // Both settings must come before the first statement that is not a SET: a timeout set after the
  // DDL does not protect it. A value of 0 means no timeout and does not count.
  let lock = false;
  let statement = false;
  let start = 0;
  for (const part of withoutComments(sql).split(';')) {
    const text = part.trim();
    const raw = sql.slice(start, start + part.length).trim();
    start += part.length + 1;
    if (text === '') continue;
    const zero = /(?:=|\bTO)\s*(?:DEFAULT|'?\s*0+(?:\.0*)?\s*(?:us|ms|s|min|h|d)?\s*'?)$/i.test(
      raw,
    );
    if (LOCK_TIMEOUT.test(text)) lock = !zero;
    else if (STATEMENT_TIMEOUT.test(text)) statement = !zero;
    else if (!/^SET\b/i.test(text)) break;
    if (lock && statement) break;
  }
  const lines: string[] = [];
  if (!lock) {
    lines.push(
      `${file}:1:0: warning: require-lock-timeout Missing \`SET LOCAL lock_timeout\` at the top of the migration (db/AGENTS.md rule 11)`,
    );
  }
  if (!statement) {
    lines.push(
      `${file}:1:0: warning: require-statement-timeout Missing \`SET LOCAL statement_timeout\` at the top of the migration (db/AGENTS.md rule 11)`,
    );
  }
  return lines;
}

/**
 * SQL with comments and the contents of string literals ('…', E'…', $tag$…$tag$) blanked to spaces:
 * same length, same line breaks, quotes and quoted identifiers kept. So a `;`, `--` or `(` inside a
 * string neither ends a statement nor starts a comment, and comment text is never read as SQL.
 */
function withoutComments(sql: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (sql.startsWith('--', i)) {
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? sql.length : j;
      out += blank(sql.slice(i, end));
      i = end;
    } else if (sql.startsWith('/*', i)) {
      // Block comments nest in PostgreSQL.
      let depth = 0;
      let j = i;
      while (j < sql.length) {
        if (sql.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else j++;
      }
      out += blank(sql.slice(i, j));
      i = j;
    } else if (c === "'") {
      const escapes = /e/i.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      const closed = j < sql.length;
      out += `'${blank(sql.slice(i + 1, Math.min(j, sql.length)))}${closed ? "'" : ''}`;
      i = closed ? j + 1 : sql.length;
    } else if (c === '"') {
      // Quoted identifiers are kept (table names are read from them); a `;` inside one is blanked.
      const j = sql.indexOf('"', i + 1);
      const end = j === -1 ? sql.length : j + 1;
      out += sql.slice(i, end).replace(/;/g, ' ');
      i = end;
    } else if (c === '$' && !/[\w$]/.test(sql[i - 1] ?? '')) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag === undefined) {
        out += c;
        i++;
        continue;
      }
      const j = sql.indexOf(tag, i + tag.length);
      const end = j === -1 ? sql.length : j + tag.length;
      out +=
        tag + blank(sql.slice(i + tag.length, j === -1 ? sql.length : j)) + (j === -1 ? '' : tag);
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Splits `text` at the commas outside parentheses, from `from` up to `to` (stops early when the depth goes below 0). */
function topLevelParts(text: string, from: number, to: number): { start: number; text: string }[] {
  const parts: { start: number; text: string }[] = [];
  let depth = 0;
  let start = from;
  let i = from;
  for (; i < to; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) {
      parts.push({ start, text: text.slice(start, i) });
      start = i + 1;
    }
  }
  parts.push({ start, text: text.slice(start, i) });
  return parts;
}

/** The money-column definitions of one statement: name, the text after it, and their offset in the statement. */
function moneyColumns(statement: string): { name: string; rest: string; at: number }[] {
  const found: { name: string; rest: string; at: number }[] = [];
  const at = (part: { start: number; text: string }): number =>
    part.start + part.text.length - part.text.trimStart().length;
  if (
    /^\s*CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\b/i.test(
      statement,
    )
  ) {
    const open = statement.indexOf('(');
    if (open === -1) return found;
    for (const part of topLevelParts(statement, open + 1, statement.length)) {
      const m = MONEY_COLUMN_DEF.exec(part.text);
      if (m !== null) found.push({ name: m[1] ?? '', rest: m[2] ?? '', at: at(part) });
    }
    return found;
  }
  const alter = new RegExp(
    String.raw`^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${IDENT}\s*\*?`,
    'i',
  ).exec(statement);
  if (alter === null) return found;
  for (const part of topLevelParts(statement, alter[0].length, statement.length)) {
    const m = MONEY_COLUMN_ADD.exec(part.text) ?? MONEY_COLUMN_ALTER.exec(part.text);
    if (m !== null) found.push({ name: m[1] ?? '', rest: m[2] ?? '', at: at(part) });
  }
  return found;
}

/** The declared type of a money column when it is not bigint / int8 (arrays included), else null. */
function badMoneyType(rest: string): string | null {
  const m = TYPE_HEAD.exec(rest.trimStart());
  if (m === null) return rest.trim().split(/\s+/)[0] ?? '?';
  const name = (m[1] ?? m[2] ?? '').toLowerCase();
  const array = /^\s*(?:\[|ARRAY\b)/i.test(m[3] ?? '');
  // `int8.fen` is a type `fen` in a schema named int8, not int8.
  if (/^\s*\./.test(m[3] ?? '')) return `${name}${(m[3] ?? '').trim().split(/[\s(]/)[0] ?? ''}`;
  return MONEY_TYPES_OK.has(name) && !array ? null : `${name}${array ? '[]' : ''}`;
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
  // Money columns: every `*_fen` column defined in CREATE TABLE or added / retyped in ALTER TABLE
  // must be bigint / int8; any other type (numeric, DEC, a domain, an array…) is refused.
  let start = 0;
  for (const statement of code.split(';')) {
    for (const column of moneyColumns(statement)) {
      const type = badMoneyType(column.rest);
      if (type !== null) {
        problems.push({
          file,
          line: lineOf(code, start + column.at),
          message: `money column ${column.name} must be bigint (ADR-0001 §4), found ${type}`,
        });
      }
    }
    start += statement.length + 1;
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
    // The statement the ignore belongs to: the one the comment precedes or sits inside (from the `;`
    // before the comment to the `;` after it; comments blanked, positions kept), or, for a comment
    // that follows a `;` on the same line with nothing in between, the statement that just ended
    // (squawk honours `… DROP COLUMN c; -- squawk-ignore ban-drop-column`). What else squawk's line
    // rule lets the comment cover is checked by running squawk without the ignores (see main).
    const at = ignore.index ?? 0;
    const prev = code.lastIndexOf(';', at);
    const stop = code.indexOf(';', at);
    const trailing = prev !== -1 && /^[ \t]*$/.test(code.slice(prev + 1, at));
    const statement = trailing
      ? code.slice(code.lastIndexOf(';', prev - 1) + 1, prev)
      : code.slice(prev + 1, stop === -1 ? code.length : stop);
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

/** The SQL with every squawk-ignore directive blanked (same offsets): what squawk reports without the exceptions. */
export function withoutIgnores(sql: string): string {
  return sql.replace(/squawk-ignore(?:-file)?/g, (m) => ' '.repeat(m.length));
}

/**
 * The funds or attribution table named by the statement that holds a squawk finding, or null.
 * `line` and `column` are squawk's gcc report positions, both counted from 0.
 */
export function fundsTableAt(sql: string, line: number, column: number): string | null {
  const code = withoutComments(sql);
  let offset = 0;
  for (let l = 0; l < line; l++) {
    const n = code.indexOf('\n', offset);
    if (n === -1) return null;
    offset = n + 1;
  }
  const at = offset + column;
  const stop = code.indexOf(';', at);
  const statement = code.slice(code.lastIndexOf(';', at - 1) + 1, stop === -1 ? code.length : stop);
  for (const ref of statement.matchAll(TABLE_REF)) {
    for (const raw of (ref[1] ?? '').split(',')) {
      const name = raw.trim();
      if (name !== '' && isFundsTable(name)) return name;
    }
  }
  return null;
}

/**
 * squawk's line rule lets an ignore comment cover more than the statement it belongs to (every
 * statement on the comment's line and the line after it). So for the files that carry an ignore,
 * squawk runs once more over copies with the ignores blanked: any finding on a funds or attribution
 * table statement is refused, whichever comment would have hidden it. Returns the refusals, or null
 * when squawk could not run.
 */
function ignoredFundsFindings(
  binary: string,
  config: string,
  files: readonly { file: string; sql: string }[],
): string[] | null {
  const scratch = mkdtempSync(join(tmpdir(), 'lint-migrations-'));
  try {
    const bare = new Map<string, { file: string; sql: string }>();
    for (const entry of files) {
      const name = basename(entry.file);
      const copy = withoutIgnores(entry.sql);
      writeFileSync(join(scratch, name), copy);
      bare.set(name, { file: entry.file, sql: copy });
    }
    const res = spawnSync(binary, ['-c', config, '--reporter', 'gcc', ...bare.keys()], {
      cwd: scratch,
      encoding: 'utf8',
    });
    if (res.error !== undefined || res.status === null) return null;
    const refusals: string[] = [];
    for (const line of res.stdout.split('\n')) {
      const m = /^(.+?):(\d+):(\d+): warning: (\S+)/.exec(line);
      const entry = m === null ? undefined : bare.get(basename(m[1] ?? ''));
      if (m === null || entry === undefined) continue;
      const table = fundsTableAt(entry.sql, Number(m[2]), Number(m[3]));
      if (table !== null) {
        refusals.push(
          `${entry.file}:${Number(m[2]) + 1}: ${m[4]} on a statement of funds or attribution table ${bareTableName(table)} (${table}) while the file carries squawk-ignore: no exceptions there (规划/02 §16.3)`,
        );
      }
    }
    return refusals;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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
      `lint-migrations: no migration after ${String(GATE_BASELINE).padStart(4, '0')} outside the frozen list, nothing to lint`,
    );
    return 0;
  }
  const files = lint.map((name) => `${MIGRATIONS_DIR}/${name}`);
  let failed = badNames.length > 0;
  const withIgnores: { file: string; sql: string }[] = [];
  for (const file of files) {
    const sql = readFileSync(join(root, file), 'utf8');
    if (/squawk-ignore/.test(sql)) withIgnores.push({ file, sql });
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
  if (withIgnores.length > 0) {
    const refusals = ignoredFundsFindings(binary, config, withIgnores);
    if (refusals === null) {
      console.error('lint-migrations: cannot run squawk over the migrations without their ignores');
      return 2;
    }
    for (const refusal of refusals) console.error(`lint-migrations: ${refusal}`);
    if (refusals.length > 0) {
      console.error('lint-migrations: the gate refused the migrations above; squawk was not run');
      return 1;
    }
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
