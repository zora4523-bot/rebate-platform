// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const moduleUrl = import.meta.url;
const root = fileURLToPath(new URL('../../../../', moduleUrl));
const directory = join(root, 'apps/h5/src/entries/app/pages/messages');
const textPath = join(root, 'apps/h5/src/texts/messages.ts');

function sources() {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(?:tsx?|css)$/.test(name) && !/\.(?:test|d)\.tsx?$/.test(name))
    .map((name) => ({ name, source: readFileSync(join(directory, name), 'utf8') }));
}

function walk(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => walk(child, inspect));
}

function tree(name: string, source: string): ts.SourceFile {
  return ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

// 任务书 §9.3 ①：只用契约已实现的消息接口；H5 令牌无权读注销状态，页面不调 /v1/me/deletion（D10-542）。
const ALLOWED_PATHS = [
  '/v1/messages',
  '/v1/messages/read',
  '/v1/messages/{message_id}',
  '/v1/messages/unread-count',
];

it('[AC-F1-04c-SOURCE#1] 页面经 useApi 调接口，不直连 fetch、不签名、不碰本地存储', () => {
  const violations: string[] = [];
  let apiHookCalled = false;
  const paths = new Set<string>();
  for (const { name, source } of sources()) {
    if (name.endsWith('.css')) continue;
    const file = tree(name, source);
    const apiHooks = new Set<string>();
    walk(file, (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (/axios|ky(?:\/|$)|node-fetch|shared\/api\/signed(?:\.ts)?$/.test(specifier))
          violations.push(`${name}: import ${specifier}`);
        const bindings = node.importClause?.namedBindings;
        if (
          bindings &&
          ts.isNamedImports(bindings) &&
          /shared\/api\/app-api\.ts$/.test(specifier)
        ) {
          for (const binding of bindings.elements) {
            if ((binding.propertyName ?? binding.name).text === 'useApi')
              apiHooks.add(binding.name.text);
          }
        }
      }
      if (
        (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
        /^(?:fetch|XMLHttpRequest|__REBATE_BRIDGE__|createApiClient|createAppApi|createH5TokenManager|localStorage|sessionStorage|net\.signedRequest|X-Signature)$/.test(
          node.text,
        )
      )
        violations.push(`${name}: forbidden ${node.text}`);
      if (ts.isStringLiteralLike(node) && node.text.startsWith('/v1/')) paths.add(node.text);
    });
    walk(file, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        apiHooks.has(node.expression.text)
      )
        apiHookCalled = true;
    });
  }
  expect(apiHookCalled).toBe(true);
  expect([...paths].filter((path) => !ALLOWED_PATHS.includes(path))).toEqual([]);
  expect(paths.has('/v1/messages')).toBe(true);
  expect(paths.has('/v1/messages/read')).toBe(true);
  expect(paths.has('/v1/me/deletion')).toBe(false);
  expect(violations).toEqual([]);
});

it('[AC-F1-04c-SOURCE#2] 中文文案集中在 texts/messages.ts（含页标题），颜色只用令牌', () => {
  expect(existsSync(textPath), '实现阶段补充文案文件').toBe(true);
  const textSource = readFileSync(textPath, 'utf8');
  // 页标题字典无键（任务书 §9.3 ⑥），按画板措辞登记在本页文案文件。
  expect(textSource).toContain('消息中心');
  const violations: string[] = [];
  let textsImported = false;
  function check(value: string, name: string): void {
    if (/[\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}]/u.test(value))
      violations.push(`${name}: inline Chinese text`);
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
      violations.push(`${name}: literal color ${value}`);
  }
  for (const { name, source } of sources()) {
    if (name.endsWith('.css')) {
      for (const match of source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .matchAll(/[\w-]+\s*:\s*([^;{}]+)/g))
        check(match[1]!, name);
      continue;
    }
    walk(tree(name, source), (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        node.moduleSpecifier.text.endsWith('/texts/messages.ts')
      )
        textsImported = true;
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)
      )
        check(node.text, name);
    });
  }
  expect(textsImported).toBe(true);
  expect(violations).toEqual([]);
});

it('[AC-F1-04c-SOURCE#3] 空态、全部已读、未读文案按字典键 messages.* 引用', () => {
  expect(existsSync(textPath), '实现阶段补充文案文件').toBe(true);
  const textSource = readFileSync(textPath, 'utf8');
  for (const key of [
    'messages.empty',
    'messages.empty_hint',
    'messages.read_all',
    'messages.unread',
  ]) {
    const used = textSource.includes(key) || sources().some(({ source }) => source.includes(key));
    expect(used, key).toBe(true);
  }
});
