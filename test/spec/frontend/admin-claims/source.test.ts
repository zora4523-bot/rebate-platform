// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const moduleUrl = import.meta.url;
const root = resolve(fileURLToPath(new URL('.', moduleUrl)), '../../../../apps/admin/src');
const directory = join(root, 'pages/claims');
const COLOR = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i;
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

it('[AC-F1-07f-SOURCE#1] 页面实际使用 antd 表格、筛选、页签、计数和 Result，不拼 ant 类名、不写字面色值或直接 fetch', () => {
  const rendered = new Set<string>();
  const violations: string[] = [];
  const expected = ['Table', 'Select', 'Input', 'Tabs', 'Badge', 'Button', 'Result'];
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
        for (const component of expected)
          bindings.set(`${named.name.text}.${component}`, component);
      }
    }
    function component(tag: string): void {
      for (const [local, original] of bindings)
        if (tag === local || tag.startsWith(`${local}.`)) rendered.add(original);
    }
    visit(file, (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
        component(node.tagName.getText(file));
      if (
        ts.isCallExpression(node) &&
        /(?:^|\.)(?:createElement|jsx|jsxs|jsxDEV)$/.test(node.expression.getText(file)) &&
        node.arguments[0]
      )
        component(node.arguments[0].getText(file));
      if (ts.isIdentifier(node) && /^(fetch|XMLHttpRequest|getPrefixCls)$/.test(node.text))
        violations.push(`forbidden API ${node.text}`);
      if (
        (ts.isStringLiteralLike(node) &&
          !(
            (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
            node.parent.moduleSpecifier === node
          )) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        if (/\bant-/.test(node.text)) violations.push(`handwritten antd class ${node.text}`);
        if (COLOR.test(node.text)) violations.push(`literal color ${node.text}`);
        if (
          ts.isPropertyAssignment(node.parent) &&
          /color|background|border|fill|stroke|shadow/i.test(node.parent.name.getText(file))
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
  // Positive assertions keep a missing implementation red, even though it has no forbidden API.
  for (const name of expected) expect(rendered.has(name), name).toBe(true);
  expect(violations).toEqual([]);
});

it('[AC-F1-07f-SOURCE#2] 画板与审核文案集中于 texts/claims.ts，页面通过现有 data provider 或 admin API 层请求', () => {
  const dictionary = join(root, 'texts/claims.ts');
  expect(existsSync(dictionary), 'claims text registry').toBe(true);
  const copy = readFileSync(dictionary, 'utf8');
  for (const text of [
    '用户填写',
    '联盟回传',
    '证据核实一致',
    '订单已被自动归属',
    '订单已失效，已按系统原因驳回',
    '没有符合条件的找回申请',
    '列表加载失败',
    '重试',
  ])
    expect(copy).toContain(text);
  expect(copy).toMatch(/锁定/);
  expect(copy).toMatch(/不能撤销|不可撤销/);
  const imports: string[] = [];
  const identifiers: string[] = [];
  for (const file of sources())
    visit(file, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause?.isTypeOnly &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (ts.isIdentifier(node)) identifiers.push(node.text);
    });
  expect(imports.some((path) => /texts\/claims\.ts$/.test(path))).toBe(true);
  expect(
    identifiers.includes('custom') ||
      identifiers.includes('useCustom') ||
      identifiers.includes('useList') ||
      imports.some((path) => /providers\/admin-api\.ts$/.test(path)),
  ).toBe(true);
});
