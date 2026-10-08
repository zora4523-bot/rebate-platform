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
// CT-06b (gaps left by the CT-06a reviews): squawk's report columns are UTF-8 bytes; a timeout of 0,
// DEFAULT or a later RESET does not count; the frozen migrations are checked by exact name and content
// hash (and none may go missing), a new file at or below the baseline and a JS / TS migration are
// refused; destructive DDL inside a DO block, SET SCHEMA on a funds table, a column renamed into a
// money column and money columns made by CREATE TABLE … AS / SELECT … INTO are refused; quoted
// identifiers may touch the next token.
// CT-06c: processed_events and idempotency_keys join the funds tables; triggers, constraints and
// indexes of a funds table may not be dropped or disabled unless the same migration recreates the same
// name; DROP … CASCADE is refused; the functions that funds-table triggers execute may not be dropped,
// replaced, renamed, re-owned or moved.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
/**
 * Every migration merged before the gate, by exact file name, with the sha256 of its content
 * (db/AGENTS.md rule 2: merged migrations never change). A change, a missing file or a new file at or
 * below GATE_BASELINE is refused (CT-06b).
 */
export const FROZEN_MIGRATIONS: Readonly<Record<string, string>> = {
  '0001_app-schema.sql': '5b94c1466b3dd8ddfdf1005435e7f154f6a4641598069cf47080a4bea3dfb968',
  '0002_pgboss-schema-v42.sql': '4ff98aa1378add7f31e8bd85d212a76462c6bb7b141e5c396ef24f59b1650bf6',
  '0003_platform-baseline.sql': '2d6c36579af887428524baf1ac08d42483d42626f80a5b8aafc0207370181933',
  '0004_idempotency-keys-abandoned.sql':
    'b26c83f90724836fcd9a8b8c4bd73859550a023d0166af2ccf74a6ebbcd26b0b',
  '0005_identity-baseline.sql': 'cc428179b775278d9a1cb7aca3263fe1397c229fe274fb02e282f08bdd5c7b78',
  '0006_linking-baseline.sql': 'a4fb56c80fa2f89f5810618d4e90fa9c5bbe62d4775a6d8d4fcbd927f7a97429',
  '0007_orders-baseline.sql': '49b37465da78d20df6880a71a8433e98cea18a8f1b57fa6f460be31a6b036db9',
  '0008_notification-baseline.sql':
    '3c63b9ad94f58b458b4a065c4da1ac19633d86950196fc7ae75c978620ad0e35',
  '0009_payout-account-baseline.sql':
    '91952c0d5d20037b47c06d64ff834dfd348752093d626207e5a61f784e53efaf',
  '0010_content-config-baseline.sql':
    '309a9507b21c94c45df2820dc816354024c2cb5151e5a725b2223c8c160874a6',
  '0011_partition-maintenance.sql':
    'f723cfdfb070802a5e46a45499808fbbbfad589cb225f952b2a0e104d0491a70',
  '0012_link-logs-day-partitions.sql':
    '851f96266e8d6536954df0a863c34690d82667017635dfebdb9be3c67e363d73',
  '0013_identity-sessions.sql': '47b52083c585905b046aa234912bec0b0f9d2b60e7c959cc7752c7e576becf37',
  '0014_risk-baseline.sql': '64edb5e276763b034509898b3f793be965e000b94f4f9f0348d33afb97f2529f',
  '0015_union-accounts-pids.sql':
    'cf80deafa59a2da24f75d85791e74f77524982ac994add30ba2d6d681a6c8333',
  '0016_admin-baseline.sql': 'c3e5ace3d71914d83a65d0428a665a137c7055be9fd1f891279b10e953794db0',
  '0017_catalog-baseline.sql': '88a6afda2b64ef7f3b30a8dd9149da31de8d1d0c4454fa9dfb6e7a3090b85f8c',
  '0018_linking-bindings.sql': '8f4cf8b044cbb2e3f3b0de45a9cf75783d99692f82df3a0207f6339a6ae9a675',
  '0019_device-registrations-created-at-insert.sql':
    '93bac397c2fe2d47b23b414bfaa1b5c8bb5aaa1764090f0e2d3a867e73ebd0d0',
};
/** Extensions node-pg-migrate would run from db/migrations besides SQL. */
const SCRIPT_MIGRATION = /\.(?:js|cjs|mjs|ts)$/;
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
// processed_events (consumer dedupe) and idempotency_keys (write idempotency, withdrawals included):
// 规划/04 §3.2; CT-06c.
export const FUNDS_TABLE_NAMES: readonly string[] = [
  'links',
  'processed_events',
  'idempotency_keys',
];

/** Column types a money column (`*_fen`) may have (ADR-0001 §4: integer fen in bigint); anything else is refused. */
const MONEY_TYPES_OK = new Set(['bigint', 'int8']);
/** A `*_fen` column name at the start of a column definition or ALTER TABLE subcommand, and the text after it. */
// A quoted name may touch the next token (`"amount_fen"integer`); a bare one needs whitespace.
const FEN_NAME = String.raw`(?:\s*"([a-z0-9_]+_fen)"\s*|\s+([a-z0-9_]+_fen)\s+)`;
const MONEY_COLUMN_DEF = new RegExp(
  String.raw`^(?:\s*"([a-z0-9_]+_fen)"\s*|\s*([a-z0-9_]+_fen)\s+)([\s\S]*)$`,
  'i',
);
const MONEY_COLUMN_ADD = new RegExp(
  String.raw`^\s*ADD(?:\s+COLUMN\b)?(?:\s+IF\s+NOT\s+EXISTS\b)?${FEN_NAME}([\s\S]*)$`,
  'i',
);
const MONEY_COLUMN_ALTER = new RegExp(
  String.raw`^\s*ALTER(?:\s+COLUMN\b)?${FEN_NAME}(?:SET\s+DATA\s+)?TYPE(?:\s+|(?="))([\s\S]*)$`,
  'i',
);
/** The type name at the start of a column type: optional pg_catalog qualifier, quoted or bare first word, and what follows. */
const TYPE_HEAD = /^(?:"?pg_catalog"?\s*\.\s*)?(?:"([^"]+)"|([a-z_][a-z0-9_]*))([\s\S]*)$/i;
/** `SET [LOCAL | SESSION] lock_timeout | statement_timeout = | TO <value>`. */
const TIMEOUT_SET =
  /^SET\s+(?:LOCAL\s+|SESSION\s+)?(lock_timeout|statement_timeout)\s*(?:=|\bTO\b)\s*([\s\S]*)$/i;
const TIMEOUT_RESET = /^RESET\s+(lock_timeout|statement_timeout|ALL)\s*$/i;
/** Milliseconds per unit of a timeout value (no unit means milliseconds). */
const TIMEOUT_UNITS: Readonly<Record<string, number>> = {
  us: 0.001,
  ms: 1,
  s: 1000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
// Matched anywhere in the file, not only right after `--` or the comment opener: squawk strips the
// whitespace (newlines included) inside a block comment before it reads the directive, so a
// directive on its own line inside a block comment counts. Erring towards refusal is fine here.
const IGNORE_FILE = /squawk-ignore-file\b/;
// `squawk-ignore …` as a line comment or inside a block comment: squawk honours both forms.
const IGNORE_ANY = /squawk-ignore\b(?!-file)/g;
/** Identifiers that name a table in a DDL statement: after TABLE, ON (indexes, triggers) and TRUNCATE. */
const IDENT = String.raw`"?[\w]+"?(?:\s*\.\s*"?[\w]+"?)?`;
/** Whitespace, or nothing before a quoted identifier (`DROP TABLE"app"."orders"`). */
const GAP = String.raw`(?:\s+|(?="))`;
/** Table names in a DDL statement: after TABLE / ON / TRUNCATE, past IF [NOT] EXISTS and ONLY, including a comma list (`DROP TABLE a, b`). */
/** `ALTER TABLE [IF EXISTS] [ONLY] <table>` at the start of a statement; group 1 is the table. */
const ALTER_TABLE = new RegExp(
  String.raw`^\s*ALTER\s+TABLE${GAP}(?:IF\s+EXISTS${GAP})?(?:ONLY${GAP})?(${IDENT})\s*\*?`,
  'i',
);
/** `CREATE [GLOBAL|LOCAL] [TEMP|UNLOGGED] TABLE [IF NOT EXISTS] <t> [(cols)] [WITH (…)] [TABLESPACE x] AS …`. */
const CREATE_TABLE_AS = new RegExp(
  String.raw`^\s*CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE${GAP}(?:IF\s+NOT\s+EXISTS${GAP})?${IDENT}\s*(?:\([^()]*\)\s*)?(?:WITH\s*\([^()]*\)\s*)?(?:TABLESPACE\s+\w+\s*)?AS\b`,
  'i',
);
const TABLE_REF = new RegExp(
  String.raw`\b(?:TABLE|ON|TRUNCATE(?:\s+TABLE)?)${GAP}(?:IF\s+(?:NOT\s+)?EXISTS${GAP})?(?:ONLY${GAP})?(${IDENT}(?:\s*,\s*${IDENT})*)`,
  'gi',
);

export type Selection = { lint: string[]; badNames: string[] };
export type Problem = { file: string; line: number; message: string };
/** What a migration is checked against: db/schema.sql and the SQL of the migrations before it. */
export type MigrationContext = { schemaSql: string; migrationsSql: readonly string[] };
const NO_CONTEXT: MigrationContext = { schemaSql: '', migrationsSql: [] };

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
  // Both settings must be set to more than 0 before the first statement that is not a SET (a timeout
  // set after the DDL does not protect it), and nothing later in the file may RESET them or set them
  // back to 0 / DEFAULT. Comments are ignored; the value is read with its string quotes.
  const code = withoutComments(sql);
  const valued = withoutComments(sql, true);
  let lock = false;
  let statement = false;
  let lockLost = false;
  let statementLost = false;
  let header = true;
  let start = 0;
  for (const part of code.split(';')) {
    const text = part.trim();
    const value = valued.slice(start, start + part.length).trim();
    start += part.length + 1;
    if (text === '') continue;
    const set = TIMEOUT_SET.exec(value);
    const reset = TIMEOUT_RESET.exec(text);
    if (set !== null) {
      // A timeout set to 0 / DEFAULT anywhere in the file (before or after the real one) disables it.
      const on = timeoutMilliseconds(set[2] ?? '') > 0;
      const isLock = (set[1] ?? '').toLowerCase() === 'lock_timeout';
      if (!on) {
        if (isLock) lockLost = true;
        else statementLost = true;
      } else if (header) {
        if (isLock) lock = true;
        else statement = true;
      }
    } else if (reset !== null) {
      // RESET anywhere in the file, before or after the SET, disables the setting.
      const what = (reset[1] ?? '').toLowerCase();
      if (what !== 'statement_timeout') lockLost = true;
      if (what !== 'lock_timeout') statementLost = true;
    } else if (!/^SET\b/i.test(text)) {
      header = false;
    }
  }
  if (lockLost) lock = false;
  if (statementLost) statement = false;
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
 * A timeout value in milliseconds as PostgreSQL reads it (rounded to whole milliseconds); 0 for 0,
 * DEFAULT or anything below half a millisecond. A value it cannot read counts as set (squawk and the
 * database will judge it).
 */
function timeoutMilliseconds(raw: string): number {
  const text = raw
    .trim()
    .replace(/^'([\s\S]*)'$/, '$1')
    .trim();
  if (/^DEFAULT$/i.test(text)) return 0;
  const m = /^(\d*\.?\d+)\s*(us|ms|s|min|h|d)?$/i.exec(text);
  if (m === null) return Number.POSITIVE_INFINITY;
  return Math.round(Number(m[1]) * (TIMEOUT_UNITS[(m[2] ?? 'ms').toLowerCase()] ?? 1));
}

/**
 * SQL with comments and the contents of string literals ('…', E'…', $tag$…$tag$) blanked to spaces:
 * same length, same line breaks, quotes and quoted identifiers kept. So a `;`, `--` or `(` inside a
 * string neither ends a statement nor starts a comment, and comment text is never read as SQL. With
 * keepStrings the string contents stay (comments are still blanked): values and DO block bodies.
 */
function withoutComments(sql: string, keepStrings = false): string {
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
      const body = sql.slice(i + 1, Math.min(j, sql.length));
      out += `'${keepStrings ? body : blank(body)}${closed ? "'" : ''}`;
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
      const body = sql.slice(i + tag.length, j === -1 ? sql.length : j);
      out += tag + (keepStrings ? body : blank(body)) + (j === -1 ? '' : tag);
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
      if (m !== null) found.push({ name: m[1] ?? m[2] ?? '', rest: m[3] ?? '', at: at(part) });
    }
    return found;
  }
  const alter = ALTER_TABLE.exec(statement);
  if (alter === null) return found;
  for (const part of topLevelParts(statement, alter[0].length, statement.length)) {
    const m = MONEY_COLUMN_ADD.exec(part.text) ?? MONEY_COLUMN_ALTER.exec(part.text);
    if (m !== null) found.push({ name: m[1] ?? m[2] ?? '', rest: m[3] ?? '', at: at(part) });
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

/**
 * CT-06b: destructive DDL inside a DO block (squawk does not look into it), SET SCHEMA on a funds
 * table, a column renamed into a money column, and money columns made by CREATE TABLE … AS or
 * SELECT … INTO (their type is whatever the query yields).
 */
function structureProblems(file: string, sql: string, code: string): Problem[] {
  const problems: Problem[] = [];
  const valued = withoutComments(sql, true);
  // DO blocks: the body is a dollar-quoted string, blanked in `code`; read it from `valued` and drop
  // its own comments (the strings stay: EXECUTE 'DROP …' is exactly what is looked for).
  const doBlock = /\bDO\s+(?:LANGUAGE\s+\w+\s+)?(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/gi;
  for (const m of code.matchAll(doBlock)) {
    const tag = m[1] ?? '$$';
    const open = (m.index ?? 0) + m[0].length;
    const close = code.indexOf(tag, open);
    const body = withoutComments(valued.slice(open, close === -1 ? code.length : close), true);
    const destructive =
      /\b(?:DROP|RENAME|TRUNCATE)\b/i.test(body) ||
      body.split(';').some((part) => /\bALTER\b[\s\S]*\bTYPE\b/i.test(part));
    if (destructive) {
      problems.push({
        file,
        line: lineOf(code, m.index ?? 0),
        message:
          'destructive DDL inside a DO block (DROP, RENAME, TRUNCATE or ALTER … TYPE): squawk does not check it; write it as plain SQL',
      });
    }
  }
  let start = 0;
  for (const statement of code.split(';')) {
    const at = start + statement.length - statement.trimStart().length;
    start += statement.length + 1;
    const alter = ALTER_TABLE.exec(statement);
    if (alter !== null) {
      const table = alter[1] ?? '';
      if (/\bSET\s+SCHEMA\b/i.test(statement) && isFundsTable(table)) {
        problems.push({
          file,
          line: lineOf(code, at),
          message: `SET SCHEMA on funds or attribution table ${bareTableName(table)} (${table}): no exceptions there (规划/02 §16.3)`,
        });
      }
      for (const m of statement.matchAll(
        /\bRENAME(?:\s+COLUMN\b)?(?:\s*"[^"]*"\s*|\s+\w+\s+)TO(?:\s*"([a-z0-9_]+_fen)"|\s+([a-z0-9_]+_fen)\b)/gi,
      )) {
        const name = m[1] ?? m[2] ?? '';
        problems.push({
          file,
          line: lineOf(code, at),
          message: `money column ${name} must be declared as bigint, not renamed into (ADR-0001 §4)`,
        });
      }
    }
    // SELECT … INTO creates a table; WITH … INSERT INTO … SELECT does not.
    const selectInto =
      /^\s*(?:WITH\b[\s\S]*?)?\bSELECT\b[\s\S]*?\bINTO\b/i.test(statement) &&
      !/\b(?:INSERT|UPDATE|DELETE|MERGE)\b/i.test(statement);
    if (CREATE_TABLE_AS.test(statement) || selectInto) {
      const money = /"?\b([a-z0-9_]+_fen)\b"?/i.exec(statement);
      if (money !== null) {
        problems.push({
          file,
          line: lineOf(code, at),
          message: `money column ${money[1]} must be declared as bigint, not made by CREATE TABLE … AS or SELECT … INTO (ADR-0001 §4)`,
        });
      }
    }
  }
  return problems;
}

/** The bare name of a table, index, trigger or function reference (schema, quotes and arguments removed). */
function bareName(reference: string): string {
  return bareTableName(reference.replace(/\([\s\S]*$/, ''));
}

const CREATE_INDEX = new RegExp(
  String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+ON${GAP}(?:ONLY${GAP})?(${IDENT})`,
  'gi',
);
const ADD_INDEX_CONSTRAINT = new RegExp(
  String.raw`\bADD\s+CONSTRAINT${GAP}(${IDENT})\s*(?:PRIMARY\s+KEY|UNIQUE|EXCLUDE)\b`,
  'gi',
);
const CREATE_TRIGGER = new RegExp(
  String.raw`^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER${GAP}(${IDENT})[\s\S]*?\bON${GAP}(?:ONLY${GAP})?(${IDENT})(?:[\s\S]*?\bEXECUTE\s+(?:FUNCTION|PROCEDURE)${GAP}(${IDENT})\s*\()?`,
  'i',
);

/** Statements of a SQL text (comments and string contents blanked), with their offsets. */
function statementsOf(code: string): { text: string; at: number; start: number; end: number }[] {
  const out: { text: string; at: number; start: number; end: number }[] = [];
  let start = 0;
  for (const text of code.split(';')) {
    out.push({
      text,
      at: start + text.length - text.trimStart().length,
      start,
      end: start + text.length,
    });
    start += text.length + 1;
  }
  return out;
}

/**
 * Index name → table, both bare and lower-cased, from CREATE [UNIQUE] INDEX and from the primary key,
 * unique and exclusion constraints added with ALTER TABLE (their index has the constraint's name), in
 * db/schema.sql and the given migrations.
 */
export function indexOwners(
  schemaSql: string,
  migrationsSql: readonly string[],
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const sql of [schemaSql, ...migrationsSql]) {
    const code = withoutComments(sql);
    for (const m of code.matchAll(CREATE_INDEX))
      owners.set(bareName(m[1] ?? ''), bareName(m[2] ?? ''));
    for (const { text } of statementsOf(code)) {
      const alter = ALTER_TABLE.exec(text);
      if (alter === null) continue;
      for (const m of text.matchAll(ADD_INDEX_CONSTRAINT)) {
        owners.set(bareName(m[1] ?? ''), bareName(alter[1] ?? ''));
      }
    }
  }
  return owners;
}

/**
 * Function → one funds or attribution table it guards, both bare and lower-cased: the functions that
 * triggers on funds tables execute, from db/schema.sql and the given migrations.
 */
export function fundsTriggerFunctions(
  schemaSql: string,
  migrationsSql: readonly string[],
): Map<string, string> {
  const guards = new Map<string, string>();
  for (const sql of [schemaSql, ...migrationsSql]) {
    for (const { text } of statementsOf(withoutComments(sql))) {
      const m = CREATE_TRIGGER.exec(text);
      if (m === null || m[3] === undefined || !isFundsTable(m[2] ?? '')) continue;
      const fn = bareName(m[3]);
      if (!guards.has(fn)) guards.set(fn, bareName(m[2] ?? ''));
    }
  }
  return guards;
}

/**
 * CT-06c (规划/02 §16.3): the triggers, constraints and indexes of a funds or attribution table are
 * part of it. Dropping one is refused unless a later statement of the same migration recreates the
 * same name on the same table; disabling a trigger is refused; DROP … CASCADE is refused (it silently
 * takes dependent triggers, foreign keys and constraints with it); the functions funds-table triggers
 * execute may not be dropped, replaced, renamed, re-owned or moved.
 */
function fundsObjectProblems(
  file: string,
  sql: string,
  code: string,
  context: MigrationContext,
): Problem[] {
  const valued = withoutComments(sql, true);
  const problems: Problem[] = [];
  const statements = statementsOf(code);
  const refuse = (at: number, message: string): void => {
    problems.push({ file, line: lineOf(code, at), message: `${message} (规划/02 §16.3)` });
  };
  const later = (k: number): string[] => statements.slice(k + 1).map((s) => s.text);
  const funds = (ref: string): boolean => isFundsTable(ref);
  statements.forEach(({ text, at, start, end }, k) => {
    // DROP TRIGGER <name> ON <funds table>, unless recreated later in the file.
    const dropTrigger = new RegExp(
      String.raw`^\s*DROP\s+TRIGGER\s+(?:IF\s+EXISTS${GAP})?(${IDENT})\s+ON${GAP}(?:ONLY${GAP})?(${IDENT})`,
      'i',
    ).exec(text);
    if (dropTrigger !== null && funds(dropTrigger[2] ?? '')) {
      const name = bareName(dropTrigger[1] ?? '');
      const table = bareName(dropTrigger[2] ?? '');
      const recreated = later(k).some((t) => {
        const m = CREATE_TRIGGER.exec(t);
        return m !== null && bareName(m[1] ?? '') === name && bareName(m[2] ?? '') === table;
      });
      if (!recreated)
        refuse(at, `trigger ${name} on funds or attribution table ${table} may not be dropped`);
    }
    const alter = ALTER_TABLE.exec(text);
    if (alter !== null) {
      const tableRef = alter[1] ?? '';
      const table = bareName(tableRef);
      const parts = topLevelParts(text, alter[0].length, text.length);
      parts.forEach((part, i) => {
        // ALTER TABLE … DROP COLUMN | CONSTRAINT … CASCADE (any table).
        if (/^\s*DROP\b[\s\S]*\bCASCADE\s*$/i.test(part.text)) {
          refuse(at, `DROP … CASCADE is not accepted: drop dependent objects explicitly`);
        }
        if (!funds(tableRef)) return;
        const disable = /^\s*DISABLE\s+TRIGGER\s+("[^"]+"|\w+)/i.exec(part.text);
        if (disable !== null) {
          refuse(
            at,
            `trigger ${bareName(disable[1] ?? '')} on funds or attribution table ${table} may not be disabled`,
          );
        }
        const dropConstraint = new RegExp(
          String.raw`^\s*DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS${GAP})?(${IDENT})`,
          'i',
        ).exec(part.text);
        if (dropConstraint !== null) {
          const name = bareName(dropConstraint[1] ?? '');
          const addsSame = (t: string): boolean =>
            [...t.matchAll(new RegExp(String.raw`\bADD\s+CONSTRAINT${GAP}(${IDENT})`, 'gi'))].some(
              (m) => bareName(m[1] ?? '') === name,
            );
          const recreated =
            parts.slice(i + 1).some((p) => addsSame(p.text)) ||
            later(k).some((t) => {
              const a = ALTER_TABLE.exec(t);
              return a !== null && bareName(a[1] ?? '') === table && addsSame(t);
            });
          if (!recreated)
            refuse(
              at,
              `constraint ${name} on funds or attribution table ${table} may not be dropped`,
            );
        }
      });
    }
    // DROP <anything> … CASCADE.
    if (/^\s*DROP\b[\s\S]*\bCASCADE\s*$/i.test(text)) {
      refuse(at, 'DROP … CASCADE is not accepted: drop dependent objects explicitly');
    }
    // DROP INDEX <name>[, …] of a funds table, unless recreated later in the file.
    const dropIndex = new RegExp(
      String.raw`^\s*DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS${GAP})?(${IDENT}(?:\s*,\s*${IDENT})*)`,
      'i',
    ).exec(text);
    if (dropIndex !== null) {
      const owners = indexOwners(context.schemaSql, [...context.migrationsSql, code.slice(0, at)]);
      for (const raw of (dropIndex[1] ?? '').split(',')) {
        const name = bareName(raw.trim());
        const owner = owners.get(name);
        const table = owner ?? (funds(name) ? name : undefined);
        if (table === undefined || !funds(table)) continue;
        const recreated = later(k).some((t) =>
          [...t.matchAll(CREATE_INDEX)].some(
            (m) =>
              bareName(m[1] ?? '') === name &&
              (owner === undefined || bareName(m[2] ?? '') === owner),
          ),
        );
        if (!recreated)
          refuse(at, `index ${name} on funds or attribution table ${table} may not be dropped`);
      }
    }
    // The functions funds-table triggers execute: from the schema, earlier migrations and the triggers
    // created earlier in this file (a new function created before its trigger is fine).
    // CREATE OR REPLACE is how a guard is extended (0020 does it for union_auth_sessions); only a
    // replacement whose body no longer raises is a bypass.
    const replace = new RegExp(
      String.raw`^\s*CREATE\s+OR\s+REPLACE\s+(?:FUNCTION|PROCEDURE)${GAP}(${IDENT})\s*\(`,
      'i',
    ).exec(text);
    const replaceRaises =
      replace !== null && /\bRAISE\s+EXCEPTION\b/i.test(valued.slice(start, end));
    const fn =
      new RegExp(
        String.raw`^\s*DROP\s+(?:FUNCTION|PROCEDURE)\s+(?:IF\s+EXISTS${GAP})?(${IDENT}(?:\s*\([^)]*\))?(?:\s*,\s*${IDENT}(?:\s*\([^)]*\))?)*)`,
        'i',
      ).exec(text)?.[1] ??
      (replaceRaises ? undefined : replace?.[1]) ??
      new RegExp(
        String.raw`^\s*ALTER\s+(?:FUNCTION|PROCEDURE)${GAP}(${IDENT})(?:\s*\([^)]*\))?\s+(?:RENAME\s+TO|OWNER\s+TO|SET\s+SCHEMA)\b`,
        'i',
      ).exec(text)?.[1];
    if (fn !== undefined) {
      const guards = fundsTriggerFunctions(context.schemaSql, [
        ...context.migrationsSql,
        code.slice(0, at),
      ]);
      for (const raw of fn.replace(/\([^)]*\)/g, '').split(',')) {
        const name = bareName(raw.trim());
        const table = guards.get(name);
        if (table !== undefined) {
          refuse(
            at,
            `function ${name} guards funds or attribution table ${table}: it may not be dropped, replaced, renamed, re-owned or moved`,
          );
        }
      }
    }
  });
  return problems;
}

/** The checks squawk cannot express, over one migration file. */
export function checkMigration(
  file: string,
  sql: string,
  context: MigrationContext = NO_CONTEXT,
): Problem[] {
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
  problems.push(...structureProblems(file, sql, code));
  problems.push(...fundsObjectProblems(file, sql, code, context));
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

/** The string index in `lineText` of squawk's report column, which counts UTF-8 bytes. */
export function byteColumnToIndex(lineText: string, byteColumn: number): number {
  let bytes = 0;
  let index = 0;
  for (const ch of lineText) {
    if (bytes >= byteColumn) break;
    bytes += Buffer.byteLength(ch, 'utf8');
    index += ch.length;
  }
  return index;
}

/**
 * The funds or attribution table named by the statement that holds a squawk finding, or null.
 * `line` and `column` are squawk's gcc report positions, both counted from 0; the column counts
 * UTF-8 bytes.
 */
export function fundsTableAt(sql: string, line: number, column: number): string | null {
  const code = withoutComments(sql);
  let offset = 0;
  for (let l = 0; l < line; l++) {
    const n = code.indexOf('\n', offset);
    if (n === -1) return null;
    offset = n + 1;
  }
  const end = sql.indexOf('\n', offset);
  const at = offset + byteColumnToIndex(sql.slice(offset, end === -1 ? sql.length : end), column);
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

/**
 * db/AGENTS.md rule 2 on the directory: frozen migrations unchanged (sha256) and all present once any
 * of them is (a scratch root with only new migrations does not trip that), no new SQL file at or below
 * the baseline, and no JS / TS migration (node-pg-migrate would run it unchecked).
 */
function checkFrozen(dir: string, names: readonly string[]): string[] {
  const problems: string[] = [];
  const present = new Set(names);
  // The real repository carries the frozen files; a scratch root with made-up old names (rule tests)
  // does not, and the frozen-set rules (missing files, strangers at or below the baseline) skip it.
  const anyFrozen = names.some((name) => FROZEN_MIGRATIONS[name] !== undefined);
  for (const name of [...names].sort()) {
    const path = `${MIGRATIONS_DIR}/${name}`;
    if (SCRIPT_MIGRATION.test(name)) {
      problems.push(`${path} is not a SQL migration: only NNNN_kebab-name.sql files are accepted`);
      continue;
    }
    if (!name.endsWith('.sql')) continue;
    const expected = FROZEN_MIGRATIONS[name];
    if (expected !== undefined) {
      const actual = createHash('sha256')
        .update(readFileSync(join(dir, name)))
        .digest('hex');
      if (actual !== expected) {
        problems.push(
          `${path} changed after merge: merged migrations never change (db/AGENTS.md rule 2)`,
        );
      }
      continue;
    }
    const match = MIGRATION_FILE.exec(name);
    if (anyFrozen && match !== null && Number(match[1]) <= GATE_BASELINE) {
      problems.push(
        `${path} is numbered at or below the gate baseline ${String(GATE_BASELINE).padStart(4, '0')}: a new migration takes the next free number`,
      );
    }
  }
  if (anyFrozen) {
    for (const name of Object.keys(FROZEN_MIGRATIONS)) {
      if (!present.has(name)) {
        problems.push(
          `${MIGRATIONS_DIR}/${name} is missing: merged migrations stay (db/AGENTS.md rule 2)`,
        );
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
  const names = readdirSync(dir);
  const { lint, badNames } = selectMigrations(names);
  for (const name of badNames) {
    console.error(
      `lint-migrations: ${MIGRATIONS_DIR}/${name} is not named NNNN_kebab-name.sql (db/AGENTS.md rule 1)`,
    );
  }
  const frozenProblems = checkFrozen(dir, names);
  for (const problem of frozenProblems) console.error(`lint-migrations: ${problem}`);
  const refused = badNames.length > 0 || frozenProblems.length > 0;
  if (list) {
    for (const name of lint) console.log(`${MIGRATIONS_DIR}/${name}`);
    return refused ? 1 : 0;
  }
  if (lint.length === 0) {
    if (refused) return 1;
    console.log(
      `lint-migrations: no migration after ${String(GATE_BASELINE).padStart(4, '0')} outside the frozen list, nothing to lint`,
    );
    return 0;
  }
  const files = lint.map((name) => `${MIGRATIONS_DIR}/${name}`);
  let failed = refused;
  // CT-06c context: db/schema.sql (absent in scratch roots) and the SQL of every migration before
  // the one being checked.
  const schemaPath = join(root, 'db/schema.sql');
  const schemaSql = existsSync(schemaPath) ? readFileSync(schemaPath, 'utf8') : '';
  const allSql = names
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
  const withIgnores: { file: string; sql: string }[] = [];
  for (const file of files) {
    const sql = readFileSync(join(root, file), 'utf8');
    if (/squawk-ignore/.test(sql)) withIgnores.push({ file, sql });
    const context: MigrationContext = {
      schemaSql,
      migrationsSql: allSql.filter((m) => m.name < basename(file)).map((m) => m.sql),
    };
    for (const problem of checkMigration(file, sql, context)) {
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
