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
/** Statements an ignore reaches only through squawk's next-line rule are checked when they change a table. */
const ALTERING = /^\s*(?:ALTER|DROP|TRUNCATE)\b/i;
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
    if (Number(match[1]) > baseline) lint.push(name);
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
    const zero = /(?:=|\bTO)\s*'?\s*0+\s*(?:ms|s|min)?\s*'?$/i.test(raw);
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
      const j = sql.indexOf('"', i + 1);
      const end = j === -1 ? sql.length : j + 1;
      out += sql.slice(i, end);
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
    // The statement the ignore belongs to, whether the comment precedes it or sits inside it:
    // from the `;` before the comment to the `;` after it (comments blanked, positions kept).
    const at = ignore.index ?? 0;
    const prev = code.lastIndexOf(';', at);
    const stop = code.indexOf(';', at);
    // squawk applies an ignore to the line the comment ends on and the line after it, so every
    // statement touching those two lines is covered as well (`… ; ALTER TABLE app.orders …` there).
    const inBlock = sql.lastIndexOf('/*', at) > sql.lastIndexOf('*/', at);
    const commentEnd = inBlock ? Math.max(at, sql.indexOf('*/', at)) : at;
    const lineEnd = (i: number): number => {
      const n = code.indexOf('\n', i);
      return n === -1 ? code.length : n;
    };
    const windowEnd = lineEnd(lineEnd(commentEnd) + 1);
    const own = stop === -1 ? code.length : stop;
    let end = own;
    if (windowEnd > end) {
      const next = code.indexOf(';', windowEnd);
      end = code.slice(0, windowEnd).trimEnd().endsWith(';')
        ? windowEnd
        : next === -1
          ? code.length
          : next;
    }
    // The statement the ignore belongs to. A trailing comment on the same line as a `;` belongs to
    // the statement that just ended (squawk honours `… DROP COLUMN c; -- squawk-ignore ban-drop-column`),
    // not to the one after it.
    const trailing = prev !== -1 && !code.slice(prev + 1, at).includes('\n');
    const statements = trailing
      ? [code.slice(code.lastIndexOf(';', prev - 1) + 1, prev)]
      : [code.slice(prev + 1, own)];
    // Statements reached only through the next-line rule: checked when they alter or drop a table,
    // so a GRANT or an index on a funds table right after an ignored line stays legal.
    const reached = trailing ? code.slice(prev + 1, end) : code.slice(own + 1, end);
    statements.push(...reached.split(';').filter((part) => ALTERING.test(part)));
    const statement = statements.join(';');
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
