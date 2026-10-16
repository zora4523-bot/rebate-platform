// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/admin/src/pages/admins',
);

function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
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
      for (const item of named.elements) {
        if (!item.isTypeOnly && (item.propertyName ?? item.name).text === imported)
          names.add(item.name.text);
      }
    } else if (named && ts.isNamespaceImport(named)) {
      names.add(`${named.name.text}.${imported}`);
    }
  }
  return names;
}

it('[AC-F1-06i-SOURCE#1] 页面 JSX 使用真实 antd Table，不手写基础控件、ant 类名或 CSS 皮肤', () => {
  const paths = files(root);
  const sourceFiles = paths
    .filter((path) => /\.tsx?$/.test(path) && !/\.(?:test|gen|d)\.tsx?$/.test(path))
    .map((path) =>
      ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      ),
    );
  const forbidden = new Set([
    'table',
    'thead',
    'tbody',
    'tr',
    'td',
    'th',
    'ul',
    'li',
    'button',
    'input',
  ]);
  const violations: string[] = [];
  let rendersTable = false;
  for (const file of sourceFiles) {
    const tables = bindings(file, 'antd', 'Table');
    const factories = new Set(['createElement', 'jsx', 'jsxs', 'jsxDEV']);
    for (const module of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime']) {
      for (const factory of ['createElement', 'jsx', 'jsxs', 'jsxDEV']) {
        for (const name of bindings(file, module, factory)) factories.add(name);
      }
    }
    visit(file, (node) => {
      const location = () =>
        `${relative(root, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(file);
        if (tables.has(tag)) rendersTable = true;
        if (forbidden.has(tag)) violations.push(`${location()}: native JSX ${tag}`);
      }
      if (
        (ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        /\bant-/.test(node.text)
      )
        violations.push(`${location()}: handwritten antd class ${node.text}`);
      if (ts.isCallExpression(node)) {
        const called = node.expression;
        const first = node.arguments[0];
        if (
          (factories.has(called.getText(file)) ||
            (ts.isPropertyAccessExpression(called) && factories.has(called.name.text))) &&
          first &&
          ts.isStringLiteralLike(first) &&
          forbidden.has(first.text)
        )
          violations.push(`${location()}: native factory ${first.text}`);
      }
    });
  }
  for (const path of paths.filter((file) => file.endsWith('.css'))) {
    const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/\.ant-|\[[^\]]*ant-[^\]]*\]/i.test(css))
      violations.push(`${relative(root, path)}: antd selector`);
    if (/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i.test(css)) {
      violations.push(`${relative(root, path)}: literal color`);
    }
    // Named colors (including in shorthands) are parsed by the browser's CSS grammar;
    // variables and CSS-wide/currentColor keywords remain usable theme-driven values.
    const probe = document.createElement('span').style;
    const declarations = css.matchAll(/(?:^|[;{])\s*(?:--)?[\w-]+\s*:\s*([^;{}]+)/g);
    for (const declaration of declarations) {
      const value = declaration[1]!.replace(/var\([^)]*\)/g, '');
      for (const token of value.matchAll(/\b[a-z]+\b/gi)) {
        if (/^(?:inherit|initial|unset|revert|currentcolor|transparent)$/i.test(token[0])) continue;
        probe.color = '';
        probe.color = token[0];
        if (probe.color !== '') violations.push(`${relative(root, path)}: named color ${token[0]}`);
      }
    }
  }
  // One cohesive rule: the skeleton must fail positively for missing antd Table, even
  // though its empty implementation already satisfies all the negative constraints.
  expect(rendersTable, 'pages/admins must import Table from antd and render it as JSX').toBe(true);
  expect(violations).toEqual([]);
});
