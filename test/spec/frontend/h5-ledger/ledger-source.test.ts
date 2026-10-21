// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const moduleUrl = import.meta.url;
const root = fileURLToPath(new URL('../../../../', moduleUrl));
const directory = join(root, 'apps/h5/src/entries/app/pages/ledger');
const textPath = join(root, 'apps/h5/src/texts/ledger.ts');

function sources() {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(?:tsx?|css)$/.test(name) && !/\.(?:test|d)\.tsx?$/.test(name))
    .map((name) => ({ name, source: readFileSync(join(directory, name), 'utf8') }));
}

function walk(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => walk(child, inspect));
}

it('[AC-F1-04a-SOURCE#1] 页面调用应用级 API 与 money 格式化，使用现有基础组件，不绕过桥或客户端', () => {
  const used = new Set<string>();
  const violations: string[] = [];
  let baseComponent = false;
  for (const { name, source } of sources()) {
    if (name.endsWith('.css')) continue;
    const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imports = new Map<string, string>();
    walk(tree, (node) => {
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
            if (specifier === '@couli/money' && /^formatYuan(?:Admin)?$/.test(imported))
              imports.set(binding.name.text, 'money');
          }
        }
        if (bindings && ts.isNamespaceImport(bindings) && specifier === '@couli/money')
          imports.set(bindings.name.text, 'moneyNamespace');
      }
      if (
        (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
        /^(?:fetch|XMLHttpRequest|__REBATE_BRIDGE__|createApiClient|createAppApi|createH5TokenManager|localStorage|sessionStorage)$/.test(
          node.text,
        )
      ) {
        violations.push(`${name}: forbidden API ${node.text}`);
      }
    });
    walk(tree, (node) => {
      if (!ts.isCallExpression(node)) return;
      if (ts.isIdentifier(node.expression)) {
        const kind = imports.get(node.expression.text);
        if (kind) used.add(kind);
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        imports.get(node.expression.expression.text) === 'moneyNamespace' &&
        /^formatYuan(?:Admin)?$/.test(node.expression.name.text)
      )
        used.add('money');
    });
  }
  expect([...used]).toEqual(expect.arrayContaining(['api', 'money']));
  expect(baseComponent).toBe(true);
  expect(violations).toEqual([]);
});

it('[AC-F1-04a-SOURCE#2] 中文文案集中在 texts/ledger.ts，颜色只用令牌且不写 CSS 系统色名', () => {
  expect(existsSync(textPath), '实现阶段补充文案文件，测试阶段不伪造缺失字典').toBe(true);
  const textSource = readFileSync(textPath, 'utf8');
  expect(textSource).toContain('还没有余额变动');
  expect(textSource).toContain('返利结算入账、提现等变动会显示在这里');
  expect(textSource).toContain('余额为负的部分已由平台核销');
  const violations: string[] = [];
  let dictionaryImported = false;
  function check(value: string, name: string): void {
    if (/[\u3400-\u4dbf\u4e00-\u9fff]/u.test(value))
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
    const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    walk(tree, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        node.moduleSpecifier.text.endsWith('/texts/ledger.ts')
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
