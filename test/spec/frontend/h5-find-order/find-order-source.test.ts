// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { userEvent } from '@testing-library/user-event';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { createAppRoutes } from '../../../../apps/h5/src/entries/app/routes.ts';
import { FindOrderPage } from '../../../../apps/h5/src/entries/app/pages/find-order/index.ts';
import { control, isSelected, mount, ready } from './find-order-helpers.ts';

const moduleUrl = import.meta.url;
const root = fileURLToPath(new URL('../../../../', moduleUrl));
const directory = 'apps/h5/src/entries/app/pages/find-order';
const dictionaryPath = 'apps/h5/src/texts/find-order.ts';

function sources() {
  return readdirSync(join(root, directory), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(?:tsx?|css)$/.test(file) && !/\.(?:test|d)\.tsx?$/.test(file))
    .map((file) => ({
      path: join(directory, file),
      source: readFileSync(join(root, directory, file), 'utf8'),
    }));
}
function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

it('[AC-F1-04b-A11Y#1] 平台胶囊读中文名且明确播报选中，切换后旧平台取消选中', async () => {
  mount();
  await ready();
  expect(isSelected(control('淘宝'))).toBe(true);
  expect(isSelected(control('京东'))).toBe(false);
  expect(isSelected(control('拼多多'))).toBe(false);
  await userEvent.setup().click(control('京东'));
  expect(isSelected(control('京东'))).toBe(true);
  expect(isSelected(control('淘宝'))).toBe(false);
  expect(isSelected(control('拼多多'))).toBe(false);
});

it('[AC-F1-04b-SOURCE#1] find-order路由懒加载实际页面组件，不能继续落占位页', async () => {
  const route = createAppRoutes().find((item) => item.path === '/find-order');
  expect(route).toBeDefined();
  const loaded = await route!.lazy();
  expect(loaded.Component).toBe(FindOrderPage);
});

it('[AC-F1-04b-SOURCE#2] 页面不直接fetch或接触原生全局，复用现有API和平台组件', async () => {
  mount();
  await ready();
  const violations: string[] = [];
  const imports: string[] = [];
  for (const { path, source } of sources()) {
    if (path.endsWith('.css')) continue;
    walk(
      ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
      (node) => {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteralLike(node.moduleSpecifier) &&
          !node.importClause?.isTypeOnly
        )
          imports.push(node.moduleSpecifier.text);
        if (
          (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
          /^(?:fetch|XMLHttpRequest|__REBATE_BRIDGE__|createApiClient|createAppApi|localStorage|sessionStorage)$/.test(
            node.text,
          )
        )
          violations.push(`${path}: ${node.text}`);
      },
    );
  }
  expect(violations).toEqual([]);
  expect(imports.some((path) => /shared\/api\/app-api\.ts$/.test(path))).toBe(true);
  expect(
    imports.some((path) => /components\/platform\/(?:PlatformBadge|index)\.tsx?$/.test(path)),
  ).toBe(true);
  expect(imports.some((path) => /components\/base\//.test(path))).toBe(true);
});

it('[AC-F1-04b-SOURCE#3] 页面样式使用设计令牌，不硬编码色值含CSS系统色名', async () => {
  mount();
  await ready();
  const violations: string[] = [];
  // Include system colours: CanvasText/ButtonFace are literal colours too, not design tokens.
  const literal =
    /^(?:#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\s*\([^]*\)|AccentColor|AccentColorText|ActiveText|ButtonBorder|ButtonFace|ButtonText|Canvas|CanvasText|Field|FieldText|GrayText|Highlight|HighlightText|LinkText|Mark|MarkText|SelectedItem|SelectedItemText|VisitedText)$/i;
  const paletteClass =
    /(?:^|:)!?(?:bg|text|border|ring|outline|fill|stroke|shadow)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+)(?:\/[^\s]+)?!?$/i;
  const arbitraryColourClass =
    /(?:^|:)!?(?:bg|text|border|ring|outline|fill|stroke|shadow)-\[(?:color:)?(?:#[\da-f]{3,8}|(?:rgba?|hsla?|oklch|oklab|hwb|lab|lch|color)\([^]*\))\](?:\/[^\s]+)?!?$/i;
  function check(value: string, path: string): void {
    const clean = value.trim();
    // Check each utility, including variants; couli-* token names cannot match these patterns.
    for (const className of clean.split(/\s+/)) {
      if (paletteClass.test(className) || arbitraryColourClass.test(className))
        violations.push(`${path}: ${className}`);
    }
    if (/^(?:transparent|currentcolor|inherit|initial|unset|none)$/i.test(clean)) return;
    // Probe the whole value for other CSS named colours; class/token fragments never match.
    const probe = document.createElement('span');
    probe.style.color = clean;
    if ((/^[a-z]+$/i.test(clean) && probe.style.color) || literal.test(clean))
      violations.push(`${path}: ${value}`);
  }
  for (const { path, source } of sources()) {
    if (path.endsWith('.css')) {
      const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const value of clean.matchAll(/:\s*([^;{}]+)[;}]/g)) check(value[1]!, path);
    } else {
      walk(
        ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
        (node) => {
          if (
            ts.isStringLiteralLike(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node)
          )
            check(node.text, path);
        },
      );
    }
  }
  expect(violations).toEqual([]);
});

it('[AC-F1-04b-SOURCE#4] 页面文案集中在texts/find-order.ts，已知键来自契约且缺键占位有登记', async () => {
  mount();
  await ready();
  expect(existsSync(join(root, dictionaryPath))).toBe(true);
  const dictionary = readFileSync(join(root, dictionaryPath), 'utf8');
  expect(dictionary).toMatch(/texts\.default\.json|@couli\/contracts-ts|shared\/texts\.ts/);
  expect(dictionary).toContain('claim.guide.');
  expect(dictionary).toContain('claim.records.empty');
  expect(dictionary).toMatch(/占位|待补|TODO|§7/);
  expect(dictionary).toContain('没有找到这笔订单经凑狸下单的记录');
  expect(dictionary).toContain('只显示你本人提交的找回申请');
  const literals: string[] = [];
  for (const { path, source } of sources()) {
    if (path.endsWith('.css')) continue;
    walk(
      ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
      (node) => {
        if (
          (ts.isStringLiteralLike(node) ||
            ts.isJsxText(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node)) &&
          /[\u3400-\u9fff]/.test(node.text)
        )
          literals.push(`${path}: ${node.text}`);
      },
    );
  }
  expect(literals).toEqual([]);
  expect(sources().some(({ source }) => /texts\/find-order\.ts/.test(source))).toBe(true);
});
