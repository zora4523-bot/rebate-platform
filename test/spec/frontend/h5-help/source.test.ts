// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen } from '@testing-library/react';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { articles, BODY_TEXT, helpServer } from './fixtures.ts';
import { mount } from './helpers.ts';

const moduleUrl = import.meta.url;
const root = fileURLToPath(new URL('../../../../', moduleUrl));
const pageDirectory = 'apps/h5/src/entries/app/pages/help';
const dictionary = 'apps/h5/src/texts/help.ts';

function sources() {
  return readdirSync(join(root, pageDirectory), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(?:tsx?|css)$/.test(file) && !/\.(?:test|d)\.tsx?$/.test(file))
    .map((file) => ({
      path: join(pageDirectory, file),
      source: readFileSync(join(root, pageDirectory, file), 'utf8'),
    }));
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function syntax(path: string, source: string) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

it('[AC-F1-03b-SOURCE#1] 页面只经 useApi 与 react-query 取数，客服使用 SDK，不直接 fetch 或访问原生全局', async () => {
  // Exercise the page first: a negative-only source scan must not accept an empty skeleton.
  mount(helpServer().api);
  expect(await screen.findByText(articles[0]!.title)).toBeTruthy();
  const violations: string[] = [];
  const used = new Set<string>();
  let sdkImport = false;
  for (const { path, source } of sources()) {
    if (path.endsWith('.css')) continue;
    const tree = syntax(path, source);
    const imported = new Map<string, string>();
    walk(tree, (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const module = node.moduleSpecifier.text;
        if (module === '@couli/bridge-sdk' && !node.importClause?.isTypeOnly) sdkImport = true;
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const item of bindings.elements) {
            const name = (item.propertyName ?? item.name).text;
            if (/shared\/api\/app-api\.ts$/.test(module) && name === 'useApi')
              imported.set(item.name.text, 'api');
            if (module === '@tanstack/react-query' && /^(useQuery|useInfiniteQuery)$/.test(name))
              imported.set(item.name.text, 'query');
          }
        }
      }
    });
    walk(tree, (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = imported.get(node.expression.text);
        if (name) used.add(name);
      }
      if (
        (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
        /^(?:fetch|XMLHttpRequest|__REBATE_BRIDGE__|createApiClient|createAppApi|dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML)$/.test(
          node.text,
        )
      )
        violations.push(`${path}: forbidden channel ${node.text}`);
    });
  }
  expect([...used].sort()).toEqual(['api', 'query']);
  expect(sdkImport).toBe(true);
  expect(violations).toEqual([]);
});

it('[AC-F1-03b-SOURCE#2] 正文实际使用已有 ArticleBody 与 shared/env 媒体域，不引入渲染库', async () => {
  mount(helpServer().api, { url: '/help?article_id=z-faq-47' });
  expect(await screen.findByText(BODY_TEXT)).toBeTruthy();
  let rendersBody = false;
  let readsOrigins = false;
  const violations: string[] = [];
  const allowedPackages = new Set([
    'react',
    'react-router',
    '@tanstack/react-query',
    '@couli/bridge-sdk',
    '@couli/contracts-ts',
    '@couli/ui-tokens',
  ]);
  for (const { path, source } of sources()) {
    if (path.endsWith('.css')) continue;
    const tree = syntax(path, source);
    const bodies = new Set<string>();
    const origins = new Set<string>();
    walk(tree, (node) => {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined;
      if (
        specifier &&
        ts.isStringLiteralLike(specifier) &&
        !specifier.text.startsWith('.') &&
        !allowedPackages.has(specifier.text)
      )
        violations.push(`${path}: new dependency ${specifier.text}`);
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
      const bindings = node.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) return;
      for (const item of bindings.elements) {
        const name = (item.propertyName ?? item.name).text;
        if (
          /components\/article-body\/(?:index|article-body)\.tsx?$/.test(
            node.moduleSpecifier.text,
          ) &&
          name === 'ArticleBody'
        )
          bodies.add(item.name.text);
        if (/shared\/env\.ts$/.test(node.moduleSpecifier.text) && name === 'mediaOrigins')
          origins.add(item.name.text);
      }
    });
    walk(tree, (node) => {
      if (
        (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
        bodies.has(node.tagName.getText(tree))
      )
        rendersBody = true;
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && origins.has(node.expression.text))
          readsOrigins = true;
        if (
          /(?:^|\.)createElement$/.test(node.expression.getText(tree)) &&
          node.arguments[0] &&
          bodies.has(node.arguments[0].getText(tree))
        )
          rendersBody = true;
      }
    });
  }
  expect(rendersBody).toBe(true);
  expect(readsOrigins).toBe(true);
  expect(violations).toEqual([]);
});

it('[AC-F1-03b-SOURCE#3] 中文集中 texts/help.ts，颜色使用令牌，无内置分类或文章对应表', async () => {
  mount(helpServer().api);
  expect(await screen.findByText(articles[0]!.title)).toBeTruthy();
  expect(existsSync(join(root, dictionary)), '帮助页文案文件必须存在').toBe(true);
  // Check existence before reading: an absent dictionary is an assertion failure, not ENOENT.
  const dictionarySource = readFileSync(join(root, dictionary), 'utf8');
  expect(dictionarySource).toMatch(/[\u4e00-\u9fff]/u);
  const violations: string[] = [];
  let usesDictionary = false;
  function check(value: string, path: string): void {
    if (/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(value))
      violations.push(`${path}: Chinese literal`);
    const clean = value.replace(/var\(--[\w-]+\)/g, '').trim();
    if (/^(?:transparent|currentcolor|inherit|initial|unset|none)$/i.test(clean)) return;
    const probe = document.createElement('span');
    probe.style.color = clean;
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
    walk(syntax(path, source), (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        /texts\/help\.ts$/.test(node.moduleSpecifier.text)
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
  const literals: string[] = [];
  for (const { path, source } of [...sources(), { path: dictionary, source: dictionarySource }]) {
    if (path.endsWith('.css')) continue;
    walk(syntax(path, source), (node) => {
      if (ts.isStringLiteralLike(node)) literals.push(node.text);
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText().replace(/['"]/g, '') === 'article_id' &&
        ts.isStringLiteralLike(node.initializer)
      )
        violations.push(`${path}: hard-coded article_id`);
    });
  }
  for (const literal of [
    '新手教程',
    '返利与结算',
    '订单与找回',
    '提现',
    '邀请好友',
    '账号与隐私',
    ...articles.flatMap((article) => [article.article_id, article.title]),
  ])
    expect(literals).not.toContain(literal);
  expect(usesDictionary).toBe(true);
  expect(violations).toEqual([]);
});
