// B3-08k static helpers (no database, no Nest, no network): the "agent never hands a database
// handle to another module's function" scan (BR-AI-02 ③ as D10-294 applies it) over a TypeScript
// program built with the compiler API (the checker resolves imports, re-exports and types).
//
// A violation is a call or `new` in apps/api/src/modules/agent/** whose callee comes from another
// module under apps/api/src/modules/ (not agent) and which receives a database handle as an
// argument, or as the value of a property (shorthand `{ db }` included) of an object or array
// literal argument (nested literals and literal spreads included).
// - Callee from another module: the symbol the callee resolves to (through imports, namespace
//   imports and re-exports) is declared there, or one of the call / construct signatures of the
//   callee's type is declared there, or the callee's type is a type alias declared there.
// - Database handle (conservative): an identifier or property named db / trx / tx; any
//   `.withSchema(...)` result; any expression whose type is Kysely / Transaction /
//   ControlledTransaction (inferred or annotated, `| undefined` included).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const MODULES = join(ROOT, 'apps/api/src/modules');
export const AGENT = join(MODULES, 'agent');
export const APP_MODULE = join(ROOT, 'apps/api/src/app.module.ts');

/** The five places of the B3-08k brief (all must be scanned). */
export const TASK_FILES = [
  'agent.module.ts',
  'stream/mount/index.ts',
  'stream/mount/config.ts',
  'stream/mount/production.ts',
  'stream/mount/caller.ts',
].map((path) => join(AGENT, path));

export interface SourceText {
  readonly path: string;
  readonly text: string;
}

const HANDLE_NAMES = new Set(['db', 'trx', 'tx']);
const HANDLE_TYPES = new Set(['Kysely', 'Transaction', 'ControlledTransaction']);
const HANDLE_ANNOTATION = /^(?:Kysely|Transaction|ControlledTransaction)\s*</u;

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  allowImportingTsExtensions: true,
  experimentalDecorators: true,
  noEmit: true,
  strict: true,
  skipLibCheck: true,
  types: ['node'],
};

/** Every file under `dir`, recursively, as absolute paths in sorted order. */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** apps/api/src/modules/agent/** TypeScript sources, test files excluded. */
export function agentSourcePaths(): string[] {
  return filesUnder(AGENT).filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'));
}

/** The module directory (first segment under apps/api/src/modules/) of a path, or null. */
export function moduleOf(path: string): string | null {
  const parts = relative(MODULES, resolve(path)).split(sep);
  const head = parts[0];
  if (head === undefined || head === '' || head === '..' || parts.length < 2) return null;
  return head;
}

function foreign(path: string): boolean {
  const owner = moduleOf(path);
  return owner !== null && owner !== 'agent';
}

/**
 * A program over `roots` where the files of `memory` (absolute paths) are read from memory instead
 * of the disk (they need not exist); every other file comes from the disk.
 */
export function scanProgram(
  roots: readonly string[],
  memory: readonly SourceText[] = [],
): ts.Program {
  const host = ts.createCompilerHost(OPTIONS, true);
  const files = new Map(memory.map((file) => [resolve(file.path), file.text]));
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (path) => files.has(resolve(path)) || fileExists(path);
  host.readFile = (path) => files.get(resolve(path)) ?? readFile(path);
  host.getSourceFile = (path, language, onError, shouldCreate) => {
    const text = files.get(resolve(path));
    return text === undefined
      ? getSourceFile(path, language, onError, shouldCreate)
      : ts.createSourceFile(path, text, language, true);
  };
  return ts.createProgram({ rootNames: [...roots], options: OPTIONS, host });
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function handleType(type: ts.Type): boolean {
  const names = [type.getSymbol()?.getName(), type.aliasSymbol?.getName()];
  if (names.some((name) => name !== undefined && HANDLE_TYPES.has(name))) return true;
  return type.isUnion() && type.types.some(handleType);
}

function annotatedHandle(checker: ts.TypeChecker, node: ts.Node): boolean {
  const symbol = checker.getSymbolAtLocation(node);
  for (const declaration of symbol?.declarations ?? []) {
    const annotation =
      ts.isParameter(declaration) ||
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertySignature(declaration) ||
      ts.isPropertyDeclaration(declaration)
        ? declaration.type
        : undefined;
    if (annotation !== undefined && HANDLE_ANNOTATION.test(annotation.getText())) return true;
  }
  return false;
}

function isHandle(checker: ts.TypeChecker, node: ts.Expression): boolean {
  const expression = unwrap(node);
  if (ts.isIdentifier(expression) && HANDLE_NAMES.has(expression.text)) return true;
  if (ts.isPropertyAccessExpression(expression) && HANDLE_NAMES.has(expression.name.text)) {
    return true;
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'withSchema'
  ) {
    return true;
  }
  if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
    if (annotatedHandle(checker, expression)) return true;
  }
  return handleType(checker.getTypeAtLocation(expression));
}

/** Source text of every database handle `node` passes (itself or inside literals). */
function handlesIn(checker: ts.TypeChecker, node: ts.Expression, source: ts.SourceFile): string[] {
  const expression = unwrap(node);
  if (ts.isObjectLiteralExpression(expression)) {
    const out: string[] = [];
    for (const property of expression.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        if (isHandle(checker, property.name)) out.push(property.name.text);
      } else if (ts.isPropertyAssignment(property)) {
        for (const inner of handlesIn(checker, property.initializer, source)) {
          out.push(`${property.name.getText(source)}: ${inner}`);
        }
      } else if (ts.isSpreadAssignment(property)) {
        const spread = unwrap(property.expression);
        if (ts.isObjectLiteralExpression(spread)) out.push(...handlesIn(checker, spread, source));
      }
    }
    return out;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element) =>
      ts.isSpreadElement(element) ? [] : handlesIn(checker, element, source),
    );
  }
  return isHandle(checker, expression) ? [expression.getText(source)] : [];
}

function declaredForeign(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): boolean {
  if (symbol === undefined) return false;
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return (target.declarations ?? []).some((d) => foreign(d.getSourceFile().fileName));
}

function rootIdentifier(node: ts.Expression): ts.Identifier | null {
  let current = unwrap(node);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrap(current.expression);
  }
  return ts.isIdentifier(current) ? current : null;
}

/** Whether the callee of `node` comes from another module (see the header). */
function foreignCallee(
  checker: ts.TypeChecker,
  node: ts.CallExpression | ts.NewExpression,
): boolean {
  const callee = unwrap(node.expression);
  if (callee.kind === ts.SyntaxKind.ImportKeyword || callee.kind === ts.SyntaxKind.SuperKeyword) {
    return false;
  }
  if (declaredForeign(checker.getSymbolAtLocation(callee), checker)) return true;
  const root = rootIdentifier(callee);
  if (root !== null && root !== callee) {
    const symbol = checker.getSymbolAtLocation(root);
    // A namespace import of another module (`import * as content from '../content/index.ts'`).
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
      const target = checker.getAliasedSymbol(symbol);
      if ((target.declarations ?? []).some((d) => ts.isSourceFile(d) && foreign(d.fileName))) {
        return true;
      }
    }
  }
  const type = checker.getNonNullableType(checker.getTypeAtLocation(callee));
  const signatures = ts.isNewExpression(node)
    ? type.getConstructSignatures()
    : type.getCallSignatures();
  for (const signature of signatures) {
    const declaration = signature.getDeclaration() as ts.SignatureDeclaration | undefined;
    if (declaration !== undefined && foreign(declaration.getSourceFile().fileName)) return true;
  }
  return (type.aliasSymbol?.declarations ?? []).some((d) => foreign(d.getSourceFile().fileName));
}

/**
 * Every violation in the files `paths` of `program`, one line each:
 * `<repository path>:<line> <callee>(<handle>)`. A file missing from the program is reported too
 * (it was not scanned).
 */
export function foreignDbHandoffs(program: ts.Program, paths: readonly string[]): string[] {
  const checker = program.getTypeChecker();
  const out: string[] = [];
  for (const path of paths) {
    const source = program.getSourceFile(path);
    if (source === undefined) {
      out.push(`${relative(ROOT, path)} not in the scanned program`);
      continue;
    }
    const visit = (node: ts.Node): void => {
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && foreignCallee(checker, node)) {
        const handles = (node.arguments ?? []).flatMap((arg) => handlesIn(checker, arg, source));
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        const at = `${relative(ROOT, path)}:${String(line + 1)}`;
        const callee = node.expression.getText(source);
        for (const handle of handles) out.push(`${at} ${callee}(${handle})`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

/** Names of every function called anywhere in a file (plain identifiers and `x.name(...)`). */
export function calledNames(path: string): Set<string> {
  const text = readFileSync(path, 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee)) names.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/**
 * The property names of the object literal passed to every `AgentModule.forStream(...)` call in a
 * file, one list per call (an empty list for a call without an object literal argument).
 */
export function forStreamOptionNames(path: string): string[][] {
  const text = readFileSync(path, 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'AgentModule' &&
      node.expression.name.text === 'forStream'
    ) {
      const first = node.arguments[0];
      const arg = first === undefined ? undefined : unwrap(first);
      const names: string[] = [];
      if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
        for (const property of arg.properties) {
          if (property.name !== undefined) names.push(property.name.getText(source));
        }
      }
      out.push(names);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}
