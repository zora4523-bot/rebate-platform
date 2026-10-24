// CT-06zt static helpers (no database, no Nest): BR-AI-02 ③ dependency relays that the module
// dependency check (dependency-cruiser, CT-06zq) cannot see, scanned over the TypeScript AST of
// apps/api/src/modules/** (test files and dist excluded).
//
// Whitelist (the same as CT-06zq's depcruise rule; this file does not read that rule file): agent
// may depend on the index.ts of parsing, catalog, linking, orders, content, taolijin, identity,
// platform and union (linking, orders, identity and union for types only), plus ledger/read.ts and
// payout/read.ts.
//
// ① Relay through a non-index file (relayViolations). 判定口径: in any file of the nine
//    whitelisted modules (index.ts included; *.test.ts excluded), a value binding imported from
//    ANOTHER module under apps/api/src/modules/ (default, namespace or non-type named import,
//    `import x = require()`, dynamic `import()` / `require()` of that module) is "tainted". So is
//    any variable or function of the same file whose value hands a tainted binding on (relays()):
//    the binding itself, a member of it, `.bind()` of it, an object / array literal (spread and
//    shorthand included) or `Object.freeze` / `Object.assign` holding it, a branch of `?:` / `??` /
//    `||` / `&&`, a destructured part of it, a function (arrow, expression, declaration, object
//    method or getter) that returns any of these. Names are tracked file-wide without scopes
//    (conservative: a shadowing local of the same name also counts). The file violates when a
//    tainted name or expression is exported in its own name: `export { x }`, `export { x as y }`,
//    `export const y = x`, `export default x`, `export function f() { return x; }`,
//    `export import y = ns.x`; and any non-type `export … from '<another module>'` (`export *`,
//    `export * as`, `export { x }`). Not a relay, allowed: calling the binding
//    (`export const r = x()`, `new X()`, a wrapper that calls it), type positions, and classes
//    (extending another module's class or its members using it: Nest dynamic module classes hand
//    platform tokens to providers, error classes extend platform's RequestRejection; the
//    module's own API). Imports from outside modules/ (packages, node:, apps/api/src/common…)
//    are not another module here; non-module relays are CT-06zq's. A relay is reported where it
//    is written, whether or not index.ts re-exports the file.
//
// ② Mixed default + inline type import (mixedImportViolations). dependency-cruiser takes
//    `import Def, { type T } from '…'` for a type-only dependency and lets the value Def through.
//    Targets: linking, orders, identity, union (types only for agent) and every module outside the
//    whitelist (ledger and payout except their read.ts, growth, commission, settlement, risk, …).
//    - In agent/**: any non-`import type` declaration toward such a target that binds a default,
//      a namespace or a non-type named import, or has no bindings at all (side-effect import), and
//      any non-type `export … from` such a target, is a violation.
//    - In the nine whitelisted modules (which may value-import other modules): a declaration toward
//      such a target that binds a default import together with inline `type` named imports is a
//      violation (the mis-judged form); value relays themselves are ①'s.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const MODULES = join(ROOT, 'apps/api/src/modules');

/** The nine modules agent may import from (BR-AI-02 ③ / CT-06zq). */
export const RELAY_MODULES = [
  'parsing',
  'catalog',
  'linking',
  'orders',
  'content',
  'taolijin',
  'identity',
  'platform',
  'union',
] as const;

/** Whitelisted modules agent may name for types only. */
export const TYPE_ONLY_MODULES = ['linking', 'orders', 'identity', 'union'] as const;

/** Whitelisted modules agent may value-import (through their index.ts). */
const VALUE_MODULES: readonly string[] = ['parsing', 'catalog', 'content', 'taolijin', 'platform'];

/** The two read-only entry files agent may value-import (BR-AI-02 ③④). */
const READ_ENTRIES: readonly string[] = ['ledger/read.ts', 'payout/read.ts'];

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function isTestFile(path: string): boolean {
  return path.endsWith('.test.ts');
}

/** Every .ts file under `dir`, recursively and sorted, skipping dist and node_modules. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'dist' && name !== 'node_modules') out.push(...tsFilesUnder(path));
    } else if (name.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** apps/api/src/modules/** production sources (test files and dist excluded). */
export function moduleSources(): SourceFile[] {
  return tsFilesUnder(MODULES)
    .filter((path) => !isTestFile(path))
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }));
}

/** The module directory `file` belongs to, or null outside apps/api/src/modules/<module>/. */
export function moduleOf(file: string): string | null {
  const parts = relative(MODULES, file).split(sep);
  const head = parts[0];
  if (head === undefined || head === '..' || head === '' || parts.length < 2) return null;
  return head;
}

interface Target {
  readonly module: string;
  /** Path inside the module, `/`-separated (`index.ts`, `application/x.ts`). */
  readonly rest: string;
}

/** Where a relative specifier of `file` lands under modules/, or null. */
function targetOf(file: string, specifier: string): Target | null {
  if (!specifier.startsWith('.')) return null;
  const parts = relative(MODULES, resolve(dirname(file), specifier)).split(sep);
  const head = parts[0];
  if (head === undefined || head === '..' || head === '' || parts.length < 2) return null;
  return { module: head, rest: parts.slice(1).join('/') };
}

function literal(node: ts.Node | undefined): string | null {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function parse(file: SourceFile): ts.SourceFile {
  return ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function locator(file: SourceFile, source: ts.SourceFile): (node: ts.Node) => string {
  return (node) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${relative(ROOT, file.path).split(sep).join('/')}:${String(line + 1)}`;
  };
}

/** Local names an import clause binds as values (default, namespace, non-type named). */
function valueBindings(clause: ts.ImportClause): string[] {
  if (clause.isTypeOnly) return [];
  const out: string[] = [];
  if (clause.name !== undefined) out.push(clause.name.text);
  const bindings = clause.namedBindings;
  if (bindings !== undefined) {
    if (ts.isNamespaceImport(bindings)) out.push(bindings.name.text);
    else for (const e of bindings.elements) if (!e.isTypeOnly) out.push(e.name.text);
  }
  return out;
}

/** A non-type `export … from`: `export *`, `export * as ns`, or a non-type named element. */
function reexportsValue(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly) return false;
  const clause = statement.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) return true;
  return clause.elements.some((e) => !e.isTypeOnly);
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) out.push(...bindingNames(element.name));
  }
  return out;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function leftmost(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : leftmost(name.left);
}

/** ① for one file of a whitelisted module; `own` is its module. */
function relaysOfFile(file: SourceFile, own: string): string[] {
  const source = parse(file);
  const where = locator(file, source);
  const out: string[] = [];
  const foreign = (specifier: string | null): boolean => {
    if (specifier === null) return false;
    const target = targetOf(file.path, specifier);
    return target !== null && target.module !== own;
  };
  const tainted = new Set<string>();

  const returnsRelay = (fn: ts.FunctionLikeDeclaration): boolean => {
    const body = fn.body;
    if (body === undefined) return false;
    if (!ts.isBlock(body)) return relays(body);
    let found = false;
    const walk = (node: ts.Node): void => {
      if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression !== undefined && relays(node.expression)) {
        found = true;
        return;
      }
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(body, walk);
    return found;
  };

  const callRelays = (node: ts.CallExpression): boolean => {
    const callee = node.expression;
    if (
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === 'require')
    ) {
      return foreign(literal(node.arguments[0]));
    }
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const name = callee.name.text;
    if (name === 'bind') return relays(callee.expression);
    return (
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'Object' &&
      (name === 'freeze' || name === 'assign') &&
      node.arguments.some((a) => relays(a))
    );
  };

  /** Whether the value of `node` hands a tainted binding on (口径 in the header). */
  const relays = (node: ts.Expression): boolean => {
    const e = unwrap(node);
    if (ts.isIdentifier(e)) return tainted.has(e.text);
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      return relays(e.expression);
    }
    if (ts.isObjectLiteralExpression(e)) {
      return e.properties.some((p) => {
        if (ts.isPropertyAssignment(p)) return relays(p.initializer);
        if (ts.isShorthandPropertyAssignment(p)) return tainted.has(p.name.text);
        if (ts.isSpreadAssignment(p)) return relays(p.expression);
        return returnsRelay(p);
      });
    }
    if (ts.isArrayLiteralExpression(e)) {
      return e.elements.some((el) => relays(ts.isSpreadElement(el) ? el.expression : el));
    }
    if (ts.isConditionalExpression(e)) return relays(e.whenTrue) || relays(e.whenFalse);
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return relays(e.left) || relays(e.right);
      }
      return (
        (op === ts.SyntaxKind.CommaToken || op === ts.SyntaxKind.EqualsToken) && relays(e.right)
      );
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return returnsRelay(e);
    if (ts.isCallExpression(e)) return callRelays(e);
    return false;
  };

  // Imports from another module: seed the tainted names; `export … from` it: a relay at once.
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause !== undefined && foreign(literal(statement.moduleSpecifier))) {
        for (const name of valueBindings(clause)) tainted.add(name);
      }
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      foreign(literal(statement.moduleReference.expression))
    ) {
      tainted.add(statement.name.text);
    } else if (
      ts.isExportDeclaration(statement) &&
      foreign(literal(statement.moduleSpecifier)) &&
      reexportsValue(statement)
    ) {
      out.push(`${where(statement)} re-exports values of another module`);
    }
  }

  // Locals that hand a tainted binding on, file-wide and without scopes, to a fixed point.
  const declarations: (ts.VariableDeclaration | ts.FunctionDeclaration)[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, collect);
  };
  collect(source);
  for (let changed = true; changed;) {
    changed = false;
    for (const node of declarations) {
      let names: string[] = [];
      if (ts.isVariableDeclaration(node)) {
        if (node.initializer !== undefined && relays(node.initializer)) {
          names = bindingNames(node.name);
        }
      } else if (node.name !== undefined && returnsRelay(node)) {
        names = [node.name.text];
      }
      for (const name of names) {
        if (!tainted.has(name)) {
          tainted.add(name);
          changed = true;
        }
      }
    }
  }

  // What the file exports in its own name.
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (
        statement.moduleSpecifier === undefined &&
        !statement.isTypeOnly &&
        clause !== undefined &&
        ts.isNamedExports(clause)
      ) {
        for (const e of clause.elements) {
          const local = (e.propertyName ?? e.name).text;
          if (!e.isTypeOnly && tainted.has(local)) {
            out.push(`${where(e)} exports ${local}, a value of another module`);
          }
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      if (relays(statement.expression)) {
        out.push(`${where(statement)} export default / export = hands on another module's value`);
      }
    } else if (!isExported(statement)) {
      continue;
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const names = bindingNames(declaration.name).filter((n) => tainted.has(n));
        if (names.length > 0) {
          out.push(`${where(declaration)} exports ${names.join(', ')}, a value of another module`);
        }
      }
    } else if (ts.isFunctionDeclaration(statement)) {
      if (returnsRelay(statement)) {
        out.push(`${where(statement)} exported function returns a value of another module`);
      }
    } else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly) {
      const reference = statement.moduleReference;
      const relayed = ts.isExternalModuleReference(reference)
        ? foreign(literal(reference.expression))
        : tainted.has(leftmost(reference));
      if (relayed) out.push(`${where(statement)} export import hands on another module`);
    }
  }
  return out;
}

/** ①: relays of another module's values by files of the nine whitelisted modules. */
export function relayViolations(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const own = moduleOf(file.path);
    if (own === null || isTestFile(file.path)) continue;
    if (!(RELAY_MODULES as readonly string[]).includes(own)) continue;
    out.push(...relaysOfFile(file, own));
  }
  return out;
}

/** Targets agent may name for types only: see ② in the header. */
function typeOnlyTarget(target: Target): boolean {
  if ((TYPE_ONLY_MODULES as readonly string[]).includes(target.module)) return true;
  if (VALUE_MODULES.includes(target.module)) return false;
  return !READ_ENTRIES.includes(`${target.module}/${target.rest}`);
}

/** ②: value bindings smuggled toward type-only targets (agent) or the mixed default form. */
export function mixedImportViolations(files: readonly SourceFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const own = moduleOf(file.path);
    if (own === null || isTestFile(file.path)) continue;
    const inAgent = own === 'agent';
    if (!inAgent && !(RELAY_MODULES as readonly string[]).includes(own)) continue;
    const source = parse(file);
    const where = locator(file, source);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = literal(statement.moduleSpecifier);
      if (specifier === null) continue;
      const target = targetOf(file.path, specifier);
      if (target === null || target.module === own || !typeOnlyTarget(target)) continue;
      if (ts.isExportDeclaration(statement)) {
        if (inAgent && reexportsValue(statement)) {
          out.push(`${where(statement)} re-exports values of ${specifier}`);
        }
        continue;
      }
      const clause = statement.importClause;
      if (clause === undefined) {
        if (inAgent) out.push(`${where(statement)} side-effect import of ${specifier}`);
        continue;
      }
      if (clause.isTypeOnly) continue;
      if (inAgent) {
        const values = valueBindings(clause);
        if (values.length > 0) {
          out.push(`${where(statement)} value import ${values.join(', ')} from ${specifier}`);
        }
        continue;
      }
      const bindings = clause.namedBindings;
      const inlineType =
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some((e) => e.isTypeOnly);
      if (clause.name !== undefined && inlineType) {
        out.push(
          `${where(statement)} default import ${clause.name.text} mixed with inline type imports from ${specifier}`,
        );
      }
    }
  }
  return out;
}
