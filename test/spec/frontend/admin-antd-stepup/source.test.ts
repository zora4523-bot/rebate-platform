// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/admin/src/components/step-up',
);

function files(directory: string): string[] {
  expect(existsSync(directory), directory).toBe(true);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function sources(): ts.SourceFile[] {
  const paths = files(root).filter(
    (path) => /\.tsx?$/.test(path) && !/\.(?:test|spec|d)\.tsx?$/.test(path),
  );
  expect(paths.length).toBeGreaterThan(0);
  return paths.map((path) =>
    ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true),
  );
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
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

it('[AC-F1-06r-SOURCE#1] step-up 从 antd 导入并以 JSX 渲染 Modal 和 Button', () => {
  const sourceFiles = sources();
  for (const component of ['Modal', 'Button']) {
    const rendered: string[] = [];
    for (const file of sourceFiles) {
      const names = bindings(file, 'antd', component);
      visit(file, (node) => {
        if (
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          names.has(node.tagName.getText(file))
        )
          rendered.push(location(file, node));
      });
    }
    expect(rendered.length, `render imported antd ${component}`).toBeGreaterThan(0);
  }
});

it('[AC-F1-06r-SOURCE#2] step-up 无手写 portal、原生基础控件或仿造的 ant 类名', () => {
  const forbidden = new Set(['button', 'input', 'form']);
  const violations: string[] = [];
  for (const file of sources()) {
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
        node.text.includes('ant-')
      )
        violations.push(`${location(file, node)}: handwritten ant- class`);
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        forbidden.has(node.tagName.getText(file))
      )
        violations.push(`${location(file, node)}: native ${node.tagName.getText(file)}`);
      if (!ts.isCallExpression(node)) return;
      const called = node.expression;
      const name = ts.isPropertyAccessExpression(called)
        ? called.name.text
        : ts.isElementAccessExpression(called) && ts.isStringLiteralLike(called.argumentExpression)
          ? called.argumentExpression.text
          : called.getText(file);
      if (portals.has(called.getText(file)) || name === 'createPortal')
        violations.push(`${location(file, node)}: createPortal`);
      const tag = node.arguments[0];
      if (
        (factories.has(called.getText(file)) || factories.has(name)) &&
        tag &&
        ts.isStringLiteralLike(tag) &&
        forbidden.has(tag.text)
      )
        violations.push(`${location(file, node)}: native factory ${tag.text}`);
    });
  }
  expect(violations).toEqual([]);
});

it('[AC-F1-06r-SOURCE#3] step-up.css 删除或至多 40 个非空行，目录内不覆盖 antd 选择器', () => {
  const violations: string[] = [];
  const cssFiles = files(root).filter((path) => path.endsWith('.css'));
  for (const path of cssFiles) {
    const css = readFileSync(path, 'utf8');
    const name = relative(root, path);
    if (name === 'step-up.css') {
      const lines = css.split(/\r?\n/).filter((line) => line.trim() !== '').length;
      if (lines > 40) violations.push(`${name}: ${lines} nonempty lines exceeds 40`);
    }
    if (/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/i.test(css))
      violations.push(`${name}: literal colour`);
    if (/\.ant-|\[\s*class\s*[*^$|~]?=\s*["']?[^\]]*ant-/i.test(css))
      violations.push(`${name}: antd selector override`);
  }
  // Also reject selectors hidden in CSS-in-JS strings or template fragments.
  for (const file of sources()) {
    visit(file, (node) => {
      if (
        (ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        /\.ant-|\[\s*class\s*[*^$|~]?=\s*["']?[^\]]*ant-/i.test(node.text)
      )
        violations.push(`${location(file, node)}: antd selector override`);
    });
  }
  expect(violations).toEqual([]);
});
