// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { getLoginTexts } from '../../../../apps/admin/src/texts/login.ts';
import { COPY } from './fixtures.ts';

const moduleUrl = import.meta.url;
const root = new URL('../../../../apps/admin/src/', moduleUrl);

it('[AC-F1-06h-TEXT#1] BR-TEXT-14 登录错误键与固定 SPEC_REF 原文逐字一致', () => {
  const dictionary = getLoginTexts();
  for (const [key, value] of Object.entries(COPY)) expect(dictionary[key], key).toBe(value);
  // This step has no artboard; these task-specified strings are provisional design copy.
  for (const text of ['设置新密码', '新密码', '再次输入', '下一步'])
    expect(Object.values(dictionary)).toContain(text);
});

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}

function files(path: string): string[] {
  return readdirSync(new URL(path, root), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}${entry.name}`;
    return entry.isDirectory()
      ? files(`${child}/`)
      : /\.(?:tsx?|css)$/.test(child) && !/\.(?:test|gen|d)\.tsx?$/.test(child)
        ? [child]
        : [];
  });
}

it('[AC-F1-06h-SOURCE#1] App 接 Refine authProvider，登录复用 OtpInput，源码文案和色值遵循约定', () => {
  const app = ts.createSourceFile(
    'App.tsx',
    readFileSync(new URL('App.tsx', root), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let wired = false;
  const bindings = new Set<string>();
  for (const statement of app.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@refinedev/core'
    )
      continue;
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamedImports(named))
      for (const item of named.elements)
        if ((item.propertyName ?? item.name).text === 'Refine') bindings.add(item.name.text);
  }
  visit(app, (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      bindings.has(node.tagName.getText(app))
    ) {
      wired ||= node.attributes.properties.some(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText(app) === 'authProvider' &&
          attribute.initializer !== undefined,
      );
    }
  });
  // Positive integration requirement makes this file red on the unchanged shell too.
  expect(wired).toBe(true);
  let otpImported = false;
  const violations: string[] = [];
  const probe = document.createElement('span');
  function color(value: string, path: string) {
    const clean = value.replace(/var\(--[\w-]+\)/g, '').trim();
    if (/^(?:currentcolor|transparent|inherit|initial|unset|revert|revert-layer)$/i.test(clean))
      return;
    probe.style.color = '';
    probe.style.color = clean;
    if (
      probe.style.color !== '' ||
      /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i.test(clean)
    )
      violations.push(`${path}: ${value}`);
  }
  for (const path of ['App.tsx', ...files('providers/auth/'), ...files('pages/login/')]) {
    const source = readFileSync(new URL(path, root), 'utf8');
    if (path.endsWith('.css')) {
      for (const value of source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .matchAll(/[\w-]+\s*:\s*([^;{}]+)/g)) {
        color(value[1]!, path);
        for (const word of value[1]!.replace(/var\([^)]*\)/g, '').matchAll(/\b[a-z]+\b/gi))
          color(word[0], path);
      }
      continue;
    }
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    visit(tree, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.includes('/otp-input/')
      )
        otpImported = true;
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)
      ) {
        if (/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(node.text))
          violations.push(`${path}: Chinese literal`);
        if (!ts.isJsxText(node)) color(node.text, path);
      }
    });
  }
  expect(otpImported).toBe(true);
  expect(violations).toEqual([]);
});
