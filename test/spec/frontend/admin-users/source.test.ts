// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const moduleUrl = import.meta.url;
const root = resolve(fileURLToPath(new URL('.', moduleUrl)), '../../../../apps/admin/src');
const directory = join(root, 'pages/users');
function files(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}
function sources(): ts.SourceFile[] {
  return files(directory)
    .filter((path) => /\.tsx?$/.test(path) && !/\.(test|d)\.tsx?$/.test(path))
    .map((path) =>
      ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      ),
    );
}
function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}
function moduleName(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  return (
    ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
      parent.moduleSpecifier === node) ||
    ts.isExternalModuleReference(parent) ||
    (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) ||
    (ts.isCallExpression(parent) &&
      parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
      parent.arguments[0] === node)
  );
}
const COMPONENTS = ['Table', 'List', 'Input', 'Select', 'Button', 'Tag', 'Alert', 'Typography'];
const NATIVE = new Set([
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'ul',
  'ol',
  'li',
  'button',
  'input',
  'select',
  'textarea',
  'dialog',
]);
const COLOR = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i;

it('[AC-F1-07i-SOURCE#1] 页面实际渲染 antd 的表格、Input、Select、Button、Tag，不手写控件/ant 类名/色值/fetch', () => {
  const rendered = new Set<string>();
  const violations: string[] = [];
  for (const file of sources()) {
    const bindings = new Map<string, string>();
    for (const statement of file.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== 'antd' ||
        statement.importClause?.isTypeOnly
      )
        continue;
      const named = statement.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const entry of named.elements) {
          const imported = (entry.propertyName ?? entry.name).text;
          if (!entry.isTypeOnly && COMPONENTS.includes(imported))
            bindings.set(entry.name.text, imported);
        }
      } else if (named && ts.isNamespaceImport(named)) {
        for (const component of COMPONENTS)
          bindings.set(`${named.name.text}.${component}`, component);
      }
    }
    function component(tag: string): void {
      for (const [name, imported] of bindings)
        if (tag === name || tag.startsWith(`${name}.`)) rendered.add(imported);
      if (NATIVE.has(tag)) violations.push(`native control ${tag}`);
    }
    visit(file, (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
        component(node.tagName.getText(file));
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(file);
        if (/(?:^|\.)(?:createElement|jsx|jsxs|jsxDEV)$/.test(name) && node.arguments[0]) {
          const first = node.arguments[0];
          component(ts.isStringLiteralLike(first) ? first.text : first.getText(file));
        }
      }
      if (
        ts.isIdentifier(node) &&
        /^(?:fetch|XMLHttpRequest|innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|getPrefixCls|ConfigContext)$/.test(
          node.text,
        )
      )
        violations.push(`forbidden API ${node.text}`);
      if (
        ts.isIdentifier(node) &&
        /balance|withdraw|payout|identity_number|real_name|relation_id|^orders?$|^ledger$/i.test(
          node.text,
        )
      )
        violations.push(`field outside user contract ${node.text}`);
      if (
        (ts.isStringLiteralLike(node) && !moduleName(node)) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        if (
          /balance|withdraw|payout|identity_number|real_name|relation_id|^orders?$|^ledger$/i.test(
            node.text,
          )
        )
          violations.push(`field outside user contract ${node.text}`);
        if (/\bant-/.test(node.text)) violations.push(`handwritten class ${node.text}`);
        if (COLOR.test(node.text)) violations.push(`literal color ${node.text}`);
        const parent = node.parent;
        const colorProperty =
          ts.isPropertyAssignment(parent) &&
          /color|background|border|fill|stroke|shadow/i.test(parent.name.getText(file));
        if (colorProperty || /var\(/.test(node.text)) {
          const probe = document.createElement('span').style;
          for (const token of node.text.replace(/--[\w-]+/g, '').matchAll(/\b[a-z]+\b/gi)) {
            if (/^(inherit|initial|unset|revert|currentcolor|transparent)$/i.test(token[0]))
              continue;
            probe.color = '';
            probe.color = token[0];
            if (probe.color !== '') violations.push(`named color ${token[0]}`);
          }
        }
        if (/[\u3400-\u9fff]/u.test(node.text)) violations.push(`copy outside texts ${node.text}`);
        if (
          /^(?:switch|dialog)$/.test(node.text) &&
          ts.isJsxAttribute(node.parent) &&
          node.parent.name.getText(file) === 'role'
        )
          violations.push(`handwritten role ${node.text}`);
      }
      if (ts.isJsxText(node) && /[\u3400-\u9fff]/u.test(node.text))
        violations.push(`JSX copy ${node.text}`);
    });
  }
  for (const path of files(directory).filter((file) => file.endsWith('.css'))) {
    const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/\bant-/.test(css)) violations.push(`antd selector ${path}`);
    if (COLOR.test(css)) violations.push(`literal color ${path}`);
    // Check named colors too, including var(--token, red) fallbacks.
    const probe = document.createElement('span').style;
    for (const declaration of css.matchAll(/(?:^|[;{])\s*[\w-]+\s*:\s*([^;{}]+)/g)) {
      const value = declaration[1]!.replace(/--[\w-]+/g, '');
      for (const token of value.matchAll(/\b[a-z]+\b/gi)) {
        if (/^(inherit|initial|unset|revert|currentcolor|transparent)$/i.test(token[0])) continue;
        probe.color = '';
        probe.color = token[0];
        if (probe.color !== '') violations.push(`named color ${token[0]}`);
      }
    }
  }
  // Positive assertions make the empty skeleton red, rather than vacuously passing bans.
  expect(rendered.has('Table') || rendered.has('List')).toBe(true);
  for (const component of ['Input', 'Select', 'Button', 'Tag'])
    expect(rendered.has(component), component).toBe(true);
  expect(violations).toEqual([]);
});

it('[AC-F1-07i-SOURCE#2] 页面使用独立文案字典及已上线的 StepUpModal，写入经 data provider custom', () => {
  const dictionary = join(root, 'texts/users.ts');
  expect(existsSync(dictionary), 'texts/users.ts').toBe(true);
  const imported: string[] = [];
  const apis: string[] = [];
  for (const file of sources())
    visit(file, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause?.isTypeOnly &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imported.push(node.moduleSpecifier.text);
      if (ts.isIdentifier(node)) apis.push(node.text);
    });
  expect(imported.some((name) => /texts\/users\.ts$/.test(name))).toBe(true);
  expect(imported.some((name) => /components\/step-up(?:\/|$)/.test(name))).toBe(true);
  expect(apis).toContain('StepUpModal');
  expect(apis).toContain('custom');
  expect(apis).toContain('stepUpToken');
});
