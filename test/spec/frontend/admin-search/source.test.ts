// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { FOOTER, NO_HIT_FOOTER, PLACEHOLDER } from './search-fixtures.ts';

const moduleUrl = import.meta.url;
const root = resolve(fileURLToPath(new URL('.', moduleUrl)), '../../../../apps/admin/src');
const directory = join(root, 'components/search');
const COLOR = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i;
function files(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}
function sources(): ts.SourceFile[] {
  return [...files(directory), join(root, 'layout/TopBar.tsx')]
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
  return (
    (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
    node.parent.moduleSpecifier === node
  );
}
function namedColors(value: string): string[] {
  const probe = document.createElement('span').style;
  const found: string[] = [];
  for (const token of value.replace(/--[\w-]+/g, '').matchAll(/\b[a-z]+\b/gi)) {
    if (/^(inherit|initial|unset|revert|currentcolor|transparent)$/i.test(token[0])) continue;
    probe.color = '';
    probe.color = token[0];
    if (probe.color !== '') found.push(token[0]);
  }
  return found;
}

it('[AC-F1-07h-SOURCE#1] 搜索实际使用 antd Input.Search、Dropdown、List 与 Typography，不拼 ant 类名或字面色值', () => {
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
        for (const entry of named.elements)
          if (!entry.isTypeOnly)
            bindings.set(entry.name.text, (entry.propertyName ?? entry.name).text);
      } else if (named && ts.isNamespaceImport(named)) {
        for (const name of ['Input', 'Dropdown', 'List', 'Typography'])
          bindings.set(`${named.name.text}.${name}`, name);
      }
    }
    function component(tag: string): void {
      for (const [local, original] of bindings) {
        if (tag === local || tag.startsWith(`${local}.`)) rendered.add(original);
        if (original === 'Input' && tag === `${local}.Search`) rendered.add('Input.Search');
      }
      if (/^(input|button|select|textarea|ul|ol|li|dialog)$/.test(tag))
        violations.push(`native control ${tag}`);
    }
    visit(file, (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
        component(node.tagName.getText(file));
      if (
        ts.isCallExpression(node) &&
        /(?:^|\.)(?:createElement|jsx|jsxs|jsxDEV)$/.test(node.expression.getText(file)) &&
        node.arguments[0]
      ) {
        const first = node.arguments[0];
        component(ts.isStringLiteralLike(first) ? first.text : first.getText(file));
      }
      if (
        ts.isIdentifier(node) &&
        /^(fetch|XMLHttpRequest|innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|getPrefixCls)$/.test(
          node.text,
        )
      )
        violations.push(`forbidden API ${node.text}`);
      if (
        (ts.isStringLiteralLike(node) && !moduleName(node)) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        if (/\bant-/.test(node.text)) violations.push(`handwritten antd class ${node.text}`);
        if (COLOR.test(node.text)) violations.push(`literal color ${node.text}`);
        if (
          (ts.isPropertyAssignment(node.parent) &&
            /color|background|border|fill|stroke|shadow/i.test(node.parent.name.getText(file))) ||
          /var\(/.test(node.text)
        )
          violations.push(...namedColors(node.text).map((name) => `named color ${name}`));
        if (/[\u3400-\u9fff]/u.test(node.text)) violations.push(`copy outside texts ${node.text}`);
      }
      if (ts.isJsxText(node) && /[\u3400-\u9fff]/u.test(node.text))
        violations.push(`JSX copy ${node.text}`);
    });
  }
  for (const path of files(directory).filter((path) => path.endsWith('.css'))) {
    const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/\bant-/.test(css) || COLOR.test(css)) violations.push(`forbidden CSS ${path}`);
    for (const declaration of css.matchAll(/(?:^|[;{])\s*[\w-]+\s*:\s*([^;{}]+)/g))
      violations.push(...namedColors(declaration[1]!).map((name) => `named CSS color ${name}`));
  }
  // Positive component checks make this test red on the empty skeleton.
  for (const component of ['Input.Search', 'Dropdown', 'List', 'Typography'])
    expect(rendered.has(component), component).toBe(true);
  expect(violations).toEqual([]);
});

it('[AC-F1-07h-SOURCE#2] 搜索文案来自 texts/search.ts 并经现有 data provider 或 admin API 层请求', () => {
  const dictionary = join(root, 'texts/search.ts');
  expect(existsSync(dictionary), 'search dictionary exists').toBe(true);
  const copy = readFileSync(dictionary, 'utf8');
  for (const text of [PLACEHOLDER, FOOTER, NO_HIT_FOOTER, '请输入更完整的号码', '没有找到'])
    expect(copy).toContain(text);
  const imported: string[] = [];
  const identifiers: string[] = [];
  for (const file of sources())
    visit(file, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause?.isTypeOnly &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imported.push(node.moduleSpecifier.text);
      if (ts.isIdentifier(node)) identifiers.push(node.text);
    });
  expect(imported.some((name) => /texts\/search\.ts$/.test(name))).toBe(true);
  expect(
    identifiers.includes('custom') ||
      identifiers.includes('useCustom') ||
      imported.some((name) => /providers\/admin-api\.ts$/.test(name)),
  ).toBe(true);
});
