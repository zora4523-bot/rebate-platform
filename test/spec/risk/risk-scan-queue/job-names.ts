// Static scan of the job names apps/api/src hands to the queue (B1-03w; orchestrator 19:28).
//
// How: every non-test `.ts` file under the root (apps/api/src) is read as text and parsed with the
// TypeScript parser (ts.createSourceFile: no type checker, no module loading, nothing executed).
// Three kinds of sites are collected:
//   send      a call `<x>.send(queue, name, payload, options)` with four arguments whose last one
//             is an object literal with a `trx` property (the JobQueue.send shape; HTTP replies,
//             SMS and push ports have other shapes); the names are those of the second argument;
//   dispatch  `job.name === <x>` / `job.name !== <x>` (either side) and each `case <x>:` of
//             `switch (job.name)`: what a handler compares a received job's name with;
//   constant  a top-level `const` whose name has a JOB / JOBS word (`ORDER_QUERY_JOB`, `JOB_DUE`,
//             `JOB_NAMES`) holding a string literal or an array literal, and a top-level
//             `type …JobName` alias (the central definitions of job names).
// A name expression is resolved statically to every string it can be: string literals;
// `a ? b : c`; `as const` / `satisfies` / `!` / parentheses; an identifier bound in scope to a
// `const` with such an initializer (or with such a type annotation), a parameter annotated with a
// string-literal type, a union of them or an alias of one, `(typeof X)[number]`, a `for … of`
// variable over a const array (also `Object.freeze([...])`), or the first parameter of an
// unannotated callback of `<array>.map / forEach / flatMap / filter / some / every`. Named imports
// from relative modules are followed, re-exports (`export { X } from`, `export * from`) too.
// Not covered — such a site is reported with names null (unresolved), never as a violation:
// names built at run time (template literals with substitutions, concatenation, function results,
// property reads such as `route.name`), parameters typed plain `string` (e.g. the event bus's
// event name), `let` bindings, destructuring, imports from packages; and sends this shape test
// does not see: an options object not written inline at the call, a send through another method
// name, `.call` / `.apply`, or a queue method passed around as a function value.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import ts from 'typescript';

export type SiteKind = 'send' | 'dispatch' | 'constant';

export interface NameSite {
  /** Path relative to the scanned root, separated by `/`. */
  readonly file: string;
  readonly line: number;
  readonly kind: SiteKind;
  /** Every name the site can carry, or null when it is not statically resolvable. */
  readonly names: readonly string[] | null;
}

type Names = readonly string[] | null;

type Declaration =
  | { readonly kind: 'value'; readonly node: ts.VariableDeclaration; readonly file: ts.SourceFile }
  | { readonly kind: 'type'; readonly node: ts.TypeAliasDeclaration; readonly file: ts.SourceFile }
  | {
      readonly kind: 'parameter';
      readonly node: ts.ParameterDeclaration;
      readonly file: ts.SourceFile;
    }
  | { readonly kind: 'for-of'; readonly node: ts.ForOfStatement; readonly file: ts.SourceFile };

const ARRAY_METHODS = new Set(['map', 'forEach', 'flatMap', 'filter', 'some', 'every']);
const JOB_CONSTANT = /(^|_)JOBS?(_|$)/;
const JOB_NAME_TYPE = /JobName$/;
const MAX_DEPTH = 32;

function merge(parts: readonly Names[]): Names {
  const names: string[] = [];
  for (const part of parts) {
    if (part === null) return null;
    names.push(...part);
  }
  return [...new Set(names)];
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isConst(node: ts.VariableDeclaration): boolean {
  return (
    ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function declares(statement: ts.Statement, name: string): ts.VariableDeclaration | null {
  if (!ts.isVariableStatement(statement)) return null;
  for (const node of statement.declarationList.declarations) {
    if (ts.isIdentifier(node.name) && node.name.text === name) return node;
  }
  return null;
}

/** `job.name` (the received job's name inside a handler). */
function isJobName(node: ts.Expression): boolean {
  const target = unwrap(node);
  return (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === 'name' &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === 'job'
  );
}

function hasTrx(node: ts.Expression): boolean {
  const options = unwrap(node);
  return (
    ts.isObjectLiteralExpression(options) &&
    options.properties.some(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        ts.isIdentifier(property.name) &&
        property.name.text === 'trx',
    )
  );
}

/** Scans every non-test `.ts` file under `root` (see the header). Sites in path order. */
export function scanJobNames(root: string): NameSite[] {
  const files = new Map<string, ts.SourceFile | null>();

  function load(path: string): ts.SourceFile | null {
    if (!files.has(path)) {
      let text: string | null;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        text = null;
      }
      files.set(
        path,
        text === null
          ? null
          : ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      );
    }
    return files.get(path) ?? null;
  }

  function moduleOf(from: ts.SourceFile, specifier: string): ts.SourceFile | null {
    if (!specifier.startsWith('.')) return null;
    const base = resolve(dirname(from.fileName), specifier);
    for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
      if (!candidate.endsWith('.ts')) continue;
      const file = load(candidate);
      if (file !== null) return file;
    }
    return null;
  }

  /** A module-level binding of `name` in `file` (own declaration, import or re-export). */
  function topLevel(
    file: ts.SourceFile,
    name: string,
    space: 'value' | 'type',
    depth: number,
  ): Declaration | null {
    if (depth > MAX_DEPTH) return null;
    for (const statement of file.statements) {
      if (space === 'value') {
        const node = declares(statement, name);
        if (node !== null) return { kind: 'value', node, file };
      } else if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) {
        return { kind: 'type', node: statement, file };
      }
    }
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const bindings = statement.importClause?.namedBindings;
        if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
        for (const element of bindings.elements) {
          if (element.name.text !== name) continue;
          const target = moduleOf(file, statement.moduleSpecifier.text);
          if (target === null) return null;
          return topLevel(target, (element.propertyName ?? element.name).text, space, depth + 1);
        }
      }
      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const target = moduleOf(file, statement.moduleSpecifier.text);
        const clause = statement.exportClause;
        if (clause === undefined) {
          const found = target === null ? null : topLevel(target, name, space, depth + 1);
          if (found !== null) return found;
        } else if (ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            if (element.name.text !== name) continue;
            if (target === null) return null;
            return topLevel(target, (element.propertyName ?? element.name).text, space, depth + 1);
          }
        }
      }
    }
    return null;
  }

  /** The value binding of `name` visible at `at`: innermost scope first, then the module. */
  function lookup(
    at: ts.Node,
    name: string,
    file: ts.SourceFile,
    depth: number,
  ): Declaration | null {
    let child: ts.Node = at;
    let node: ts.Node = at.parent;
    for (;;) {
      if (ts.isSourceFile(node)) return topLevel(node, name, 'value', depth);
      if (ts.isFunctionLike(node)) {
        for (const parameter of node.parameters) {
          if (ts.isIdentifier(parameter.name) && parameter.name.text === name) {
            return { kind: 'parameter', node: parameter, file };
          }
        }
      }
      if (
        ts.isForOfStatement(node) &&
        child === node.statement &&
        ts.isVariableDeclarationList(node.initializer) &&
        node.initializer.declarations.some(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
        )
      ) {
        return (node.initializer.flags & ts.NodeFlags.Const) !== 0
          ? { kind: 'for-of', node, file }
          : null;
      }
      if (
        ts.isBlock(node) ||
        ts.isModuleBlock(node) ||
        ts.isCaseClause(node) ||
        ts.isDefaultClause(node)
      ) {
        for (const statement of node.statements) {
          const declaration = declares(statement, name);
          if (declaration !== null) return { kind: 'value', node: declaration, file };
        }
      }
      child = node;
      node = node.parent;
    }
  }

  function bindingNames(declaration: Declaration, depth: number): Names {
    if (depth > MAX_DEPTH) return null;
    const { file } = declaration;
    switch (declaration.kind) {
      case 'value': {
        const { node } = declaration;
        if (!isConst(node)) return null;
        const names =
          node.initializer === undefined ? null : expressionNames(node.initializer, file, depth);
        if (names !== null) return names;
        return node.type === undefined ? null : typeNames(node.type, file, depth);
      }
      case 'parameter': {
        const { node } = declaration;
        if (node.type !== undefined) return typeNames(node.type, file, depth);
        const callback = node.parent;
        const call = callback.parent;
        if (
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
          callback.parameters[0] === node &&
          ts.isCallExpression(call) &&
          call.arguments[0] === callback &&
          ts.isPropertyAccessExpression(call.expression) &&
          ARRAY_METHODS.has(call.expression.name.text)
        ) {
          return arrayNames(call.expression.expression, file, depth);
        }
        return null;
      }
      case 'for-of':
        return arrayNames(declaration.node.expression, file, depth);
      case 'type':
        return typeNames(declaration.node.type, file, depth);
    }
  }

  /** Every string a name expression can be, or null. */
  function expressionNames(expression: ts.Expression, file: ts.SourceFile, depth: number): Names {
    if (depth > MAX_DEPTH) return null;
    const node = unwrap(expression);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isConditionalExpression(node)) {
      return merge([
        expressionNames(node.whenTrue, file, depth + 1),
        expressionNames(node.whenFalse, file, depth + 1),
      ]);
    }
    if (ts.isIdentifier(node)) {
      const declaration = lookup(node, node.text, file, depth + 1);
      return declaration === null ? null : bindingNames(declaration, depth + 1);
    }
    return null;
  }

  /** Every string an element of an array expression can be, or null. */
  function arrayNames(expression: ts.Expression, file: ts.SourceFile, depth: number): Names {
    if (depth > MAX_DEPTH) return null;
    const node = unwrap(expression);
    if (ts.isArrayLiteralExpression(node)) {
      return merge(
        node.elements.map((element) =>
          ts.isSpreadElement(element)
            ? arrayNames(element.expression, file, depth + 1)
            : expressionNames(element, file, depth + 1),
        ),
      );
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Object' &&
      node.expression.name.text === 'freeze'
    ) {
      return arrayNames(node.arguments[0]!, file, depth + 1);
    }
    if (!ts.isIdentifier(node)) return null;
    const declaration = lookup(node, node.text, file, depth + 1);
    if (declaration?.kind === 'value') {
      const variable = declaration.node;
      if (!isConst(variable)) return null;
      const names =
        variable.initializer === undefined
          ? null
          : arrayNames(variable.initializer, declaration.file, depth + 1);
      if (names !== null) return names;
      return variable.type === undefined
        ? null
        : elementTypeNames(variable.type, declaration.file, depth + 1);
    }
    if (declaration?.kind === 'parameter' && declaration.node.type !== undefined) {
      return elementTypeNames(declaration.node.type, declaration.file, depth + 1);
    }
    return null;
  }

  /** Every string an element of an array or tuple type can be, or null. */
  function elementTypeNames(type: ts.TypeNode, file: ts.SourceFile, depth: number): Names {
    if (depth > MAX_DEPTH) return null;
    if (ts.isArrayTypeNode(type)) return typeNames(type.elementType, file, depth + 1);
    if (ts.isTypeOperatorNode(type) || ts.isParenthesizedTypeNode(type)) {
      return elementTypeNames(type.type, file, depth + 1);
    }
    if (ts.isTupleTypeNode(type)) {
      return merge(type.elements.map((element) => typeNames(element, file, depth + 1)));
    }
    if (
      ts.isTypeReferenceNode(type) &&
      ts.isIdentifier(type.typeName) &&
      (type.typeName.text === 'ReadonlyArray' || type.typeName.text === 'Array') &&
      type.typeArguments !== undefined &&
      type.typeArguments.length === 1
    ) {
      return typeNames(type.typeArguments[0]!, file, depth + 1);
    }
    return null;
  }

  /** Every string a string-literal type (union, alias, `(typeof X)[number]`) can be, or null. */
  function typeNames(type: ts.TypeNode, file: ts.SourceFile, depth: number): Names {
    if (depth > MAX_DEPTH) return null;
    if (ts.isParenthesizedTypeNode(type)) return typeNames(type.type, file, depth + 1);
    if (ts.isUnionTypeNode(type)) {
      return merge(type.types.map((member) => typeNames(member, file, depth + 1)));
    }
    if (ts.isLiteralTypeNode(type)) {
      return ts.isStringLiteralLike(type.literal) ? [type.literal.text] : null;
    }
    if (
      ts.isTypeReferenceNode(type) &&
      ts.isIdentifier(type.typeName) &&
      type.typeArguments === undefined
    ) {
      const alias = topLevel(file, type.typeName.text, 'type', depth + 1);
      return alias === null ? null : bindingNames(alias, depth + 1);
    }
    if (
      ts.isIndexedAccessTypeNode(type) &&
      ts.isTypeQueryNode(type.objectType) &&
      ts.isIdentifier(type.objectType.exprName) &&
      type.indexType.kind === ts.SyntaxKind.NumberKeyword
    ) {
      return arrayNames(type.objectType.exprName, file, depth + 1);
    }
    return null;
  }

  function sitesOf(file: ts.SourceFile, path: string): NameSite[] {
    const sites: NameSite[] = [];
    const add = (node: ts.Node, kind: SiteKind, names: Names) => {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      sites.push({ file: path, line, kind, names });
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'send' &&
        node.arguments.length === 4 &&
        hasTrx(node.arguments[3]!)
      ) {
        add(node, 'send', expressionNames(node.arguments[1]!, file, 0));
      }
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
      ) {
        if (isJobName(node.left)) add(node, 'dispatch', expressionNames(node.right, file, 0));
        else if (isJobName(node.right)) add(node, 'dispatch', expressionNames(node.left, file, 0));
      }
      if (ts.isSwitchStatement(node) && isJobName(node.expression)) {
        for (const clause of node.caseBlock.clauses) {
          if (ts.isCaseClause(clause)) {
            add(clause, 'dispatch', expressionNames(clause.expression, file, 0));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    for (const statement of file.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            !ts.isIdentifier(declaration.name) ||
            !JOB_CONSTANT.test(declaration.name.text) ||
            declaration.initializer === undefined
          ) {
            continue;
          }
          const value = unwrap(declaration.initializer);
          if (ts.isStringLiteralLike(value)) add(declaration, 'constant', [value.text]);
          else if (ts.isArrayLiteralExpression(value)) {
            add(declaration, 'constant', arrayNames(value, file, 0));
          }
        }
      }
      if (ts.isTypeAliasDeclaration(statement) && JOB_NAME_TYPE.test(statement.name.text)) {
        add(statement, 'constant', typeNames(statement.type, file, 0));
      }
    }
    return sites;
  }

  const paths = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts'))
    .map((path) => path.split(sep).join('/'))
    .sort();
  return paths.flatMap((path) => {
    const file = load(resolve(root, path));
    return file === null ? [] : sitesOf(file, path);
  });
}
