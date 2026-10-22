// H5 字典按引用裁剪的收集器（F1-01t）。构建期扫描整个 apps/h5/src（不含单元测试），找出：
// 1. 字面键：源码里与字典键完全相同的字符串字面量（t('a.b')、texts/*.ts 里的键都算）；
// 2. 动态键：传给翻译函数（shared/texts.ts 的 t 及其包装函数）的非字面参数，其静态形状必须被
//    texts/dynamic-keys.ts 登记的模式覆盖，否则报错、构建失败。
// 包装函数自动识别：函数把自己的参数（或剩余参数的 for-of 元素）原样当键传给翻译函数，即为包装函数，
// 它的调用点同样按上面的规则检查。只做语法层面的静态分析（不建类型检查程序），保证构建与测试足够快。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

export interface TrimTextDictionary {
  texts: Record<string, string>;
  fallbacks: Record<string, string>;
}

export interface CollectH5TextsOptions {
  /** Absolute src directory; scan the entire tree, including all entries and lazy routes. */
  sourceRoot: string;
  /** Caller-owned input, including future contract additions; never mutate it. */
  dictionary: TrimTextDictionary;
}

/** 翻译函数所在模块与导出名（相对 sourceRoot）。 */
const TRANSLATE_MODULE = 'shared/texts.ts';
const TRANSLATE_EXPORT = 't';
/** 动态键登记所在模块与导出名（相对 sourceRoot）。 */
const REGISTRY_MODULE = 'texts/dynamic-keys.ts';
const REGISTRY_EXPORT = 'H5_TEXT_KEY_PATTERNS';

/** 形状里代表「静态未知片段」的占位字符；源码字面量里不会出现。 */
const HOLE = '\u0000';
/** 单个键表达式最多展开的形状数（条件分支的笛卡尔积），超过即视为无法静态确定。 */
const MAX_SHAPES = 64;

/** 翻译函数的键参数位置；rest 表示从该位置起的每个实参都是键。 */
interface Translator {
  index: number;
  rest: boolean;
}

interface ParsedModule {
  file: string;
  source: ts.SourceFile;
}

type Binding =
  | { kind: 'import'; module: string | undefined; name: string }
  | { kind: 'const'; declaration: ts.VariableDeclaration }
  | { kind: 'param'; fn: ts.SignatureDeclaration; index: number; rest: boolean }
  | { kind: 'forOf'; statement: ts.ForOfStatement }
  | { kind: 'function'; declaration: ts.FunctionDeclaration }
  | { kind: 'other' };

/** 键表达式的求值结果：有限个形状、某个函数的参数原样、或无法静态确定。 */
type KeyValue =
  | { kind: 'shapes'; shapes: string[] }
  | { kind: 'param'; fn: ts.SignatureDeclaration; index: number; rest: boolean }
  | { kind: 'unknown' };

function listSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSources(path));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files.sort();
}

function parse(file: string): ParsedModule {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  return { file, source };
}

function location(node: ts.Node): string {
  const source = node.getSourceFile();
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${source.fileName}:${line + 1}:${character + 1}`;
}

/** 模式 → 正则：`*` 匹配任意非空片段（可含点号与形状占位），其余字符按字面匹配。 */
function patternRegExp(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]+');
  return new RegExp(`^${body}$`);
}

function readRegistry(sourceRoot: string): string[] {
  const file = join(sourceRoot, REGISTRY_MODULE);
  const { source } = parse(file);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== REGISTRY_EXPORT) continue;
      let init = declaration.initializer;
      while (init !== undefined && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init))) {
        init = init.expression;
      }
      if (init === undefined || !ts.isArrayLiteralExpression(init)) break;
      const patterns: string[] = [];
      for (const element of init.elements) {
        if (!ts.isStringLiteralLike(element)) {
          throw new Error(`${location(element)}: ${REGISTRY_EXPORT} 只能写字符串字面量`);
        }
        const pattern = element.text;
        // 登记的是键族：要有通配，且以字面前缀开头（不允许整串通配把整份字典放进包）。
        if (!pattern.includes('*') || pattern.startsWith('*') || pattern.includes(HOLE)) {
          throw new Error(
            `${location(element)}: 动态键模式 "${pattern}" 须以字面前缀开头并含 *（登记键族，不登记单个键）`,
          );
        }
        patterns.push(pattern);
      }
      return patterns;
    }
  }
  throw new Error(`${file}: 找不到动态键登记 export const ${REGISTRY_EXPORT} = [...]`);
}

function bindsName(name: ts.BindingName, text: string): boolean {
  if (ts.isIdentifier(name)) return name.text === text;
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindsName(element.name, text),
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
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

class Collector {
  private readonly modules = new Map<string, ParsedModule>();
  /** 已识别的翻译函数：声明节点 → 键参数位置。 */
  private readonly translators = new Map<ts.Node, Translator>();
  /** 根翻译函数 t 的声明（shared/texts.ts）。 */
  private readonly rootFile: string;
  private changed = false;

  constructor(sourceRoot: string) {
    for (const file of listSources(sourceRoot)) this.modules.set(file, parse(file));
    this.rootFile = join(sourceRoot, TRANSLATE_MODULE);
    const root = this.modules.get(this.rootFile);
    const declaration = root?.source.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === TRANSLATE_EXPORT &&
        hasExportModifier(statement),
    );
    if (declaration === undefined) {
      throw new Error(`${this.rootFile}: 找不到翻译函数 export function ${TRANSLATE_EXPORT}`);
    }
    this.translators.set(declaration, { index: 0, rest: false });
  }

  /** 先迭代到包装函数集合不再增长，再做一次带检查的收集。 */
  run(patterns: readonly RegExp[]): { literals: Set<string>; errors: string[] } {
    do {
      this.changed = false;
      for (const module of this.modules.values()) this.scan(module, undefined);
    } while (this.changed);
    const result = { literals: new Set<string>(), errors: [] as string[], patterns };
    for (const module of this.modules.values()) this.scan(module, result);
    return result;
  }

  private resolveModule(from: string, specifier: string): string | undefined {
    if (!specifier.startsWith('.')) return undefined;
    const target = resolve(dirname(from), specifier);
    if (this.modules.has(target)) return target;
    for (const extension of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (this.modules.has(target + extension)) return target + extension;
    }
    return target;
  }

  /** 从标识符所在位置向外逐层找它的声明（按块作用域，足够覆盖 H5 源码的写法）。 */
  private lookup(id: ts.Identifier): Binding | undefined {
    const name = id.text;
    let child: ts.Node = id;
    for (let node = id.parent; node !== undefined; child = node, node = node.parent) {
      if (ts.isFunctionLike(node)) {
        const index = node.parameters.findIndex((parameter) => bindsName(parameter.name, name));
        if (index >= 0) {
          const parameter = node.parameters[index]!;
          if (!ts.isIdentifier(parameter.name)) return { kind: 'other' };
          return { kind: 'param', fn: node, index, rest: parameter.dotDotDotToken !== undefined };
        }
        if (
          (ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) &&
          node.name?.text === name &&
          child !== node.name
        ) {
          return ts.isFunctionDeclaration(node)
            ? { kind: 'function', declaration: node }
            : { kind: 'other' };
        }
      }
      if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node)) &&
        node.initializer !== undefined &&
        ts.isVariableDeclarationList(node.initializer) &&
        node.initializer.declarations.some((declaration) => bindsName(declaration.name, name))
      ) {
        const declaration = node.initializer.declarations[0]!;
        if (ts.isForOfStatement(node) && ts.isIdentifier(declaration.name)) {
          return { kind: 'forOf', statement: node };
        }
        return { kind: 'other' };
      }
      if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
        if (bindsName(node.variableDeclaration.name, name)) return { kind: 'other' };
      }
      if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) {
        const found = this.findInStatements(node.statements, name, node);
        if (found !== undefined) return found;
      } else if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
        const found = this.findInStatements(node.statements, name, node);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  private findInStatements(
    statements: ts.NodeArray<ts.Statement>,
    name: string,
    scope: ts.Node,
  ): Binding | undefined {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!bindsName(declaration.name, name)) continue;
          const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
          if (isConst && ts.isIdentifier(declaration.name)) return { kind: 'const', declaration };
          return { kind: 'other' };
        }
      } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
        return { kind: 'function', declaration: statement };
      } else if (
        (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
        statement.name?.text === name
      ) {
        return { kind: 'other' };
      } else if (ts.isImportDeclaration(statement) && ts.isSourceFile(scope)) {
        const clause = statement.importClause;
        if (clause === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const module = this.resolveModule(scope.fileName, statement.moduleSpecifier.text);
        if (clause.name?.text === name) return { kind: 'import', module, name: 'default' };
        const bindings = clause.namedBindings;
        if (bindings === undefined) continue;
        if (ts.isNamespaceImport(bindings)) {
          if (bindings.name.text === name) return { kind: 'import', module, name: '*' };
        } else {
          for (const element of bindings.elements) {
            if (element.name.text === name) {
              return { kind: 'import', module, name: (element.propertyName ?? element.name).text };
            }
          }
        }
      }
    }
    return undefined;
  }

  /** 模块导出的翻译函数（含 `export { x as y }` 与转出）。 */
  private exportedTranslator(
    file: string,
    name: string,
    seen = new Set<string>(),
  ): Translator | undefined {
    const key = `${file}#${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const module = this.modules.get(file);
    if (module === undefined) return undefined;
    for (const statement of module.source.statements) {
      if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement)) {
        if (statement.name?.text === name) return this.translators.get(statement);
      } else if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
            return this.translators.get(declaration);
          }
        }
      } else if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
        if (!ts.isNamedExports(statement.exportClause)) continue;
        for (const element of statement.exportClause.elements) {
          if (element.name.text !== name) continue;
          const local = (element.propertyName ?? element.name).text;
          if (
            statement.moduleSpecifier !== undefined &&
            ts.isStringLiteral(statement.moduleSpecifier)
          ) {
            const target = this.resolveModule(file, statement.moduleSpecifier.text);
            return target === undefined ? undefined : this.exportedTranslator(target, local, seen);
          }
          const binding = this.lookupTop(module.source, local);
          return binding === undefined ? undefined : this.bindingTranslator(binding, seen);
        }
      }
    }
    return undefined;
  }

  private lookupTop(source: ts.SourceFile, name: string): Binding | undefined {
    return this.findInStatements(source.statements, name, source);
  }

  private bindingTranslator(binding: Binding, seen?: Set<string>): Translator | undefined {
    switch (binding.kind) {
      case 'import':
        if (binding.module === undefined || binding.name === '*') return undefined;
        return this.exportedTranslator(binding.module, binding.name, seen);
      case 'function':
        return this.translators.get(binding.declaration);
      case 'const':
        return this.translators.get(binding.declaration);
      default:
        return undefined;
    }
  }

  /** 调用目标若是翻译函数，返回其键参数位置。 */
  private calleeTranslator(callee: ts.Expression): Translator | undefined {
    const target = unwrap(callee);
    if (ts.isIdentifier(target)) {
      const binding = this.lookup(target);
      return binding === undefined ? undefined : this.bindingTranslator(binding);
    }
    if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
      const binding = this.lookup(target.expression);
      if (binding?.kind === 'import' && binding.name === '*' && binding.module !== undefined) {
        return this.exportedTranslator(binding.module, target.name.text);
      }
    }
    return undefined;
  }

  /** 求键表达式的静态形状。 */
  private evaluate(expression: ts.Expression, depth = 0): KeyValue {
    if (depth > 32) return { kind: 'unknown' };
    const node = unwrap(expression);
    if (ts.isStringLiteralLike(node)) return { kind: 'shapes', shapes: [node.text] };
    if (ts.isTemplateExpression(node)) {
      let shapes = [node.head.text];
      for (const span of node.templateSpans) {
        shapes = this.concat(shapes, this.part(span.expression, depth));
        shapes = this.concat(shapes, [span.literal.text]);
      }
      return this.limit(shapes);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return this.limit(this.concat(this.part(node.left, depth), this.part(node.right, depth)));
    }
    if (ts.isConditionalExpression(node)) {
      const whenTrue = this.evaluate(node.whenTrue, depth + 1);
      const whenFalse = this.evaluate(node.whenFalse, depth + 1);
      if (whenTrue.kind !== 'shapes' || whenFalse.kind !== 'shapes') return { kind: 'unknown' };
      return this.limit([...whenTrue.shapes, ...whenFalse.shapes]);
    }
    if (ts.isIdentifier(node)) {
      const binding = this.lookup(node);
      if (binding === undefined) return { kind: 'unknown' };
      if (binding.kind === 'const') {
        const init = binding.declaration.initializer;
        return init === undefined ? { kind: 'unknown' } : this.evaluate(init, depth + 1);
      }
      if (binding.kind === 'param') {
        return { kind: 'param', fn: binding.fn, index: binding.index, rest: binding.rest };
      }
      if (binding.kind === 'forOf') {
        // `for (const key of keys)`，keys 是外层函数的剩余参数：等同把每个实参原样当键。
        const iterated = unwrap(binding.statement.expression);
        if (ts.isIdentifier(iterated)) {
          const source = this.lookup(iterated);
          if (source?.kind === 'param' && source.rest) {
            return { kind: 'param', fn: source.fn, index: source.index, rest: true };
          }
        }
      }
    }
    return { kind: 'unknown' };
  }

  /** 模板片段或拼接操作数：求不出有限形状的部分记为占位（任意串）。 */
  private part(expression: ts.Expression, depth: number): string[] {
    const value = this.evaluate(expression, depth + 1);
    return value.kind === 'shapes' ? value.shapes : [HOLE];
  }

  private concat(left: readonly string[], right: readonly string[]): string[] {
    const out: string[] = [];
    for (const a of left) for (const b of right) out.push(a + b);
    return out.length > MAX_SHAPES * 4 ? out.slice(0, MAX_SHAPES + 1) : out;
  }

  private limit(shapes: string[]): KeyValue {
    const unique = [...new Set(shapes)];
    return unique.length > MAX_SHAPES ? { kind: 'unknown' } : { kind: 'shapes', shapes: unique };
  }

  /** 把参数原样当键的函数登记为包装函数；匿名函数无法追踪调用点，返回 false。 */
  private promote(fn: ts.SignatureDeclaration, index: number, rest: boolean): boolean {
    let declaration: ts.Node | undefined;
    if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) {
      declaration = fn;
    } else if (
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      ts.isVariableDeclaration(fn.parent) &&
      ts.isIdentifier(fn.parent.name) &&
      ts.isVariableDeclarationList(fn.parent.parent) &&
      (fn.parent.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      declaration = fn.parent;
    }
    if (declaration === undefined) return false;
    const existing = this.translators.get(declaration);
    if (existing !== undefined) return existing.index === index && existing.rest === rest;
    this.translators.set(declaration, { index, rest });
    this.changed = true;
    return true;
  }

  private checkKey(
    argument: ts.Expression,
    result: { literals: Set<string>; errors: string[]; patterns: readonly RegExp[] } | undefined,
  ): void {
    const value = this.evaluate(argument);
    if (value.kind === 'param') {
      if (!this.promote(value.fn, value.index, value.rest)) {
        result?.errors.push(
          `${location(argument)}: 文案键来自无法追踪调用点的函数参数，未登记（unregistered）：${argument.getText()}`,
        );
      }
      return;
    }
    if (result === undefined) return;
    if (value.kind === 'unknown') {
      result.errors.push(
        `${location(argument)}: 无法静态确定的文案键，未登记（unregistered）：${argument.getText()}`,
      );
      return;
    }
    for (const shape of value.shapes) {
      if (!shape.includes(HOLE)) {
        result.literals.add(shape);
      } else if (!result.patterns.some((pattern) => pattern.test(shape))) {
        result.errors.push(
          `${location(argument)}: 动态文案键 "${shape.replaceAll(HOLE, '*')}" 未登记（unregistered），` +
            `请在 ${REGISTRY_MODULE} 的 ${REGISTRY_EXPORT} 登记键族`,
        );
      }
    }
  }

  private scan(
    module: ParsedModule,
    result: { literals: Set<string>; errors: string[]; patterns: readonly RegExp[] } | undefined,
  ): void {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const translator = this.calleeTranslator(node.expression);
        if (translator !== undefined) {
          const args = node.arguments;
          const end = translator.rest ? args.length : Math.min(args.length, translator.index + 1);
          for (let index = 0; index < end; index += 1) {
            const argument = args[index]!;
            if (ts.isSpreadElement(argument)) {
              result?.errors.push(
                `${location(argument)}: 展开实参作文案键，无法静态确定，未登记（unregistered）`,
              );
              break;
            }
            if (index >= translator.index) this.checkKey(argument, result);
          }
        }
      } else if (result !== undefined) {
        if (ts.isStringLiteralLike(node)) result.literals.add(node.text);
        if (ts.isIdentifier(node)) this.checkEscape(node, result);
      }
      ts.forEachChild(node, visit);
    };
    visit(module.source);
  }

  /** 翻译函数只能被直接调用：当值传出（回调、赋给变量、放进对象）就追踪不到键，报错。 */
  private checkEscape(id: ts.Identifier, result: { errors: string[] }): void {
    if (!this.isValueReference(id)) return;
    const binding = this.lookup(id);
    if (binding === undefined || this.bindingTranslator(binding) === undefined) return;
    const parent = id.parent;
    if (ts.isCallExpression(parent) && unwrap(parent.expression) === id) return;
    let callee: ts.Node = id;
    while (
      ts.isParenthesizedExpression(callee.parent) ||
      ts.isAsExpression(callee.parent) ||
      ts.isNonNullExpression(callee.parent)
    ) {
      callee = callee.parent;
    }
    if (ts.isCallExpression(callee.parent) && callee.parent.expression === callee) return;
    result.errors.push(
      `${location(id)}: 翻译函数 ${id.text} 被当作值传出，键无法静态追踪，未登记（unregistered）`,
    );
  }

  private isValueReference(id: ts.Identifier): boolean {
    const parent = id.parent;
    if (
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isQualifiedName(parent) ||
      ts.isJsxAttribute(parent) ||
      ts.isLabeledStatement(parent) ||
      ts.isBreakOrContinueStatement(parent)
    ) {
      return false;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
    if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
    if (
      (ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isInterfaceDeclaration(parent) ||
        ts.isTypeAliasDeclaration(parent) ||
        ts.isEnumDeclaration(parent) ||
        ts.isEnumMember(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent)) &&
      parent.name === id
    ) {
      return false;
    }
    for (let node: ts.Node = parent; !ts.isSourceFile(node); node = node.parent) {
      if (ts.isTypeNode(node)) return false;
      if (ts.isStatement(node) || ts.isBlock(node)) break;
    }
    return true;
  }
}

/**
 * Build-time seam: collect literal references and explicitly registered dynamic uses across
 * sourceRoot, retaining their texts and fallbacks. Reject uncovered nonliteral translation
 * arguments, including variables and wrapper calls. The Vite plugin (trim-texts-plugin.ts)
 * replaces the contract dictionary only during builds; without the plugin (including Vitest),
 * shared/texts.ts still loads the complete contract dictionary.
 */
export function collectH5Texts(options: CollectH5TextsOptions): TrimTextDictionary {
  const { sourceRoot, dictionary } = options;
  const registered = readRegistry(sourceRoot);
  const patterns = registered.map(patternRegExp);
  const { literals, errors } = new Collector(sourceRoot).run(patterns);
  if (errors.length > 0) {
    throw new Error(
      `H5 字典裁剪：发现未登记（unregistered）的动态文案键，构建失败：\n${errors.join('\n')}`,
    );
  }
  const keep = (key: string): boolean =>
    literals.has(key) || patterns.some((pattern) => pattern.test(key));
  const pick = (record: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => keep(key)));
  return { texts: pick(dictionary.texts), fallbacks: pick(dictionary.fallbacks) };
}
