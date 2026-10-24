// B3-08k static helpers (no database, no Nest, no network): the "agent never hands a database
// handle to a function it does not own" scan (BR-AI-02 ③ as D10-294 applies it; spec-test review
// r1 S1-1, S2) over a TypeScript program built with the compiler API (the checker resolves
// imports, re-exports and types).
//
// A violation is a call or `new` in apps/api/src/modules/agent/** whose callee is external and
// which receives a database handle (directly or carried, see below) among its arguments.
// - Callee: the called expression; for `f.call(…)`, `f.apply(…)` and `f.bind(…)` it is `f`.
// - Own callee: a function, method or class with a body declared in agent or in platform (D10-287:
//   platform's database infrastructure is not another module), or a function written in place;
//   reached through imports, re-exports, local aliases (`const g = f`) and object properties
//   (`{ f }`, `{ g: f }`). Allowed callee: anything declared by kysely or @couli/db (their own
//   API takes the handle by design). Every other callee is external: another module's function or
//   class, and every function value handed in from outside — a parameter, a property of a
//   parameter or of an options / deps object, an injected token value, an interface method —
//   whatever its type is and wherever that type is declared.
// - Database handle (conservative): an identifier or property named db / trx / tx; any
//   `.withSchema(...)` result; any expression whose type is Kysely / Transaction /
//   ControlledTransaction (inferred or annotated, `| undefined` included).
// - Carried handle: an argument is checked as written — object and array literals property by
//   property (shorthand `{ db }`, nested literals, spreads, a get accessor by what it returns:
//   `{ get db() { return db; } }`), conditional and logical branches; any other argument, spread
//   or spread property (`deps`, `...deps`, `{ ...deps }`, a variable holding `{ db, clock }`) by
//   its type: a handle, or an object with a field that is a handle or carries one (two levels
//   down), or a field named db / trx / tx whose type is any or unknown.
// - The business assembly (spec-test review r2, D10-305): the composition root (app.module) hands
//   agent its assembly factory as an `assembly` option (`AgentModule.forStream({ assembly: X })`
//   or any object literal whose contextual type's `assembly` property is declared in agent). When
//   every such X resolves — through imports and re-exports — to a function, method or class with
//   a body declared under apps/api/src/modules/agent/, the option's type alias is a proven slot:
//   a property or parameter declared in agent with that type and no value of its own (the
//   runtime's `deps.assembly`, the provider's `options.assembly` and a local alias of it) is an own
//   callee, so `deps.assembly?.({ db, … })` and `factory({ ...context })` may pass the handle. A
//   variable of that type holding another value is judged by that value; any other function value
//   handed in (the caller / consent readers among them) stays external. assemblyHandoffs reports
//   each X and whether it is proven.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const MODULES = join(ROOT, 'apps/api/src/modules');
export const AGENT = join(MODULES, 'agent');
export const APP_MODULE = join(ROOT, 'apps/api/src/app.module.ts');

/** The places of the B3-08k brief (all must be scanned; index.ts holds two of them). */
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
/** What counts as an own callee (see the header). */
interface Ownership {
  /** Module directories whose functions with a body are own. */
  readonly modules: ReadonlySet<string>;
  /** Type aliases of agent's proven `assembly` slots. */
  readonly slots: ReadonlySet<ts.Symbol>;
}

/** Modules whose functions with a body may take agent's handle: agent itself and platform. */
const OWN_MODULES: ReadonlySet<string> = new Set(['agent', 'platform']);
/** Where the business assembly handed to agent must be declared: agent only. */
const AGENT_ONLY: Ownership = { modules: new Set(['agent']), slots: new Set() };
const BOUND_CALLS = new Set(['call', 'apply', 'bind']);
const LOGICAL = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);
/** How many field levels below an argument a carried handle is looked for. */
const CARRY_DEPTH = 2;

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

function posix(path: string): string {
  return resolve(path).split(sep).join('/');
}

const DB_PACKAGE = posix(join(ROOT, 'packages/db'));

/** kysely's and @couli/db's own files. */
function databasePackage(fileName: string): boolean {
  const path = posix(fileName);
  return (
    path.includes('/node_modules/kysely/') ||
    path.includes('/node_modules/@couli/db/') ||
    path.startsWith(`${DB_PACKAGE}/`)
  );
}

function libraryFile(fileName: string): boolean {
  return posix(fileName).includes('/node_modules/');
}

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

function anyType(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

function handleType(type: ts.Type): boolean {
  const names = [type.getSymbol()?.getName(), type.aliasSymbol?.getName()];
  if (names.some((name) => name !== undefined && HANDLE_TYPES.has(name))) return true;
  return type.isUnionOrIntersection() && type.types.some(handleType);
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

/** A class or interface declared in a library (pino's Logger, Promise, Map…): not walked. */
function libraryShape(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  if (symbol === undefined) return false;
  if ((symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) === 0) return false;
  return (symbol.declarations ?? []).some((d) => libraryFile(d.getSourceFile().fileName));
}

/** Whether a value of `type` is a handle or holds one in its fields (see the header). */
function carriesHandle(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth = 0,
  seen: Set<ts.Type> = new Set(),
): boolean {
  if (handleType(type)) return true;
  if (depth > CARRY_DEPTH || seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection()) {
    return type.types.some((part) => carriesHandle(checker, part, depth, seen));
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  // A function value is not a carrier (what it closes over is not handed over by this call).
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
    return false;
  }
  const element = type.getNumberIndexType();
  if (element !== undefined && carriesHandle(checker, element, depth + 1, seen)) return true;
  if (libraryShape(type)) return false;
  return checker.getPropertiesOfType(type).some((property) => {
    const value = checker.getTypeOfSymbol(property);
    if (HANDLE_NAMES.has(property.getName()) && anyType(value)) return true;
    return carriesHandle(checker, value, depth + 1, seen);
  });
}

function propertyKey(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : '';
}

function propertyHandles(
  checker: ts.TypeChecker,
  property: ts.ObjectLiteralElementLike,
  source: ts.SourceFile,
): string[] {
  if (ts.isShorthandPropertyAssignment(property)) {
    return handlesIn(checker, property.name, source);
  }
  if (ts.isPropertyAssignment(property)) {
    const key = property.name.getText(source);
    return valueHandles(checker, property.name, property.initializer, source).map(
      (handle) => `${key}: ${handle}`,
    );
  }
  if (ts.isGetAccessorDeclaration(property)) {
    // A getter hands over what it returns (review r2): judged by every return expression.
    const key = property.name.getText(source);
    const returned = property.body === undefined ? [] : returnsOf(property.body);
    return returned.flatMap((statement) =>
      statement.expression === undefined
        ? []
        : valueHandles(checker, property.name, statement.expression, source).map(
            (handle) => `get ${key}: ${handle}`,
          ),
    );
  }
  if (ts.isSpreadAssignment(property)) {
    return handlesIn(checker, property.expression, source).map((handle) => `...${handle}`);
  }
  // Methods and setters written in place hand nothing over.
  return [];
}

/** The handles of one property's value; a value typed any under a handle's name counts. */
function valueHandles(
  checker: ts.TypeChecker,
  name: ts.PropertyName,
  value: ts.Expression,
  source: ts.SourceFile,
): string[] {
  const found = handlesIn(checker, value, source);
  if (
    found.length === 0 &&
    HANDLE_NAMES.has(propertyKey(name)) &&
    anyType(checker.getTypeAtLocation(value))
  ) {
    found.push(value.getText(source));
  }
  return found;
}

/** Source text of every database handle `node` passes, itself or carried (see the header). */
function handlesIn(checker: ts.TypeChecker, node: ts.Expression, source: ts.SourceFile): string[] {
  const expression = unwrap(node);
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.flatMap((property) => propertyHandles(checker, property, source));
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element) => handlesIn(checker, element, source));
  }
  if (ts.isSpreadElement(expression)) {
    return handlesIn(checker, expression.expression, source).map((handle) => `...${handle}`);
  }
  if (ts.isConditionalExpression(expression)) {
    return [
      ...handlesIn(checker, expression.whenTrue, source),
      ...handlesIn(checker, expression.whenFalse, source),
    ];
  }
  if (ts.isBinaryExpression(expression) && LOGICAL.has(expression.operatorToken.kind)) {
    return [
      ...handlesIn(checker, expression.left, source),
      ...handlesIn(checker, expression.right, source),
    ];
  }
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return [];
  if (isHandle(checker, expression)) return [expression.getText(source)];
  if (carriesHandle(checker, checker.getTypeAtLocation(expression))) {
    return [`${expression.getText(source)} (carries a handle)`];
  }
  return [];
}

function functionValue(node: ts.Expression): boolean {
  const value = unwrap(node);
  return ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isClassExpression(value);
}

function initializerOf(node: ts.Declaration): ts.Expression | undefined {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isPropertyDeclaration(node)
  ) {
    return node.initializer;
  }
  return undefined;
}

/** A function, method or class declaration with a body, or a binding of a function value. */
function bodyDeclaration(node: ts.Declaration): boolean {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.body !== undefined;
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return true;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  const value = initializerOf(node);
  return value !== undefined && functionValue(value);
}

function referenced(checker: ts.TypeChecker, node: ts.Expression | undefined) {
  if (node === undefined) return undefined;
  const value = unwrap(node);
  if (ts.isIdentifier(value)) return checker.getSymbolAtLocation(value);
  if (ts.isPropertyAccessExpression(value)) return checker.getSymbolAtLocation(value.name);
  return undefined;
}

/** The type alias of a type with null and undefined removed (`F | undefined` → F's alias). */
function aliasOf(checker: ts.TypeChecker, type: ts.Type): ts.Symbol | undefined {
  return checker.getNonNullableType(type).aliasSymbol;
}

/**
 * A slot of agent typed with a proven assembly alias: a property signature, a property without an
 * initializer or a parameter without a default, annotated with that alias (`| undefined` allowed).
 */
function provenSlot(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  slots: ReadonlySet<ts.Symbol>,
): boolean {
  if (slots.size === 0) return false;
  if (moduleOf(declaration.getSourceFile().fileName) !== 'agent') return false;
  let annotation: ts.TypeNode | undefined;
  if (ts.isPropertySignature(declaration)) {
    annotation = declaration.type;
  } else if (
    (ts.isPropertyDeclaration(declaration) || ts.isParameter(declaration)) &&
    declaration.initializer === undefined
  ) {
    annotation = declaration.type;
  }
  if (annotation === undefined) return false;
  const alias = aliasOf(checker, checker.getTypeFromTypeNode(annotation));
  return alias !== undefined && slots.has(alias);
}

/** Whether `start` is a function / method / class with a body of `own.modules`, or a proven slot. */
function ownFunction(
  checker: ts.TypeChecker,
  start: ts.Symbol,
  own: Ownership,
  seen: Set<ts.Symbol> = new Set(),
): boolean {
  const symbol = start.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(start) : start;
  if (seen.has(symbol)) return false;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    const owner = moduleOf(declaration.getSourceFile().fileName);
    if (owner === null || !own.modules.has(owner)) continue;
    if (bodyDeclaration(declaration)) return true;
    if (provenSlot(checker, declaration, own.slots)) return true;
    // A local alias or an object property naming a function: follow it.
    const next = ts.isShorthandPropertyAssignment(declaration)
      ? checker.getShorthandAssignmentValueSymbol(declaration)
      : referenced(checker, initializerOf(declaration));
    if (next !== undefined && ownFunction(checker, next, own, seen)) return true;
  }
  return false;
}

/** The called expression; `f` for `f.call(…)`, `f.apply(…)` and `f.bind(…)`. */
function calleeOf(checker: ts.TypeChecker, node: ts.CallExpression | ts.NewExpression) {
  const callee = unwrap(node.expression);
  if (ts.isPropertyAccessExpression(callee) && BOUND_CALLS.has(callee.name.text)) {
    const target = checker.getTypeAtLocation(callee.expression);
    if (target.getCallSignatures().length > 0) return unwrap(callee.expression);
  }
  return callee;
}

/** Whether a call to `callee` may not receive agent's handle (see the header). */
function externalCallee(
  checker: ts.TypeChecker,
  callee: ts.Expression,
  slots: ReadonlySet<ts.Symbol>,
): boolean {
  if (functionValue(callee)) return false;
  const at = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  const found = checker.getSymbolAtLocation(at);
  if (found === undefined) return true;
  const symbol = found.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(found) : found;
  const files = (symbol.declarations ?? []).map((d) => d.getSourceFile().fileName);
  if (files.some(databasePackage)) return false;
  return !ownFunction(checker, symbol, { modules: OWN_MODULES, slots });
}

export interface AssemblyHandoff {
  /** `<repository path>:<line>` of the `assembly` option. */
  readonly at: string;
  /** Source text of the value handed in. */
  readonly value: string;
  /** Why it is not proven agent's own; null when it resolves to agent's function with a body. */
  readonly problem: string | null;
}

interface AssemblyOption extends AssemblyHandoff {
  /** The type alias of agent's option (the slot), when it has one. */
  readonly alias: ts.Symbol | undefined;
}

function assemblyOption(
  checker: ts.TypeChecker,
  literal: ts.ObjectLiteralExpression,
  property: ts.ObjectLiteralElementLike,
  source: ts.SourceFile,
): AssemblyOption | null {
  if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
    return null;
  }
  if (propertyKey(property.name) !== 'assembly') return null;
  const contextual = checker.getContextualType(literal);
  if (contextual === undefined) return null;
  const slot = checker.getPropertyOfType(checker.getNonNullableType(contextual), 'assembly');
  const inAgent = (slot?.declarations ?? []).some(
    (declaration) => moduleOf(declaration.getSourceFile().fileName) === 'agent',
  );
  if (slot === undefined || !inAgent) return null;
  const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
  const target = ts.isPropertyAssignment(property)
    ? referenced(checker, property.initializer)
    : checker.getShorthandAssignmentValueSymbol(property);
  let problem: string | null = null;
  if (target === undefined) {
    problem = 'not a name: written in place or computed outside agent';
  } else if (!ownFunction(checker, target, AGENT_ONLY)) {
    problem = 'not a function, method or class with a body under apps/api/src/modules/agent/';
  }
  const { line } = source.getLineAndCharacterOfPosition(property.getStart(source));
  return {
    at: `${relative(ROOT, source.fileName)}:${String(line + 1)}`,
    value: value.getText(source),
    problem,
    alias: aliasOf(checker, checker.getTypeOfSymbol(slot)),
  };
}

function assemblyOptions(program: ts.Program, paths: readonly string[]): AssemblyOption[] {
  const checker = program.getTypeChecker();
  const out: AssemblyOption[] = [];
  for (const path of paths) {
    const source = program.getSourceFile(path);
    if (source === undefined) {
      const at = relative(ROOT, path);
      out.push({ at, value: '', problem: 'not in the scanned program', alias: undefined });
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          const option = assemblyOption(checker, node, property, source);
          if (option !== null) out.push(option);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

/**
 * Every business assembly the composition files `paths` hand agent (see the header), in source
 * order, each with what keeps it from being proven agent's own (null when it is).
 */
export function assemblyHandoffs(program: ts.Program, paths: readonly string[]): AssemblyHandoff[] {
  return assemblyOptions(program, paths).map(({ at, value, problem }) => ({ at, value, problem }));
}

/** The option aliases every one of whose values (in `paths`) is proven agent's own. */
function provenSlots(program: ts.Program, paths: readonly string[]): Set<ts.Symbol> {
  const own = new Set<ts.Symbol>();
  const unproven = new Set<ts.Symbol>();
  for (const option of assemblyOptions(program, paths)) {
    if (option.alias === undefined) continue;
    (option.problem === null ? own : unproven).add(option.alias);
  }
  for (const alias of unproven) own.delete(alias);
  return own;
}

/**
 * Every violation in the files `paths` of `program`, one line each:
 * `<repository path>:<line> <callee>(<handle>)`. A file missing from the program is reported too
 * (it was not scanned). `compositions`: the composition files whose `assembly` options may prove
 * agent's assembly slots (app.module for agent's code; see the header).
 */
export function foreignDbHandoffs(
  program: ts.Program,
  paths: readonly string[],
  compositions: readonly string[] = [],
): string[] {
  const checker = program.getTypeChecker();
  const slots = provenSlots(program, compositions);
  const out: string[] = [];
  for (const path of paths) {
    const source = program.getSourceFile(path);
    if (source === undefined) {
      out.push(`${relative(ROOT, path)} not in the scanned program`);
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = calleeOf(checker, node);
        const keyword =
          callee.kind === ts.SyntaxKind.ImportKeyword || callee.kind === ts.SyntaxKind.SuperKeyword;
        if (!keyword && externalCallee(checker, callee, slots)) {
          const handles = (node.arguments ?? []).flatMap((arg) => handlesIn(checker, arg, source));
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          const at = `${relative(ROOT, path)}:${String(line + 1)}`;
          const name = node.expression.getText(source);
          for (const handle of handles) out.push(`${at} ${name}(${handle})`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

function parse(path: string): ts.SourceFile {
  const text = readFileSync(path, 'utf8');
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Names of every function called anywhere in a file (plain identifiers and `x.name(...)`). */
export function calledNames(path: string): Set<string> {
  const source = parse(path);
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
  const source = parse(path);
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

export interface FreshMember {
  /** `<repository path>:<line>` of the member. */
  readonly at: string;
  /** What keeps it from being a read afresh; null when it is one. */
  readonly problem: string | null;
}

function memberName(node: ts.Node): string | null {
  if (
    (ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertyDeclaration(node)) &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return node.name.text;
  }
  return null;
}

/** `createContentReader(...).configValue(...)` (awaited or not): a reader built for this read. */
function freshRead(node: ts.Expression): boolean {
  const outer = unwrap(node);
  const call = ts.isAwaitExpression(outer) ? unwrap(outer.expression) : outer;
  if (!ts.isCallExpression(call)) return false;
  const method = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(method) || method.name.text !== 'configValue') return false;
  const target = unwrap(method.expression);
  if (!ts.isCallExpression(target)) return false;
  const factory = unwrap(target.expression);
  return ts.isIdentifier(factory) && factory.text === 'createContentReader';
}

/** The return statements of a function body, nested functions excluded. */
function returnsOf(body: ts.Block): ts.ReturnStatement[] {
  const out: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) out.push(node);
    if (ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

function freshProblem(node: ts.Node, source: ts.SourceFile): string | null {
  let body: ts.ConciseBody | undefined;
  if (ts.isMethodDeclaration(node)) {
    body = node.body;
  } else if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
    const value = node.initializer === undefined ? undefined : unwrap(node.initializer);
    if (value !== undefined && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
      body = value.body;
    }
  }
  if (body === undefined) return 'not a function written in place';
  if (!ts.isBlock(body)) {
    return freshRead(body) ? null : `answers ${body.getText(source)}, not a reader built per call`;
  }
  const returns = returnsOf(body);
  if (returns.length === 0) return 'returns nothing';
  for (const statement of returns) {
    const value = statement.expression;
    if (value === undefined || !freshRead(value)) {
      return `returns ${value?.getText(source) ?? 'nothing'}, not a reader built per call`;
    }
  }
  return null;
}

/**
 * Every `freshConfigValue` member written in a file (object literal or class) and whether it reads
 * afresh: a function written in place whose answer is `createContentReader(...).configValue(...)`
 * (the concise body, or every return statement; awaited or not), so the content reader and its
 * cache live for one call only — the same read as the old createAgentSwitchReader's per-call
 * reader. A reader kept outside the function, a shared reader's method, a cache in front of the
 * read or a member that is not a function in place is a problem.
 */
export function freshConfigValueMembers(path: string): FreshMember[] {
  const source = parse(path);
  const out: FreshMember[] = [];
  const visit = (node: ts.Node): void => {
    if (memberName(node) === 'freshConfigValue') {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      out.push({
        at: `${relative(ROOT, path)}:${String(line + 1)}`,
        problem: freshProblem(node, source),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}
