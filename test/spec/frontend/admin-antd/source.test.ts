// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/admin/src');
const componentDirectories = ['layout', 'pages/login', 'components/otp-input'];

function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function read(path: string): string {
  expect(existsSync(path), relative(root, path)).toBe(true);
  return readFileSync(path, 'utf8');
}

function ast(path: string): ts.SourceFile {
  return ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}

function components(): ts.SourceFile[] {
  return [
    join(root, 'App.tsx'),
    ...componentDirectories.flatMap((directory) => files(join(root, directory))),
  ]
    .filter((path) => path.endsWith('.tsx') && !/\.(?:test|gen|d)\.tsx$/.test(path))
    .map(ast);
}

function location(file: ts.SourceFile, node: ts.Node): string {
  return `${relative(root, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
}

function bindings(file: ts.SourceFile, module: string, imported: string): Set<string> {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.importClause?.isTypeOnly ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== module
    )
      continue;
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const item of named.elements)
        if (!item.isTypeOnly && (item.propertyName ?? item.name).text === imported)
          names.add(item.name.text);
    } else if (named && ts.isNamespaceImport(named)) names.add(`${named.name.text}.${imported}`);
  }
  return names;
}

function rendersAntd(file: ts.SourceFile, component: string): boolean {
  const imported = bindings(file, 'antd', component);
  const members =
    component === 'Layout'
      ? ['Sider', 'Header', 'Content']
      : component === 'Input'
        ? ['Password']
        : [];
  const renderedNames = new Set(imported);
  for (const name of imported) for (const member of members) renderedNames.add(`${name}.${member}`);
  // Accept e.g. const { Sider: Sidebar } = Layout, but never an unrelated local Sider.
  visit(file, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isObjectBindingPattern(node.name) ||
      !node.initializer ||
      !imported.has(node.initializer.getText(file))
    )
      return;
    for (const element of node.name.elements) {
      if (
        !element.dotDotDotToken &&
        !element.initializer &&
        ts.isIdentifier(element.name) &&
        members.includes((element.propertyName ?? element.name).getText(file))
      )
        renderedNames.add(element.name.text);
    }
  });
  let rendered = false;
  visit(file, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      renderedNames.has(node.tagName.getText(file))
    )
      rendered = true;
  });
  return rendered;
}

// Follow the actual theme prop through direct calls, local aliases, or React's memo/state
// initializers. Merely importing/calling the factory somewhere else does not establish wiring.
function expectThemeWiring(file: ts.SourceFile): void {
  const providers = bindings(file, 'antd', 'ConfigProvider');
  const factories = bindings(file, './theme.ts', 'createAntdTheme');
  const hooks = new Set([
    ...bindings(file, 'react', 'useState'),
    ...bindings(file, 'react', 'useMemo'),
  ]);
  const values = new Map<string, ts.Expression>();
  visit(file, (node) => {
    if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return;
    if (ts.isIdentifier(node.name)) values.set(node.name.text, node.initializer);
    if (ts.isArrayBindingPattern(node.name)) {
      const first = node.name.elements[0];
      if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name))
        values.set(first.name.text, node.initializer);
    }
  });
  function fromFactory(expression: ts.Expression | undefined, depth = 0): boolean {
    if (expression === undefined || depth > 12) return false;
    if (ts.isIdentifier(expression)) return fromFactory(values.get(expression.text), depth + 1);
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    )
      return fromFactory(expression.expression, depth + 1);
    if (ts.isCallExpression(expression)) {
      if (factories.has(expression.expression.getText(file))) return true;
      if (hooks.has(expression.expression.getText(file))) {
        const initializer = expression.arguments[0];
        if (initializer && factories.has(initializer.getText(file))) return true;
        return fromFactory(initializer, depth + 1);
      }
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      if (!ts.isBlock(expression.body)) return fromFactory(expression.body, depth + 1);
      const returns = expression.body.statements.filter(ts.isReturnStatement);
      return (
        returns.length > 0 &&
        returns.every((statement) => fromFactory(statement.expression, depth + 1))
      );
    }
    return false;
  }
  const roots: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  visit(file, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      providers.has(node.tagName.getText(file))
    )
      roots.push(node);
  });
  expect(roots.length, 'App must render the imported antd ConfigProvider').toBeGreaterThan(0);
  for (const provider of roots) {
    const attributes = provider.attributes.properties;
    const index = attributes.findLastIndex(
      (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'theme',
    );
    const theme = attributes[index];
    expect(theme && ts.isJsxAttribute(theme), 'ConfigProvider theme prop').toBe(true);
    if (!theme || !ts.isJsxAttribute(theme)) continue;
    const initializer = theme.initializer;
    expect(
      initializer && ts.isJsxExpression(initializer) && fromFactory(initializer.expression),
      'theme comes from theme.ts createAntdTheme',
    ).toBe(true);
    expect(
      attributes.slice(index + 1).some(ts.isJsxSpreadAttribute),
      'theme cannot be overwritten by a later spread',
    ).toBe(false);
  }
}

it('[AC-F1-06p-SOURCE#1] TSX 不自建基础控件或 portal，App 保留 antd 主题接线', () => {
  const forbidden = new Set([
    'input',
    'button',
    'select',
    'textarea',
    'form',
    'ul',
    'ol',
    'li',
    'svg',
  ]);
  const violations: string[] = [];
  const sourceFiles = components();
  for (const file of sourceFiles) {
    const portals = bindings(file, 'react-dom', 'createPortal');
    const factories = new Set(['createElement', 'jsx', 'jsxs', 'jsxDEV']);
    for (const module of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'])
      for (const name of ['createElement', 'jsx', 'jsxs', 'jsxDEV'])
        for (const binding of bindings(file, module, name)) factories.add(binding);
    visit(file, (node) => {
      if (
        (ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        /(^|[\s"'`])ant-/.test(node.text)
      )
        violations.push(`${location(file, node)}: handwritten antd class ${node.text}`);
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        forbidden.has(node.tagName.getText(file))
      )
        violations.push(`${location(file, node)}: native ${node.tagName.getText(file)}`);
      if (ts.isCallExpression(node)) {
        const called = node.expression;
        const tag = node.arguments[0];
        if (
          (factories.has(called.getText(file)) ||
            (ts.isPropertyAccessExpression(called) && factories.has(called.name.text))) &&
          tag &&
          ts.isStringLiteralLike(tag) &&
          forbidden.has(tag.text)
        )
          violations.push(`${location(file, node)}: native factory ${tag.text}`);
        if (
          portals.has(called.getText(file)) ||
          (ts.isIdentifier(called) && called.text === 'createPortal') ||
          (ts.isPropertyAccessExpression(called) && called.name.text === 'createPortal')
        )
          violations.push(`${location(file, node)}: createPortal`);
      }
    });
  }
  // Count imported JSX components across each area, not separately in every file.
  const regions = [
    { paths: ['App.tsx', 'layout/'], required: ['Layout', 'Menu', 'Breadcrumb'] },
    { paths: ['pages/login/'], required: ['Form', 'Steps', 'Alert', 'Button', 'Input'] },
    { paths: ['components/otp-input/'], required: ['Input'] },
  ];
  for (const region of regions) {
    const areaFiles = sourceFiles.filter((file) =>
      region.paths.some((path) => {
        const name = relative(root, file.fileName);
        return path.endsWith('/') ? name.startsWith(path) : name === path;
      }),
    );
    for (const component of region.required)
      if (!areaFiles.some((file) => rendersAntd(file, component)))
        violations.push(`${region.paths.join(' + ')}: must render imported antd ${component}`);
  }
  // The existing theme wiring is intentionally grouped with the still-red migration rule.
  expectThemeWiring(ast(join(root, 'App.tsx')));
  expect(violations).toEqual([]);
});

it('[AC-F1-06p-SOURCE#2] className 不再引用手写表单、菜单和反馈皮肤', () => {
  const forbidden =
    /login-field|login-button|login-steps|login-step|login-banner|login-tag|login-env-tag|admin-menu|admin-button|admin-card|admin-empty/;
  const violations: string[] = [];
  for (const file of components()) {
    visit(file, (node) => {
      if (!ts.isJsxAttribute(node) || node.name.getText(file) !== 'className') return;
      visit(node, (value) => {
        if (
          (ts.isStringLiteralLike(value) ||
            ts.isTemplateHead(value) ||
            ts.isTemplateMiddle(value) ||
            ts.isTemplateTail(value)) &&
          forbidden.test(value.text)
        )
          violations.push(`${location(file, value)}: ${value.text}`);
      });
    });
  }
  expect(violations).toEqual([]);
});

it('[AC-F1-06p-SOURCE#3] 局部 CSS 合计至多 150 个非空行，只留令牌布局且不重绘基础控件', () => {
  // styles/admin.css belongs to this migration too; otherwise moving the old skin there
  // would evade the budget while leaving the shell's handwritten component styles intact.
  const paths = [
    ...files(root).filter((path) => dirname(path) === root),
    ...[...componentDirectories, 'styles'].flatMap((directory) => files(join(root, directory))),
  ].filter((path) => path.endsWith('.css'));
  const violations: string[] = [];
  let lines = 0;
  for (const path of paths) {
    const source = read(path);
    lines += source.split(/\r?\n/).filter((line) => line.trim() !== '').length;
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
    if (/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i.test(css))
      violations.push(`${relative(root, path)}: literal color`);
    for (const rule of css.matchAll(/(?:^|(?<=[{};]))\s*([^{};]+)\{/g)) {
      for (const selector of rule[1]!.split(',')) {
        const trimmed = selector.trim();
        if (
          /\.ant-|\[[^\]]*ant-[^\]]*\]/i.test(trimmed) ||
          /(?:^|[\s>+~,(])(?:input|button)(?=[\s.#:[>+~),]|$)/i.test(trimmed)
        )
          violations.push(`${relative(root, path)}: ${trimmed}`);
      }
    }
  }
  expect(violations).toEqual([]);
  expect(lines, paths.map((path) => relative(root, path)).join(', ')).toBeLessThanOrEqual(150);
});
