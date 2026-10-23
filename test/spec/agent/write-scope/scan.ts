// CT-06zu static helpers (no database, no Redis, no Nest): BR-AI-02 ③ lets agent use platform's
// infrastructure (database connection, Redis) on the condition that it reads and writes only the
// Agent's own tables and keys (D10-287, D10-288 Q1). depcruise judges files, not table names or
// key namespaces, so this scans the TypeScript AST of apps/api/src/modules/agent/** (test files and
// dist excluded) and of apps/api/src/app.module.ts.
//
// 口径（台账 ①–④）:
//  ① Kysely insertInto / updateTable / deleteFrom / mergeInto / replaceInto (by method name, any
//    receiver): every table argument is a string literal 'agent_x' / 'app.agent_x', optionally
//    'agent_x as a'; an array argument is checked element by element; anything else (variable,
//    template with substitutions, concatenation, no argument) is a violation. withSchema(arg) in
//    agent code must be the literal 'app' (so 'agent_x' after it means app.agent_x).
//  ② SQL text is read only from sql`…` tagged templates, from the literal argument of
//    sql.raw / sql.lit, and from a string or template literal passed as the first argument of
//    .query(…); comments, ordinary strings and SQL comments / SQL string literals are not SQL.
//    INSERT INTO / UPDATE / DELETE FROM / MERGE INTO / TRUNCATE (case-insensitive, across lines)
//    must target app.agent_x or a bare agent_x. UPDATE preceded by FOR / KEY / DO / ON / OF / OR /
//    BEFORE / AFTER is a lock or conflict clause (FOR [NO KEY] UPDATE, DO UPDATE SET …), not a
//    statement. A template substitution standing for the table: ${sql.table('…')},
//    ${sql.id('…'[, '…'])} and ${sql.raw('…')} with literal arguments contribute their text; any
//    other substitution is opaque, and an opaque or missing target is a violation. sql.raw with a
//    non-literal argument is itself a violation (its SQL cannot be read).
//  ③ .namespace(arg) (by method name, any receiver): arg is a string literal agent_[a-z0-9_-]+.
//  ④ app.module.ts (conservative, explainable form, since "handed to an agent port" is not
//    decidable from syntax alone): (a) every variable whose name contains both AGENT and
//    NAMESPACE is initialised with a literal agent_ namespace; (b) every .namespace(arg) call
//    that sits inside a declaration whose name contains "agent" (any case: function, method,
//    variable, property, class), or whose argument is an identifier containing AGENT, takes a
//    literal agent_ namespace or a const of this file initialised with one. Namespaces of other
//    modules assembled elsewhere in app.module (catalog-cache, …) are not the agent's and pass.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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
const WRITE_METHODS = new Set([
  'insertInto',
  'updateTable',
  'deleteFrom',
  'mergeInto',
  'replaceInto',
]);
/** Stands for a template substitution whose SQL text is unknown. */
const OPAQUE = '\u0001';
/** Words before UPDATE that make it a clause, not a statement. */
const NOT_A_STATEMENT = new Set(['for', 'key', 'do', 'on', 'of', 'or', 'before', 'after']);

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

/** `sql.<name>(…)` with `sql` a plain identifier. */
function sqlHelper(node: ts.Node): { name: string; call: ts.CallExpression } | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'sql'
  ) {
    return { name: callee.name.text, call: node };
  }
  return null;
}

function isSqlTag(node: ts.Node): node is ts.TaggedTemplateExpression {
  return (
    ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === 'sql'
  );
}

/** Quote each dotted part as Kysely's sql.table / sql.id would. */
function quoted(parts: readonly string[]): string {
  return parts.map((part) => `"${part}"`).join('.');
}

/** The SQL text a substitution contributes, or the opaque marker. */
function substitution(expr: ts.Expression): string {
  const helper = sqlHelper(expr);
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
function templateText(template: ts.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
  let text = template.head.text;
  for (const span of template.templateSpans) {
    text += substitution(span.expression) + span.literal.text;
  }
  return text;
}

/** SQL with -- and /* *\/ comments and '…' string literals blanked; "quoted identifiers" kept. */
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
      i += 1;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") i += 2;
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
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

const IDENT = String.raw`(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_$]*|${OPAQUE})`;
const NAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;
const WRITE = /\b(insert\s+into|update|delete\s+from|merge\s+into|truncate)\b/giu;

export interface SqlWrite {
  readonly statement: string;
  /** Normalised target (schema.table, unquoted), or null when it is opaque or missing. */
  readonly target: string | null;
}

function normalise(name: string): string | null {
  if (name.includes(OPAQUE)) return null;
  return name
    .split('.')
    .map((part) => part.trim())
    .map((part) => (part.startsWith('"') ? part.slice(1, -1) : part.toLowerCase()))
    .join('.');
}

/** The write statements in a piece of SQL and their target tables. */
export function sqlWrites(sqlText: string): SqlWrite[] {
  const text = stripSql(sqlText);
  const out: SqlWrite[] = [];
  for (const match of text.matchAll(WRITE)) {
    const keyword = (match[1] ?? '').toLowerCase().replace(/\s+/gu, ' ');
    const start = match.index;
    if (keyword === 'update') {
      const before = /([A-Za-z_]+)\s*$/u.exec(text.slice(0, start));
      if (before !== null && NOT_A_STATEMENT.has((before[1] ?? '').toLowerCase())) continue;
    }
    const rest = text.slice(start + match[0].length);
    const prefix = keyword === 'truncate' ? String.raw`(?:table\s+)?(?:only\s+)?` : '(?:only\\s+)?';
    const list = keyword === 'truncate' ? String.raw`(?:\s*,\s*${NAME})*` : '';
    const head = new RegExp(String.raw`^\s+${prefix}(${NAME}${list})`, 'iu').exec(rest);
    if (head === null) {
      out.push({ statement: keyword, target: null });
      continue;
    }
    const names = keyword === 'truncate' ? (head[1] ?? '').split(',') : [head[1] ?? ''];
    for (const name of names) out.push({ statement: keyword, target: normalise(name) });
  }
  return out;
}

function agentTarget(target: string | null): boolean {
  if (target === null) return false;
  const parts = target.split('.');
  if (parts.length === 1) return AGENT_TABLE.test(parts[0] ?? '');
  return parts.length === 2 && parts[0] === 'app' && AGENT_TABLE.test(parts[1] ?? '');
}

export type Kind = '①' | '②' | '③';

export interface AgentScan {
  /** `<kind> <path>:<line> <what>` for every violation. */
  readonly violations: string[];
  /** Kysely write tables seen (literal arguments). */
  readonly tables: string[];
  /** Raw SQL write targets seen (null for opaque). */
  readonly sqlTargets: (string | null)[];
  /** Literal namespaces seen. */
  readonly namespaces: string[];
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

/** ①–③ over agent sources. */
export function scanAgent(files: readonly SourceFile[]): AgentScan {
  const violations: string[] = [];
  const tables: string[] = [];
  const sqlTargets: (string | null)[] = [];
  const namespaces: string[] = [];
  for (const file of files) {
    const { source, where } = parse(file);
    const report = (kind: Kind, node: ts.Node, what: string): void => {
      violations.push(`${kind} ${where(node)} ${what}`);
    };
    const checkSql = (node: ts.Node, text: string): void => {
      for (const write of sqlWrites(text)) {
        sqlTargets.push(write.target);
        if (!agentTarget(write.target)) {
          report('②', node, `${write.statement.toUpperCase()} ${write.target ?? '<non-literal>'}`);
        }
      }
    };
    const checkTable = (node: ts.Node, arg: ts.Expression | undefined, method: string): void => {
      if (arg !== undefined && ts.isArrayLiteralExpression(arg)) {
        for (const element of arg.elements) checkTable(node, element, method);
        return;
      }
      const name = literal(arg);
      if (name === null) {
        report('①', node, `${method}(<non-literal>)`);
        return;
      }
      tables.push(name);
      if (!KYSELY_TABLE.test(name)) report('①', node, `${method}('${name}')`);
    };
    const visit = (node: ts.Node): void => {
      if (isSqlTag(node)) {
        checkSql(node, templateText(node.template));
      } else if (ts.isCallExpression(node)) {
        const helper = sqlHelper(node);
        const method = methodName(node.expression);
        const arg = node.arguments[0];
        if (helper !== null && (helper.name === 'raw' || helper.name === 'lit')) {
          // A literal sql.raw inside a sql`…` substitution is read as part of that template.
          const inTemplate = ts.isTemplateSpan(node.parent) && isSqlTag(node.parent.parent.parent);
          const text = literal(arg);
          if (arg !== undefined && ts.isTemplateExpression(arg)) checkSql(node, templateText(arg));
          else if (text !== null && !inTemplate) checkSql(node, text);
          else if (text === null && helper.name === 'raw') {
            report('②', node, 'sql.raw(<non-literal>)');
          }
        } else if (method !== null && WRITE_METHODS.has(method)) {
          checkTable(node, arg, method);
        } else if (method === 'withSchema') {
          if (literal(arg) !== 'app') report('①', node, 'withSchema other than the literal app');
        } else if (method === 'namespace') {
          const name = literal(arg);
          if (name !== null) namespaces.push(name);
          if (name === null || !AGENT_NAMESPACE.test(name)) {
            report('③', node, `namespace(${name === null ? '<non-literal>' : `'${name}'`})`);
          }
        } else if (method === 'query' && arg !== undefined) {
          const text = literal(arg);
          if (text !== null) checkSql(node, text);
          else if (ts.isTemplateExpression(arg)) checkSql(node, templateText(arg));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { violations, tables, sqlTargets, namespaces };
}

function declaredName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isPropertyDeclaration(node)) &&
    node.name !== undefined &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return node.name.text;
  }
  return null;
}

function inAgentScope(node: ts.Node): boolean {
  for (let up: ts.Node | undefined = node.parent; up !== undefined; up = up.parent) {
    const name = declaredName(up);
    if (name !== null && /agent/iu.test(name)) return true;
  }
  return false;
}

export interface AppModuleScan {
  readonly violations: string[];
  /** Namespaces judged to be the agent's (literal or resolved through a const). */
  readonly agentNamespaces: string[];
}

/** ④ over app.module.ts. */
export function scanAppModule(file: SourceFile): AppModuleScan {
  const { source, where } = parse(file);
  const violations: string[] = [];
  const agentNamespaces: string[] = [];
  const consts = new Map<string, string | null>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const list = node.parent;
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
      const name = node.name.text;
      const value = isConst ? literal(node.initializer) : null;
      consts.set(name, consts.has(name) ? null : value);
      if (/AGENT/u.test(name) && /NAMESPACE/u.test(name)) {
        if (value === null || !AGENT_NAMESPACE.test(value)) {
          violations.push(
            `④ ${where(node)} ${name} = ${value === null ? '<non-literal>' : `'${value}'`}`,
          );
        }
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && methodName(node.expression) === 'namespace') {
      const arg = node.arguments[0];
      const named = arg !== undefined && ts.isIdentifier(arg) ? arg.text : null;
      if (inAgentScope(node) || (named !== null && /AGENT/u.test(named))) {
        const value = named !== null ? (consts.get(named) ?? null) : literal(arg);
        if (value !== null && AGENT_NAMESPACE.test(value)) agentNamespaces.push(value);
        else {
          violations.push(
            `④ ${where(node)} agent namespace(${value === null ? '<non-literal>' : `'${value}'`})`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { violations, agentNamespaces };
}
