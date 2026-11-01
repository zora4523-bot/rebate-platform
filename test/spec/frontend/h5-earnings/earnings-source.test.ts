// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Nothing is read from disk while the file loads: every file is read inside its test, so a missing
// piece shows up as that test's assertion failure. A string (not a jsdom URL) goes to fileURLToPath.
const moduleUrl = import.meta.url;
const root = fileURLToPath(new URL('../../../../', moduleUrl).href);
const directory = join(root, 'apps/h5/src/entries/app/pages/earnings');
const textPath = join(root, 'apps/h5/src/texts/earnings.ts');

/** Method names registered in contracts/bridge.schema.json. */
function schemaMethods(): Set<string> {
  const schema = JSON.parse(readFileSync(join(root, 'contracts/bridge.schema.json'), 'utf8')) as {
    methods?: Record<string, unknown>;
  };
  expect(schema.methods, 'bridge.schema.json methods').toBeDefined();
  return new Set(Object.keys(schema.methods ?? {}));
}

function dictionaryTexts(): Record<string, string> {
  const dictionary = JSON.parse(
    readFileSync(join(root, 'contracts/texts.default.json'), 'utf8'),
  ) as { texts: Record<string, string> };
  return dictionary.texts;
}

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

it('[AC-F1-12a-SOURCE#1] 经 useApi 读 /v1/earnings/summary、@couli/money 格式化、基础弹层组件；不签名、不绕过客户端', () => {
  const registered = schemaMethods();
  const used = new Set<string>();
  const violations: string[] = [];
  const bridgeMethods = new Set<string>();
  let baseComponent = false;
  let summaryPath = false;
  for (const { name, source } of sources()) {
    if (name.endsWith('.css')) continue;
    const file = tree(name, source);
    const imports = new Map<string, string>();
    walk(file, (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (/components\/base(?:\/|$)/.test(specifier)) baseComponent = true;
        if (/axios|ky(?:\/|$)|node-fetch/.test(specifier))
          violations.push(`${name}: transport ${specifier}`);
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const binding of bindings.elements) {
            const imported = (binding.propertyName ?? binding.name).text;
            if (/shared\/api\/app-api\.ts$/.test(specifier) && imported === 'useApi')
              imports.set(binding.name.text, 'api');
            if (specifier === '@couli/money' && imported === 'formatYuan')
              imports.set(binding.name.text, 'money');
          }
        }
        if (bindings && ts.isNamespaceImport(bindings) && specifier === '@couli/money')
          imports.set(bindings.name.text, 'moneyNamespace');
      }
      if (
        (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
        /^(?:fetch|XMLHttpRequest|__REBATE_BRIDGE__|createApiClient|createAppApi|createH5TokenManager|localStorage|sessionStorage|signedRequest)$/.test(
          node.text,
        )
      )
        violations.push(`${name}: forbidden API ${node.text}`);
      if (ts.isStringLiteralLike(node) && node.text === '/v1/earnings/summary') summaryPath = true;
      if (ts.isStringLiteralLike(node) && registered.has(node.text)) bridgeMethods.add(node.text);
    });
    walk(file, (node) => {
      if (!ts.isCallExpression(node)) return;
      if (ts.isIdentifier(node.expression)) {
        const kind = imports.get(node.expression.text);
        if (kind) used.add(kind);
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        imports.get(node.expression.expression.text) === 'moneyNamespace' &&
        node.expression.name.text === 'formatYuan'
      )
        used.add('money');
    });
  }
  expect([...used]).toEqual(expect.arrayContaining(['api', 'money']));
  expect(summaryPath, '页面读 GET /v1/earnings/summary').toBe(true);
  expect(baseComponent, '指标说明用 components/base 的弹层').toBe(true);
  // 桥能力只用配置读取（app.getConfig，编排裁定 2）；令牌由应用级客户端经 auth.getH5Token 取，
  // 页面不直接调；看板不签名（x-signed: false），不用 net.signedRequest。
  const allowed = new Set(['app.getConfig', 'ui.toast']);
  expect([...bridgeMethods].filter((method) => !allowed.has(method))).toEqual([]);
  expect(violations).toEqual([]);
});

it('[AC-F1-12a-SOURCE#2] 页面源码无中文与字面颜色，文案经 texts/earnings.ts', () => {
  expect(existsSync(textPath), '实现阶段补充 texts/earnings.ts（字典缺的文案）').toBe(true);
  const violations: string[] = [];
  let dictionaryImported = false;
  function check(value: string, name: string): void {
    if (/[㐀-䶿一-鿿]/u.test(value)) violations.push(`${name}: inline Chinese text`);
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
        node.moduleSpecifier.text.endsWith('/texts/earnings.ts')
      )
        dictionaryImported = true;
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
  expect(dictionaryImported).toBe(true);
  expect(violations).toEqual([]);
});

it('[AC-F1-12a-SOURCE#3] texts/earnings.ts 不重复登记字典已有的 earnings.* 中文，也没有禁用词', () => {
  expect(existsSync(textPath), '实现阶段补充 texts/earnings.ts（字典缺的文案）').toBe(true);
  const source = readFileSync(textPath, 'utf8');
  const texts = dictionaryTexts();
  // 字典已有的句子从字典读（编排裁定 4：字典缺的才在本地登记）；只核对足够长、不会误撞的句子。
  const sentences = Object.entries(texts)
    .filter(([key]) => key.startsWith('earnings.'))
    .map(([, value]) => value)
    .filter((value) => value.replace(/\{[a-z_]+\}/g, '').length >= 8);
  expect(sentences.length).toBeGreaterThan(0);
  for (const sentence of sentences) {
    for (const part of sentence.split(/\{[a-z_]+\}/).filter((piece) => piece.length >= 8))
      expect(source, sentence).not.toContain(part);
  }
  expect(source).not.toMatch(/团队|下线|佣金|返现|二级/);
});
