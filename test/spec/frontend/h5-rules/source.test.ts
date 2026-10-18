// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';
import { ArticleBody } from '../../../../apps/h5/src/components/article-body/index.ts';
import { doc, paragraph } from './fixtures.ts';

afterEach(cleanup);
const moduleUrl = import.meta.url;
const root = fileURLToPath(new URL('../../../../', moduleUrl));
const roots = ['apps/h5/src/components/article-body', 'apps/h5/src/entries/app/pages/rules'];

function sources() {
  return roots.flatMap((directory) =>
    readdirSync(join(root, directory), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(?:tsx?|css)$/.test(file) && !/\.(?:test|d)\.tsx?$/.test(file))
      .map((file) => ({
        path: join(directory, file),
        source: readFileSync(join(root, directory, file), 'utf8'),
      })),
  );
}

function walk(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => walk(child, inspect));
}

it('[AC-F1-03a-SOURCE#1] 正文使用 static-renderer 的 JSON React 输出，不引入编辑器依赖或 HTML 字符串渲染通道', () => {
  // Negative-only checks would pass an empty skeleton; first exercise the public component.
  const view = render(createElement(ArticleBody, { body: doc(paragraph('安全正文')) }));
  expect(view.container.querySelector('p')?.textContent).toBe('安全正文');
  const violations: string[] = [];
  let callsRenderer = false;
  for (const { path, source } of sources()) {
    if (path.endsWith('.css')) continue;
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const rendererNames = new Set<string>();
    walk(tree, (node) => {
      const moduleSpecifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined;
      if (
        moduleSpecifier &&
        ts.isStringLiteralLike(moduleSpecifier) &&
        /^(?:@tiptap\/static-renderer\/pm(?:\/|$)|@tiptap\/(?:core|pm|starter-kit)(?:\/|$)|(?:@[^/]+\/)?prosemirror(?:[-/]|$))/.test(
          moduleSpecifier.text,
        )
      )
        violations.push(`${path}: editor dependency ${moduleSpecifier.text}`);
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (
          /marked|markdown-it|html-react-parser|react-markdown|rehype-raw|render-to-string/.test(
            specifier,
          )
        )
          violations.push(`${path}: HTML rendering dependency ${specifier}`);
        const bindings = node.importClause?.namedBindings;
        if (
          specifier === '@tiptap/static-renderer/json/react' &&
          bindings &&
          ts.isNamedImports(bindings)
        ) {
          for (const item of bindings.elements)
            if ((item.propertyName ?? item.name).text === 'renderJSONContentToReactElement')
              rendererNames.add(item.name.text);
        }
      }
    });
    walk(tree, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        rendererNames.has(node.expression.text)
      )
        callsRenderer = true;
      if (
        (ts.isIdentifier(node) || ts.isStringLiteral(node)) &&
        /^(?:dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|renderToString|renderToStaticMarkup|renderToHTMLString)$/.test(
          node.text,
        )
      )
        violations.push(`${path}: HTML sink ${node.text}`);
      if (
        (ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        /<\/?[a-z][^>]*>/i.test(node.text)
      )
        violations.push(`${path}: HTML string`);
    });
  }
  expect(
    callsRenderer,
    '必须从 @tiptap/static-renderer/json/react 导入并实际调用 renderJSONContentToReactElement，不能仅导入',
  ).toBe(true);
  expect(violations).toEqual([]);
});

it('[AC-F1-03a-SOURCE#2] 页面和正文中文文案来自 texts/rules.ts，颜色使用 UI 令牌', () => {
  const view = render(createElement(ArticleBody, { body: doc(paragraph('正文')) }));
  expect(view.container.textContent).toBe('正文');
  const dictionary = join(root, 'apps/h5/src/texts/rules.ts');
  expect(existsSync(dictionary), '任务专用文案字典').toBe(true);
  expect(readFileSync(dictionary, 'utf8')).toMatch(/[\u4e00-\u9fff]/u);
  const violations: string[] = [];
  let usesDictionary = false;
  function check(value: string, path: string): void {
    if (/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(value))
      violations.push(`${path}: Chinese literal`);
    const clean = value.replace(/var\(--[\w-]+\)/g, '').trim();
    const probe = document.createElement('span');
    probe.style.color = clean;
    if (/^(?:transparent|currentcolor|inherit|initial|unset|none)$/i.test(clean)) return;
    if (
      probe.style.color ||
      /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i.test(clean) ||
      /\b(?:bg|text|border|fill|stroke)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+)\b/.test(
        clean,
      )
    )
      violations.push(`${path}: literal color ${value}`);
  }
  for (const { path, source } of sources()) {
    if (path.endsWith('.css')) {
      for (const match of source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .matchAll(/[\w-]+\s*:\s*([^;{}]+)/g))
        check(match[1]!, path);
      continue;
    }
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    walk(tree, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        /texts\/rules\.ts$/.test(node.moduleSpecifier.text)
      )
        usesDictionary = true;
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)
      )
        check(node.text, path);
    });
  }
  expect(usesDictionary).toBe(true);
  expect(violations).toEqual([]);
});
