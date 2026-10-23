// CT-06zu static helpers (no database, no Redis, no Nest): BR-AI-02 ③ lets agent use platform's
// infrastructure (database connection, Redis) on the condition that it reads and writes only the
// Agent's own tables and keys (D10-287, D10-288 Q1). depcruise judges files, not table names or
// key namespaces, so this scans the TypeScript AST of apps/api/src/modules/agent/** (test files and
// dist excluded) and of apps/api/src/app.module.ts.
//
// 口径（台账 ①–⑤）:
//  ① Kysely tables (by method name, any receiver). Writes insertInto / updateTable / deleteFrom /
//    mergeInto / replaceInto: every table argument is a string literal 'agent_x' / 'app.agent_x',
//    optionally 'agent_x as a'; an array argument is checked element by element; anything else
//    is a violation. Reads selectFrom / innerJoin / leftJoin / rightJoin / fullJoin / crossJoin /
//    innerJoinLateral / leftJoinLateral / crossJoinLateral (first argument), and .from / .using
//    chained after a Kysely builder call: the same literal rule, except that a name defined by
//    .with / .withRecursive('name', …) in the same file, a callback ((eb) => …) and an aliased
//    subquery (….as('x')) pass (the builder calls inside them are scanned on their own).
//    withSchema(arg) must be the literal 'app' (so 'agent_x' after it means app.agent_x).
//  ② SQL text is read from sql`…` tagged templates and from the literal argument of sql.raw, where
//    `sql` is the identifier sql or any local name an import binds `sql` to (import { sql as q })
//    and k.sql for a namespace import of 'kysely'; and from the argument of .query(…) when the
//    receiver's last name is a database handle: q / db / tx / trx / client / pool / conn /
//    connection / executor / database / kysely (any case), or a camelCase name ending in Db / Tx /
//    Trx / Client / Pool / Conn / Connection / Executor. Such a .query takes a sql tag, a sql.x(…)
//    call (sql.raw is checked on its own), a string or a template; a variable, any other call or
//    a concatenation is a violation. .query on any other
//    receiver is not SQL. sql.lit(…) is a quoted value, not SQL. sql.raw with any argument other
//    than a plain literal (a variable, a template with substitutions) is a violation.
//    Comments, SQL comments and SQL strings ('…', E'…' with backslash escapes) are not SQL; the
//    body of a $tag$…$tag$ quote is scanned as SQL on its own (DO blocks). A keyword right after
//    . or " is a column name, not a statement.
//    Writes INSERT INTO / UPDATE / DELETE FROM / MERGE INTO / TRUNCATE / SELECT … INTO must target
//    app.agent_x or a bare agent_x. UPDATE after FOR / KEY / DO / ON / OF / OR / BEFORE / AFTER is
//    a lock or conflict clause. Reads FROM (with comma lists) / JOIN / USING must name app.agent_x,
//    a bare agent_x, or a CTE defined by WITH x AS in the same SQL; a parenthesised subquery /
//    VALUES / column list and a function call (unnest(…)) pass. FROM after IS [NOT] DISTINCT and
//    inside extract / substring / substr / trim / overlay / position is not a table. ALTER / DROP
//    / CREATE / GRANT / REVOKE / COPY / LOCK / CALL / set_config and a statement SET [LOCAL |
//    SESSION] ROLE / SESSION AUTHORIZATION are violations whatever follows. A substitution
//    ${sql.table('…')}, ${sql.id('…'[, '…'])} or ${sql.raw('…')} with literal arguments
//    contributes its text; any other substitution is opaque, and an opaque or missing table is a
//    violation.
//  ③ .namespace(arg) (by method name, any receiver): arg is a string literal agent_[a-z0-9_-]+.
//  ④ app.module.ts: every .namespace(x) resolves to a string — a literal, a const of this file, or
//    an exported const reached through relative imports / re-exports — that starts with agent_
//    or is on the caller's list of other modules' namespaces; anything unresolved is a violation.
//    Accessing .namespace other than by a direct call is a violation.
//  ⑤ Bypasses in agent code: the identifiers executeQuery and CompiledQuery anywhere; db.schema.…
//    (x.schema.y / x.schema[y]); a Kysely table method, withSchema or namespace accessed other
//    than by a direct call (destructuring, .call / .bind / .apply, passing it on); a non-literal
//    key on a database-handle or *redis* receiver (db[m]); a sql local used other than as a tag
//    or as sql.x (const s = sql).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const AGENT = join(ROOT, 'apps/api/src/modules/agent');
export const APP_MODULE = join(ROOT, 'apps/api/src/app.module.ts');

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === 'dist' || name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** apps/api/src/modules/agent/** TypeScript sources, test files and dist excluded. */
export function agentSources(): SourceFile[] {
  return filesUnder(AGENT)
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }));
}

export function appModuleSource(): SourceFile {
  return { path: APP_MODULE, text: readFileSync(APP_MODULE, 'utf8') };
}

const AGENT_TABLE = /^agent_[a-z0-9_]+$/u;
const AGENT_NAMESPACE = /^agent_[a-z0-9_-]+$/u;
const KYSELY_TABLE = /^\s*(?:app\.)?(agent_[a-z0-9_]+)(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*$/u;
const KYSELY_NAME = /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*$/u;
const WRITE_METHODS = new Set([
  'insertInto',
  'updateTable',
  'deleteFrom',
  'mergeInto',
  'replaceInto',
]);
const READ_METHODS = new Set([
  'selectFrom',
  'innerJoin',
  'leftJoin',
  'rightJoin',
  'fullJoin',
  'crossJoin',
  'innerJoinLateral',
  'leftJoinLateral',
  'crossJoinLateral',
]);
/** Builder roots after which .from / .using name a table. */
const BUILDER_ROOTS = new Set([...WRITE_METHODS, 'selectFrom']);
/** Methods that may only be called directly in agent code. */
const DIRECT_ONLY = new Set([...WRITE_METHODS, ...READ_METHODS, 'withSchema', 'namespace']);
const CTE_METHODS = new Set(['with', 'withRecursive', 'withMaterialized', 'withNotMaterialized']);
const DB_HANDLE_NAMES = new Set([
  'q',
  'db',
  'tx',
  'trx',
  'client',
  'pool',
  'conn',
  'connection',
  'executor',
  'database',
  'kysely',
]);
const DB_HANDLE_SUFFIX = /[a-z0-9](?:Db|Tx|Trx|Client|Pool|Conn|Connection|Executor)$/u;
/** Stands for a template substitution whose SQL text is unknown. */
const OPAQUE = '\u0001';
/** Words before UPDATE that make it a clause, not a statement. */
const NOT_A_STATEMENT = new Set(['for', 'key', 'do', 'on', 'of', 'or', 'before', 'after']);
/** Functions whose argument syntax uses FROM. */
const FROM_FUNCTIONS = new Set(['extract', 'substring', 'substr', 'trim', 'overlay', 'position']);
/** Words that end a FROM item instead of aliasing it. */
const NOT_AN_ALIAS = new Set([
  'where',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'natural',
  'on',
  'using',
  'group',
  'order',
  'limit',
  'offset',
  'for',
  'union',
  'intersect',
  'except',
  'having',
  'window',
  'returning',
  'set',
  'lateral',
  'fetch',
  'into',
  'values',
  'select',
  'from',
  'and',
  'or',
  'when',
  'then',
  'else',
  'end',
  'tablesample',
  'with',
]);

function literal(node: ts.Node | undefined): string | null {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function methodName(callee: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isElementAccessExpression(callee)) return literal(callee.argumentExpression);
  return null;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let out = expr;
  while (ts.isParenthesizedExpression(out) || ts.isNonNullExpression(out)) out = out.expression;
  return out;
}

/** The last name of a receiver: db, deps.db, this.db → db. */
function receiverName(expr: ts.Expression): string | null {
  const inner = unwrap(expr);
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
  return null;
}

export function isDbHandleName(name: string | null): boolean {
  return name !== null && (DB_HANDLE_NAMES.has(name.toLowerCase()) || DB_HANDLE_SUFFIX.test(name));
}

function isDirectCallee(node: ts.Node): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

/** Local names bound to sql (any import of `sql`, plus the bare name) and kysely namespaces. */
interface SqlNames {
  readonly sql: Set<string>;
  readonly namespaces: Set<string>;
}

function sqlNames(source: ts.SourceFile): SqlNames {
  const sql = new Set(['sql']);
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    const bindings = statement.importClause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      if (literal(statement.moduleSpecifier) === 'kysely') namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'sql') sql.add(element.name.text);
    }
  }
  return { sql, namespaces };
}

/** `sql` itself: a sql local or k.sql for a kysely namespace import. */
function isSqlExpr(expr: ts.Expression, names: SqlNames): boolean {
  const inner = unwrap(expr);
  if (ts.isIdentifier(inner)) return names.sql.has(inner.text);
  return (
    ts.isPropertyAccessExpression(inner) &&
    inner.name.text === 'sql' &&
    ts.isIdentifier(inner.expression) &&
    names.namespaces.has(inner.expression.text)
  );
}

/** `sql.<name>(…)`. */
function sqlHelper(
  node: ts.Node,
  names: SqlNames,
): { name: string; call: ts.CallExpression } | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee) && isSqlExpr(callee.expression, names)) {
    return { name: callee.name.text, call: node };
  }
  return null;
}

function isSqlTag(node: ts.Node, names: SqlNames): node is ts.TaggedTemplateExpression {
  return ts.isTaggedTemplateExpression(node) && isSqlExpr(node.tag, names);
}

/** Quote each dotted part as Kysely's sql.table / sql.id would. */
function quoted(parts: readonly string[]): string {
  return parts.map((part) => `"${part}"`).join('.');
}

/** The SQL text a substitution contributes, or the opaque marker. */
function substitution(expr: ts.Expression, names: SqlNames): string {
  const helper = sqlHelper(expr, names);
  if (helper === null) return ` ${OPAQUE} `;
  const args = helper.call.arguments.map((arg) => literal(arg));
  if (args.length === 0 || args.some((arg) => arg === null)) return ` ${OPAQUE} `;
  const texts = args as string[];
  if (helper.name === 'table') return quoted(texts.join('.').split('.'));
  if (helper.name === 'id') return quoted(texts);
  if (helper.name === 'raw') return texts.join('');
  return ` ${OPAQUE} `;
}

/** Template text with each substitution replaced by what it contributes. */
function templateText(template: ts.TemplateLiteral, names: SqlNames): string {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
  let text = template.head.text;
  for (const span of template.templateSpans) {
    text += substitution(span.expression, names) + span.literal.text;
  }
  return text;
}

const WORD_CHAR = /[A-Za-z0-9_$]/u;
const DOLLAR_QUOTE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u;

/**
 * SQL with -- and block comments and '…' / E'…' strings blanked; "quoted identifiers" kept; the
 * body of a $tag$ quote is stripped on its own and kept (so it is scanned as SQL).
 */
function stripSql(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === '--') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      out += ' ';
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      out += ' ';
    } else if (text[i] === "'") {
      const escapes = /[eE]/u.test(text[i - 1] ?? '') && !WORD_CHAR.test(text[i - 2] ?? '');
      i += 1;
      while (i < text.length) {
        if (escapes && text[i] === '\\') i += 2;
        else if (text[i] === "'" && text[i + 1] === "'") i += 2;
        else if (text[i] === "'") break;
        else i += 1;
      }
      i += 1;
      out += ' ';
    } else if (text[i] === '"') {
      const end = text.indexOf('"', i + 1);
      const stop = end === -1 ? text.length : end + 1;
      out += text.slice(i, stop);
      i = stop;
    } else if (text[i] === '$' && !WORD_CHAR.test(text[i - 1] ?? '')) {
      const tag = DOLLAR_QUOTE.exec(text.slice(i));
      if (tag === null) {
        out += '$';
        i += 1;
        continue;
      }
      const start = i + tag[0].length;
      const end = text.indexOf(tag[0], start);
      out += ` ${stripSql(text.slice(start, end === -1 ? text.length : end))} `;
      i = end === -1 ? text.length : end + tag[0].length;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

const IDENT = String.raw`(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_$]*|${OPAQUE})`;
const NAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;
const KEYWORDS = new RegExp(
  String.raw`\b(insert\s+into|update|delete\s+from|merge\s+into|truncate|into|from|join|using|alter|drop|create|grant|revoke|copy|lock|call|set_config)\b`,
  'giu',
);
const WRITES = new Set(['insert into', 'update', 'delete from', 'merge into', 'truncate', 'into']);
const READS = new Set(['from', 'join', 'using']);
const SET_ROLE = /(?:^|;)\s*set\s+(?:local\s+|session\s+)?(role|session\s+authorization)\b/giu;
const CTE = new RegExp(
  String.raw`(?:\bwith(?:\s+recursive)?|,)\s*(${IDENT})\s*(?:\([^()]*\)\s*)?as\s+(?:not\s+)?(?:materialized\s+)?\(`,
  'giu',
);

export interface SqlAccess {
  /** 'update', 'from', 'select into', 'drop', … (lower case). */
  readonly statement: string;
  readonly kind: 'write' | 'read' | 'forbidden';
  /** Normalised table (schema.table, unquoted), or null when it is opaque or missing. */
  readonly target: string | null;
  readonly ok: boolean;
}

function normalise(name: string): string | null {
  if (name.includes(OPAQUE)) return null;
  return name
    .split('.')
    .map((part) => part.trim())
    .map((part) => (part.startsWith('"') ? part.slice(1, -1) : part.toLowerCase()))
    .join('.');
}

function agentTarget(target: string | null): boolean {
  if (target === null) return false;
  const parts = target.split('.');
  if (parts.length === 1) return AGENT_TABLE.test(parts[0] ?? '');
  return parts.length === 2 && parts[0] === 'app' && AGENT_TABLE.test(parts[1] ?? '');
}

function wordBefore(text: string, index: number): string {
  return (/([A-Za-z_]+)\s*$/u.exec(text.slice(0, index))?.[1] ?? '').toLowerCase();
}

/** Index just past the parenthesised group opening at `open`. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** The word before the innermost unclosed ( preceding `index`, or ''. */
function enclosingCall(text: string, index: number): string {
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (text[i] === ')') depth += 1;
    else if (text[i] === '(') {
      if (depth === 0) return wordBefore(text, i);
      depth -= 1;
    }
  }
  return '';
}

/** The tables named by the FROM / JOIN / USING item(s) starting at `from`. */
function readItems(text: string, from: number, list: boolean, keyword: string): (string | null)[] {
  const out: (string | null)[] = [];
  let i = from;
  const skipSpace = (): void => {
    while (i < text.length && /\s/u.test(text[i] ?? '')) i += 1;
  };
  for (;;) {
    skipSpace();
    for (let m = /^(?:only|lateral)\b/iu.exec(text.slice(i)); m !== null;) {
      i += m[0].length;
      skipSpace();
      m = /^(?:only|lateral)\b/iu.exec(text.slice(i));
    }
    if (text[i] === '(') {
      i = closeParen(text, i);
    } else {
      const head = new RegExp(String.raw`^${NAME}`, 'u').exec(text.slice(i));
      if (head === null) {
        // USING followed by an operator (ORDER BY x USING <) names no table.
        if (keyword !== 'using' || /^[A-Za-z_"]/u.test(text.slice(i))) out.push(null);
        return out;
      }
      i += head[0].length;
      skipSpace();
      if (text[i] === '(') {
        if (head[0].includes(OPAQUE)) out.push(null);
        i = closeParen(text, i);
      } else {
        out.push(normalise(head[0]));
      }
    }
    skipSpace();
    const alias = /^(?:as\s+)?([A-Za-z_][A-Za-z0-9_$]*|"[^"]*")/iu.exec(text.slice(i));
    if (alias !== null && !NOT_AN_ALIAS.has((alias[1] ?? '').toLowerCase())) {
      i += alias[0].length;
      skipSpace();
      if (text[i] === '(') i = closeParen(text, i);
      skipSpace();
    }
    if (!list || text[i] !== ',') return out;
    i += 1;
  }
}

/** Every table a piece of SQL writes or reads, and every forbidden statement in it. */
export function sqlAccesses(sqlText: string): SqlAccess[] {
  const text = stripSql(sqlText);
  const ctes = new Set<string>();
  if (/\bwith\b/iu.test(text)) {
    for (const match of text.matchAll(CTE)) {
      const name = normalise(match[1] ?? '');
      if (name !== null) ctes.add(name);
    }
  }
  const out: SqlAccess[] = [];
  for (const match of text.matchAll(SET_ROLE)) {
    const statement = `set ${(match[1] ?? '').toLowerCase().replace(/\s+/gu, ' ')}`;
    out.push({ statement, kind: 'forbidden', target: null, ok: false });
  }
  for (const match of text.matchAll(KEYWORDS)) {
    const keyword = (match[1] ?? '').toLowerCase().replace(/\s+/gu, ' ');
    const start = match.index;
    const rest = start + match[0].length;
    // A column name: "update", a.update ("x".update); set_config stays a call even when qualified.
    const quotedName = text[start - 1] === '"' && text[rest] === '"';
    const dotted = /(?:(?:^|[^A-Za-z0-9_$])[A-Za-z_][A-Za-z0-9_$]*|")\.$/u.test(
      text.slice(0, start),
    );
    if (quotedName || (dotted && keyword !== 'set_config')) continue;
    if (WRITES.has(keyword)) {
      if (keyword === 'update' && NOT_A_STATEMENT.has(wordBefore(text, start))) continue;
      const statement = keyword === 'into' ? 'select into' : keyword;
      const prefix =
        keyword === 'truncate' ? String.raw`(?:table\s+)?(?:only\s+)?` : String.raw`(?:only\s+)?`;
      const list = keyword === 'truncate' ? String.raw`(?:\s*,\s*${NAME})*` : '';
      const head = new RegExp(String.raw`^\s+${prefix}(${NAME}${list})`, 'iu').exec(
        text.slice(rest),
      );
      const names = head === null ? [null] : (head[1] ?? '').split(',').map(normalise);
      for (const target of names) {
        out.push({ statement, kind: 'write', target, ok: agentTarget(target) });
      }
    } else if (READS.has(keyword)) {
      if (keyword === 'from') {
        if (wordBefore(text, start) === 'distinct') continue;
        if (FROM_FUNCTIONS.has(enclosingCall(text, start))) continue;
      }
      for (const target of readItems(text, rest, keyword === 'from', keyword)) {
        const ok = agentTarget(target) || (target !== null && ctes.has(target));
        out.push({ statement: keyword, kind: 'read', target, ok });
      }
    } else {
      out.push({ statement: keyword, kind: 'forbidden', target: null, ok: false });
    }
  }
  return out;
}

export type Kind = '①' | '②' | '③' | '⑤';

export interface AgentScan {
  /** `<kind> <path>:<line> <what>` for every violation. */
  readonly violations: string[];
  /** Kysely write tables seen (literal arguments). */
  readonly tables: string[];
  /** Kysely read tables seen (literal arguments). */
  readonly readTables: string[];
  /** Raw SQL write targets seen (null for opaque). */
  readonly sqlTargets: (string | null)[];
  /** Raw SQL read tables seen (null for opaque); subqueries and functions are not listed. */
  readonly sqlReads: (string | null)[];
  /** Literal namespaces seen. */
  readonly namespaces: string[];
  /** .query calls whose receiver was judged a database handle. */
  readonly dbQueries: number;
  /** Direct calls of table methods / withSchema / namespace (what ⑤ lets through). */
  readonly directCalls: number;
}

function parse(file: SourceFile): {
  source: ts.SourceFile;
  where: (node: ts.Node) => string;
} {
  const source = ts.createSourceFile(
    file.path,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const where = (node: ts.Node): string => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${relative(ROOT, file.path)}:${String(line + 1)}`;
  };
  return { source, where };
}

/** Names that .with / .withRecursive('name', …) define in a file. */
function kyselyCtes(source: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && CTE_METHODS.has(methodName(node.expression) ?? '')) {
      const name = literal(node.arguments[0]);
      if (name !== null) out.add((name.split('(')[0] ?? '').trim());
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Whether the receiver chain of `callee` contains a Kysely builder root call. */
function inBuilderChain(callee: ts.Expression): boolean {
  let up: ts.Expression = callee;
  for (;;) {
    up = unwrap(up);
    if (ts.isPropertyAccessExpression(up) || ts.isElementAccessExpression(up)) {
      up = up.expression;
    } else if (ts.isCallExpression(up)) {
      if (BUILDER_ROOTS.has(methodName(up.expression) ?? '')) return true;
      up = up.expression;
    } else {
      return false;
    }
  }
}

/** The identifier is a reference (not a property name, import name, declaration name, …). */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) return false;
  if (ts.isNamespaceImport(parent)) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  return true;
}

/** ①–③ and ⑤ over agent sources. */
export function scanAgent(files: readonly SourceFile[]): AgentScan {
  const violations: string[] = [];
  const tables: string[] = [];
  const readTables: string[] = [];
  const sqlTargets: (string | null)[] = [];
  const sqlReads: (string | null)[] = [];
  const namespaces: string[] = [];
  let dbQueries = 0;
  let directCalls = 0;
  for (const file of files) {
    const { source, where } = parse(file);
    const names = sqlNames(source);
    const ctes = kyselyCtes(source);
    const report = (kind: Kind, node: ts.Node, what: string): void => {
      violations.push(`${kind} ${where(node)} ${what}`);
    };
    const checkSql = (node: ts.Node, text: string): void => {
      for (const access of sqlAccesses(text)) {
        if (access.kind === 'write') sqlTargets.push(access.target);
        if (access.kind === 'read') sqlReads.push(access.target);
        if (!access.ok) {
          const what =
            access.kind === 'forbidden' ? '(forbidden)' : (access.target ?? '<non-literal>');
          report('②', node, `${access.statement.toUpperCase()} ${what}`);
        }
      }
    };
    const checkTable = (
      node: ts.Node,
      arg: ts.Expression | undefined,
      method: string,
      read: boolean,
    ): void => {
      if (arg !== undefined && ts.isArrayLiteralExpression(arg)) {
        for (const element of arg.elements) checkTable(node, element, method, read);
        return;
      }
      if (read && arg !== undefined) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return;
        if (ts.isCallExpression(arg) && methodName(arg.expression) === 'as') return;
      }
      const name = literal(arg);
      if (name === null) {
        report('①', node, `${method}(<non-literal>)`);
        return;
      }
      (read ? readTables : tables).push(name);
      const cte = read ? KYSELY_NAME.exec(name) : null;
      if (KYSELY_TABLE.test(name) || (cte !== null && ctes.has(cte[1] ?? ''))) return;
      report('①', node, `${method}('${name}')`);
    };
    const visit = (node: ts.Node): void => {
      if (isSqlTag(node, names)) {
        checkSql(node, templateText(node.template, names));
      } else if (ts.isCallExpression(node)) {
        const helper = sqlHelper(node, names);
        const method = methodName(node.expression);
        const arg = node.arguments[0];
        if (helper !== null && helper.name === 'raw') {
          // A literal sql.raw inside a sql`…` substitution is read as part of that template.
          const parent = node.parent;
          const inTemplate = ts.isTemplateSpan(parent) && isSqlTag(parent.parent.parent, names);
          const text = literal(arg);
          if (text === null) report('②', node, 'sql.raw(<non-literal>)');
          else if (!inTemplate) checkSql(node, text);
        } else if (helper !== null) {
          // sql.lit / sql.val / sql.ref / sql.table / sql.id / sql.join: not statement text.
        } else if (method !== null && WRITE_METHODS.has(method)) {
          checkTable(node, arg, method, false);
        } else if (method !== null && READ_METHODS.has(method)) {
          checkTable(node, arg, method, true);
        } else if ((method === 'from' || method === 'using') && inBuilderChain(node.expression)) {
          checkTable(node, arg, method, true);
        } else if (method === 'withSchema') {
          if (literal(arg) !== 'app') report('①', node, 'withSchema other than the literal app');
        } else if (method === 'namespace') {
          const name = literal(arg);
          if (name !== null) namespaces.push(name);
          if (name === null || !AGENT_NAMESPACE.test(name)) {
            report('③', node, `namespace(${name === null ? '<non-literal>' : `'${name}'`})`);
          }
        } else if (
          method === 'query' &&
          ts.isPropertyAccessExpression(node.expression) &&
          isDbHandleName(receiverName(node.expression.expression))
        ) {
          dbQueries += 1;
          const text = literal(arg);
          if (text !== null) checkSql(node, text);
          else if (arg !== undefined && ts.isTemplateExpression(arg)) {
            checkSql(node, templateText(arg, names));
          } else if (arg === undefined || !(isSqlTag(arg, names) || sqlHelper(arg, names))) {
            report('②', node, '.query(<not a sql tag or literal>)');
          }
        }
      }
      checkBypass(node);
      ts.forEachChild(node, visit);
    };
    const checkBypass = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        if (node.text === 'executeQuery' || node.text === 'CompiledQuery') {
          report('⑤', node, node.text);
        } else if (
          names.sql.has(node.text) &&
          isReference(node) &&
          !(ts.isTaggedTemplateExpression(node.parent) && node.parent.tag === node) &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
        ) {
          report('⑤', node, `${node.text} used other than as a tag or ${node.text}.x`);
        }
      } else if (ts.isPropertyAccessExpression(node)) {
        const name = node.name.text;
        const parent = node.parent;
        if (
          name === 'schema' &&
          (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
          parent.expression === node
        ) {
          report('⑤', node, '.schema.…');
        } else if (DIRECT_ONLY.has(name)) {
          if (isDirectCallee(node)) directCalls += 1;
          else report('⑤', node, `.${name} not called directly`);
        }
      } else if (ts.isElementAccessExpression(node)) {
        const key = literal(node.argumentExpression);
        if (key !== null) {
          if (DIRECT_ONLY.has(key) && !isDirectCallee(node)) {
            report('⑤', node, `['${key}'] not called directly`);
          }
        } else {
          const receiver = receiverName(node.expression);
          if (isDbHandleName(receiver) || /redis/iu.test(receiver ?? '')) {
            report('⑤', node, `${receiver ?? ''}[<non-literal>]`);
          }
        }
      } else if (ts.isBindingElement(node)) {
        const key = node.propertyName ?? node.name;
        const text = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
        if (text !== null && (DIRECT_ONLY.has(text) || text === 'schema')) {
          report('⑤', node, `destructured ${text}`);
        }
      }
    };
    visit(source);
  }
  return {
    violations,
    tables,
    readTables,
    sqlTargets,
    sqlReads,
    namespaces,
    dbQueries,
    directCalls,
  };
}

/** Resolve a module specifier relative to `from` to a TypeScript file, or null. */
function resolveModule(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = join(dirname(from), specifier);
  for (const path of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

/** The string value of exported const `name` of the module at `path`, through re-exports. */
function exportedString(path: string, name: string, depth: number): string | null {
  if (depth > 8) return null;
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const local = topLevelConsts(source);
  for (const statement of source.statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
    ) {
      const value = local.get(name);
      if (value !== undefined && value !== null) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return value;
        }
      }
    } else if (ts.isExportDeclaration(statement)) {
      const target =
        statement.moduleSpecifier === undefined
          ? null
          : resolveModule(path, literal(statement.moduleSpecifier) ?? '');
      const clause = statement.exportClause;
      if (clause === undefined) {
        const value = target === null ? null : exportedString(target, name, depth + 1);
        if (value !== null) return value;
      } else if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (element.name.text !== name) continue;
          const original = (element.propertyName ?? element.name).text;
          if (target !== null) return exportedString(target, original, depth + 1);
          return local.get(original) ?? null;
        }
      }
    }
  }
  return null;
}

/** Top-level `const X = '…'` of a file; a name declared twice or without a literal maps to null. */
function topLevelConsts(source: ts.SourceFile): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = declaration.name.text;
      out.set(name, out.has(name) || !isConst ? null : literal(declaration.initializer));
    }
  }
  return out;
}

export interface AppModuleScan {
  readonly violations: string[];
  /** Every namespace value resolved from a .namespace call. */
  readonly namespaces: string[];
}

/** ④ over app.module.ts; `others` lists the non-agent namespaces app.module may assemble. */
export function scanAppModule(file: SourceFile, others: readonly string[]): AppModuleScan {
  const { source, where } = parse(file);
  const violations: string[] = [];
  const namespaces: string[] = [];
  const consts = topLevelConsts(source);
  // Names declared anywhere below the top level shadow nothing we trust: count them as unresolved.
  const nested = new Set<string>();
  const imports = new Map<string, { module: string; name: string }>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      imports.set(element.name.text, {
        module: literal(statement.moduleSpecifier) ?? '',
        name: (element.propertyName ?? element.name).text,
      });
    }
  }
  const collect = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name) &&
      !(ts.isVariableDeclaration(node) && ts.isSourceFile(node.parent.parent.parent))
    ) {
      nested.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const resolve = (arg: ts.Expression | undefined): string | null => {
    const text = literal(arg);
    if (text !== null || arg === undefined || !ts.isIdentifier(arg)) return text;
    if (nested.has(arg.text)) return null;
    const local = consts.get(arg.text);
    if (local !== undefined) return local;
    const imported = imports.get(arg.text);
    if (imported === undefined) return null;
    const path = resolveModule(file.path, imported.module);
    return path === null ? null : exportedString(path, imported.name, 0);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && methodName(node.expression) === 'namespace') {
      const value = resolve(node.arguments[0]);
      if (value !== null) namespaces.push(value);
      if (value === null || !(AGENT_NAMESPACE.test(value) || others.includes(value))) {
        violations.push(
          `④ ${where(node)} namespace(${value === null ? '<unresolved>' : `'${value}'`})`,
        );
      }
    } else if (
      (ts.isPropertyAccessExpression(node) && node.name.text === 'namespace') ||
      (ts.isElementAccessExpression(node) && literal(node.argumentExpression) === 'namespace') ||
      (ts.isBindingElement(node) &&
        ts.isIdentifier(node.propertyName ?? node.name) &&
        (node.propertyName ?? node.name).getText(source) === 'namespace')
    ) {
      if (!isDirectCallee(node)) violations.push(`④ ${where(node)} namespace not called directly`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { violations, namespaces };
}
