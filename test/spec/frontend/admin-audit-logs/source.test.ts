// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const moduleUrl = import.meta.url;
const root = resolve(fileURLToPath(new URL('.', moduleUrl)), '../../../../apps/admin/src');
const directories = ['audit-logs', 'exports'];
const COLOR = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i;
function files(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
  );
}
function sources(directory: string): ts.SourceFile[] {
  return files(join(root, 'pages', directory))
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
  return (
    ((ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
      node.parent.moduleSpecifier === node) ||
    (ts.isCallExpression(node.parent) &&
      node.parent.expression.kind === ts.SyntaxKind.ImportKeyword)
  );
}
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
function literal(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literal(node.left);
    const right = literal(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

it('[AC-F1-10j-SOURCE#1] 两页实际渲染 antd Table 和 Button，禁止直接 fetch、拼 ant 类名、字面颜色与页面内中文文案', () => {
  const violations: string[] = [];
  for (const directory of directories) {
    const rendered = new Set<string>();
    for (const file of sources(directory)) {
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
          for (const binding of named.elements)
            if (!binding.isTypeOnly)
              bindings.set(binding.name.text, (binding.propertyName ?? binding.name).text);
        } else if (named && ts.isNamespaceImport(named)) {
          bindings.set(`${named.name.text}.Table`, 'Table');
          bindings.set(`${named.name.text}.Button`, 'Button');
        }
      }
      function component(tag: string): void {
        for (const [name, imported] of bindings)
          if (tag === name || tag.startsWith(`${name}.`)) rendered.add(imported);
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
        if (
          ts.isIdentifier(node) &&
          /^(fetch|XMLHttpRequest|dangerouslySetInnerHTML|innerHTML|getPrefixCls|ConfigContext)$/.test(
            node.text,
          )
        )
          violations.push(`${file.fileName}: forbidden API ${node.text}`);
        if (ts.isBinaryExpression(node) && /\bant-/.test(literal(node) ?? ''))
          violations.push(`${file.fileName}: concatenated ant class`);
        if (
          (ts.isStringLiteralLike(node) && !isModule(node)) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)
        ) {
          if (/\bant-/.test(node.text)) violations.push(`handwritten class ${node.text}`);
          if (COLOR.test(node.text)) violations.push(`literal color ${node.text}`);
          if (namedColors(node.text).includes(node.text))
            violations.push(`named color ${node.text}`);
          if (
            (ts.isPropertyAssignment(node.parent) &&
              /color|background|border|fill|stroke|shadow/i.test(node.parent.name.getText(file))) ||
            /var\(/.test(node.text)
          )
            violations.push(...namedColors(node.text).map((name) => `named color ${name}`));
          if (/[\u3400-\u9fff]/u.test(node.text))
            violations.push(`copy outside texts ${node.text}`);
        }
        if (ts.isJsxText(node) && /[\u3400-\u9fff]/u.test(node.text))
          violations.push(`JSX copy ${node.text}`);
      });
    }
    // These positive checks fail on the skeleton, rather than passing an empty scan.
    expect(rendered.has('Table'), `${directory} renders antd Table`).toBe(true);
    expect(rendered.has('Button'), `${directory} renders antd Button`).toBe(true);
    for (const path of files(join(root, 'pages', directory)).filter((path) =>
      path.endsWith('.css'),
    )) {
      const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/\bant-/.test(css)) violations.push(`antd selector ${path}`);
      if (COLOR.test(css)) violations.push(`literal color ${path}`);
      for (const declaration of css.matchAll(/(?:^|[;{])\s*[\w-]+\s*:\s*([^;{}]+)/g))
        violations.push(...namedColors(declaration[1]!).map((name) => `CSS color ${name}`));
    }
  }
  expect(violations).toEqual([]);
});

it('[AC-F1-10j-SOURCE#2] 审计与导出各自使用指定 texts 文案文件，不能用未接入占位替代页面', () => {
  for (const directory of directories) {
    const dictionary = join(root, 'texts', `${directory}.ts`);
    expect(existsSync(dictionary), `texts/${directory}.ts`).toBe(true);
    const imports: string[] = [];
    for (const file of sources(directory))
      visit(file, (node) => {
        if (
          ts.isImportDeclaration(node) &&
          !node.importClause?.isTypeOnly &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          imports.push(node.moduleSpecifier.text);
      });
    expect(imports.some((name) => name.endsWith(`/texts/${directory}.ts`))).toBe(true);
    const copy = readFileSync(dictionary, 'utf8');
    expect(copy).toMatch(/[\u3400-\u9fff]/u);
    expect(copy).not.toContain('尚未接入');
  }
});
