// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { BUILTIN_EXTS, BUILTIN_FILES, KEYS } from './fixtures.ts';

// 03 §9.1 and the F1 frontend lessons: the page is built from antd components (Table, Drawer,
// Modal) rendered as JSX, never from native controls dressed in antd class names; previews load
// the cleaned file only as an image (BR-TEXT-24 细则「显示上下文」), never inlined.
const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/admin/src/pages/platform-icons',
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

/** Local names under which `imported` of `module` is bound (value imports only). */
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
    } else if (named && ts.isNamespaceImport(named)) {
      names.add(`${named.name.text}.${imported}`);
    }
  }
  return names;
}

function sources(): ts.SourceFile[] {
  return files(root)
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
}

/**
 * A module name, not a class name: the specifier of an import / export declaration, of
 * `import x = require(...)`, of an import type or of a dynamic `import(...)` (e.g. the allowed
 * '@ant-design/icons' package).
 */
function isModuleSpecifier(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  if (
    (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
    parent.moduleSpecifier === node
  )
    return true;
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) return true;
  return (
    ts.isCallExpression(parent) &&
    parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
    parent.arguments[0] === node
  );
}

const NATIVE = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'ul',
  'ol',
  'li',
  'button',
  'input',
  'select',
  'textarea',
  'form',
  'dialog',
  'svg',
  'use',
  'foreignObject',
  'object',
  'iframe',
  'embed',
]);
const HTML_SINKS = new Set(['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc']);
const COLOR_LITERAL =
  /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$|\b(?:rgba?|hsla?|hwb|oklch|oklab)\s*\(/i;

it('[AC-F1-06zd-SOURCE#1] 页面以 JSX 渲染从 antd 导入的 Table、Drawer、Modal，不手写原生控件、ant 类名或内联 SVG', () => {
  const sourceFiles = sources();
  const rendered = new Set<string>();
  const violations: string[] = [];
  for (const file of sourceFiles) {
    const location = (node: ts.Node) =>
      `${relative(root, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
    const components = new Map<string, string>();
    for (const component of ['Table', 'Drawer', 'Modal'])
      for (const name of bindings(file, 'antd', component)) components.set(name, component);
    const factories = new Set(['createElement', 'jsx', 'jsxs', 'jsxDEV']);
    for (const module of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'])
      for (const factory of ['createElement', 'jsx', 'jsxs', 'jsxDEV'])
        for (const name of bindings(file, module, factory)) factories.add(name);
    visit(file, (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(file);
        const component = components.get(tag);
        if (component !== undefined) rendered.add(component);
        if (NATIVE.has(tag)) violations.push(`${location(node)}: native JSX ${tag}`);
      }
      if (ts.isJsxAttribute(node) && node.name.getText(file) === 'dangerouslySetInnerHTML')
        violations.push(`${location(node)}: dangerouslySetInnerHTML`);
      if (
        (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
        node.name.getText(file).replace(/['"]/g, '') === 'dangerouslySetInnerHTML'
      )
        violations.push(`${location(node)}: dangerouslySetInnerHTML`);
      if (ts.isPropertyAccessExpression(node) && HTML_SINKS.has(node.name.text))
        violations.push(`${location(node)}: HTML sink ${node.name.text}`);
      if (ts.isIdentifier(node) && /^(?:getPrefixCls|ConfigContext|DOMParser)$/.test(node.text))
        violations.push(`${location(node)}: ${node.text}`);
      if (
        (ts.isStringLiteralLike(node) && !isModuleSpecifier(node)) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        if (/\bant-/.test(node.text))
          violations.push(`${location(node)}: handwritten antd class ${node.text}`);
        if (COLOR_LITERAL.test(node.text.trim()))
          violations.push(`${location(node)}: literal color ${node.text}`);
      }
      if (ts.isCallExpression(node)) {
        const called = node.expression;
        const first = node.arguments[0];
        if (
          (factories.has(called.getText(file)) ||
            (ts.isPropertyAccessExpression(called) && factories.has(called.name.text))) &&
          first &&
          ts.isStringLiteralLike(first) &&
          NATIVE.has(first.text)
        )
          violations.push(`${location(node)}: native factory ${first.text}`);
        // Image bytes are never read: no direct fetch (the data provider does the API calls).
        if (
          (ts.isIdentifier(called) && called.text === 'fetch') ||
          (ts.isPropertyAccessExpression(called) && called.name.text === 'fetch')
        )
          violations.push(`${location(node)}: direct fetch`);
      }
    });
  }
  for (const path of files(root).filter((file) => file.endsWith('.css'))) {
    const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/\.ant-|\[[^\]]*ant-[^\]]*\]/i.test(css))
      violations.push(`${relative(root, path)}: antd selector`);
    if (/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i.test(css))
      violations.push(`${relative(root, path)}: literal color`);
    const probe = document.createElement('span').style;
    for (const declaration of css.matchAll(/(?:^|[;{])\s*(?:--)?[\w-]+\s*:\s*([^;{}]+)/g)) {
      const value = declaration[1]!.replace(/var\([^)]*\)/g, '');
      for (const token of value.matchAll(/\b[a-z]+\b/gi)) {
        if (/^(?:inherit|initial|unset|revert|currentcolor|transparent)$/i.test(token[0])) continue;
        probe.color = '';
        probe.color = token[0];
        if (probe.color !== '') violations.push(`${relative(root, path)}: named color ${token[0]}`);
      }
    }
  }
  // Positive part first: the skeleton fails here even though it breaks none of the bans.
  expect([...rendered].sort(), 'pages/platform-icons renders antd Drawer, Modal and Table').toEqual(
    ['Drawer', 'Modal', 'Table'],
  );
  expect(violations).toEqual([]);
});

it('[AC-F1-06zd-SOURCE#2] 内置图按 BR-TEXT-24 标识键表各有一个文件，与 H5 内置的同名文件逐字节相同', () => {
  // The console previews the same bundled image the clients fall back to (BR-TEXT-24 「安装包与
  // H5 产物内置一套作兜底」); the admin may not import from apps/h5, so it keeps copies.
  const h5 = resolve(root, '../../../../h5/src/components/platform/assets');
  const problems: string[] = [];
  for (const key of KEYS) {
    const file = `${BUILTIN_FILES[key]}.${BUILTIN_EXTS[key]}`;
    const own = join(root, 'assets', file);
    if (!existsSync(own)) {
      problems.push(`${key}: missing pages/platform-icons/assets/${file}`);
      continue;
    }
    if (!readFileSync(own).equals(readFileSync(join(h5, file))))
      problems.push(`${key}: assets/${file} differs from apps/h5 ${file}`);
  }
  expect(problems).toEqual([]);
});
