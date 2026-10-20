// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const moduleUrl = import.meta.url;
const root = resolve(fileURLToPath(new URL('.', moduleUrl)), '../../../../apps/admin/src');
const directory = join(root, 'pages/dashboard');
const dictionary = join(root, 'texts/dashboard.ts');
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
function isModule(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  return (
    ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
      parent.moduleSpecifier === node) ||
    (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword)
  );
}
const COMPONENTS = [
  'Typography',
  'Button',
  'Card',
  'Statistic',
  'Skeleton',
  'Result',
  'Tag',
  'Alert',
];
const COLOR = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i;
function namedColors(value: string): string[] {
  const probe = document.createElement('span').style;
  const result: string[] = [];
  for (const token of value.replace(/--[\w-]+/g, '').matchAll(/\b[a-z]+\b/gi)) {
    if (/^(inherit|initial|unset|revert|currentcolor|transparent)$/i.test(token[0])) continue;
    probe.color = '';
    probe.color = token[0];
    if (probe.color !== '') result.push(token[0]);
  }
  return result;
}

it('[AC-F1-14a-SOURCE#1] 实际渲染 antd 组件；不手写 ant 类名、字面颜色（含颜色名）、原生按钮或直接 fetch', () => {
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
        for (const component of COMPONENTS)
          bindings.set(`${named.name.text}.${component}`, component);
      }
    }
    function component(tag: string): void {
      for (const [name, imported] of bindings)
        if (tag === name || tag.startsWith(`${name}.`)) rendered.add(imported);
      if (['button', 'input', 'select', 'dialog'].includes(tag))
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
        /^(fetch|XMLHttpRequest|innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|getPrefixCls|ConfigContext)$/.test(
          node.text,
        )
      )
        violations.push(`forbidden API ${node.text}`);
      if (
        (ts.isStringLiteralLike(node) && !isModule(node)) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        if (/\bant-/.test(node.text)) violations.push(`handwritten class ${node.text}`);
        if (COLOR.test(node.text)) violations.push(`literal color ${node.text}`);
        // Exact color-name strings are forbidden even when assigned to a constant before styling.
        if (namedColors(node.text).includes(node.text)) violations.push(`named color ${node.text}`);
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
    if (/\bant-/.test(css)) violations.push(`antd selector ${path}`);
    if (COLOR.test(css)) violations.push(`literal color ${path}`);
    for (const declaration of css.matchAll(/(?:^|[;{])\s*[\w-]+\s*:\s*([^;{}]+)/g))
      violations.push(...namedColors(declaration[1]!).map((name) => `CSS color ${name}`));
  }
  // Positive assertions make an empty or NotImplemented skeleton fail too.
  for (const component of COMPONENTS) expect(rendered.has(component), component).toBe(true);
  expect(violations).toEqual([]);
});

it('[AC-F1-14a-SOURCE#2] 独立 dashboard 文案被页面引用，金额使用 money/现有格式函数，不引入本期未做告警', () => {
  expect(existsSync(dictionary), 'texts/dashboard.ts').toBe(true);
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
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.SlashToken)
        expect(node.right.getText(file), 'no floating-point fen / 100').not.toBe('100');
    });
  expect(imported.some((name) => /texts\/dashboard\.ts$/.test(name))).toBe(true);
  expect(
    imported.some((name) => name === '@couli/money' || /(?:money|format)(?:\.ts|\/)/.test(name)),
  ).toBe(true);
  expect(identifiers.includes('custom') || identifiers.includes('useCustom')).toBe(true);
  const all = [...files(directory).filter((path) => !/\.test\./.test(path)), dictionary]
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  expect(all).not.toMatch(/open_alerts|未关闭告警|独立告警中心/);
  expect(readFileSync(dictionary, 'utf8')).toMatch(/工作台/);
});
