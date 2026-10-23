// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { InvitePage } from '../../../../apps/h5/src/entries/app/pages/invite/index.ts';
import { createAppRoutes } from '../../../../apps/h5/src/entries/app/routes.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const directory = join(root, 'apps/h5/src/entries/app/pages/invite');
const textPath = join(root, 'apps/h5/src/texts/invite.ts');
const schemaMethods = new Set(
  Object.keys(
    (
      JSON.parse(readFileSync(join(root, 'contracts/bridge.schema.json'), 'utf8')) as {
        methods: Record<string, unknown>;
      }
    ).methods,
  ),
);

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

it('[AC-F1-05a-ROUTE#1] InviteShare 路由 /invite 懒加载邀请好友页面', async () => {
  const route = createAppRoutes().find((item) => item.path === '/invite');
  expect(route).toBeDefined();
  expect((await route!.lazy()).Component).toBe(InvitePage);
});

it('[AC-F1-05a-SOURCE#1] 经应用级 API 与 @couli/money 格式化，桥能力只用登记的方法，不绕过客户端', () => {
  const used = new Set<string>();
  const violations: string[] = [];
  const bridgeMethods = new Set<string>();
  for (const { name, source } of sources()) {
    if (name.endsWith('.css')) continue;
    const file = tree(name, source);
    const imports = new Map<string, string>();
    walk(file, (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (/axios|ky(?:\/|$)|node-fetch|html2canvas|qrcode/.test(specifier))
          violations.push(`${name}: import ${specifier}`);
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
        /^(?:fetch|XMLHttpRequest|__REBATE_BRIDGE__|createApiClient|createAppApi|createH5TokenManager|localStorage|sessionStorage)$/.test(
          node.text,
        )
      )
        violations.push(`${name}: forbidden API ${node.text}`);
      // 复制与分享只经桥（clipboard.write、share.open），不用浏览器自带接口。
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'navigator' &&
        /^(?:clipboard|share|canShare)$/.test(node.name.text)
      )
        violations.push(`${name}: browser API navigator.${node.name.text}`);
      // 页面不在本地画海报（海报只用服务端出图 poster_url）。
      if (ts.isStringLiteralLike(node) && /^(?:canvas|2d)$/.test(node.text))
        violations.push(`${name}: local drawing ${node.text}`);
      if (ts.isStringLiteralLike(node) && schemaMethods.has(node.text))
        bridgeMethods.add(node.text);
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
  // 桥能力只用 bridge.schema.json 已有、本任务登记的几项（名字以字符串出现时核对）。
  const allowed = new Set([
    'clipboard.write',
    'media.saveImage',
    'media.previewImage',
    'share.open',
    'nav.open',
    'ui.toast',
  ]);
  expect([...bridgeMethods].filter((method) => !allowed.has(method))).toEqual([]);
  expect(violations).toEqual([]);
});

it('[AC-F1-05a-SOURCE#2] 无字典键的文案集中在 texts/invite.ts，页面源码无中文与字面颜色', () => {
  expect(existsSync(textPath), '实现阶段补充 texts/invite.ts（画板文案）').toBe(true);
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
        node.moduleSpecifier.text.endsWith('/texts/invite.ts')
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

it('[AC-F1-05a-SOURCE#3] 契约字典已有的键不在 texts/invite.ts 重复登记中文', () => {
  expect(existsSync(textPath), '实现阶段补充 texts/invite.ts（画板文案）').toBe(true);
  const source = readFileSync(textPath, 'utf8');
  // 这些句子字典已有（invite.share.*、invite.copy_*.done、invite.reward.tip_inviter），从字典读。
  for (const sentence of [
    '现阶段邀请好友不发放红包或现金奖励',
    '好友首单结算后，你们各得',
    '已复制邀请码',
    '已复制邀请链接',
    '未满 18 周岁，暂不开放邀请与分享',
  ]) {
    expect(source, sentence).not.toContain(sentence);
  }
});
