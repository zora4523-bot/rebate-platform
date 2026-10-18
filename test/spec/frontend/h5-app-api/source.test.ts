// @vitest-environment jsdom
import { readdirSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { createAppApi } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { readAppApiEnv } from '../../../../apps/h5/src/shared/env.ts';
import { ENV, ROOT, buildEnv, nativeBridge, envelope, requiredText, transport } from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function sources(path: string): string[] {
  return readdirSync(new URL(path, ROOT), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    return entry.isDirectory()
      ? sources(child)
      : /\.tsx?$/.test(child) && !/\.test\.tsx?$/.test(child)
        ? [child]
        : [];
  });
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  node.forEachChild((child) => visit(child, inspect));
}

it('[AC-F1-01q-SOURCE#1] 可工作的应用客户端及 provider 仅经 SDK 取桥，不访问持久化令牌或自行签名', async () => {
  // Positive behavior makes negative source assertions red on the skeleton as well.
  const native = nativeBridge();
  const wire = transport({ body: envelope({ id: 'me' }) });
  const client = createAppApi({ env: ENV, bridge: native.bridge, fetch: wire.fetch });
  expect(client).not.toBeNull();
  expect(await client!.request('GET', '/v1/me', {})).toEqual({ id: 'me' });
  const violations: string[] = [];
  const files = [
    ...sources('apps/h5/src/shared/api'),
    'apps/h5/src/entries/app/app-shell.tsx',
    'apps/h5/src/entries/app/shell.ts',
    'apps/h5/src/entries/app/main.tsx',
  ];
  for (const file of files) {
    const tree = ts.createSourceFile(file, requiredText(file), ts.ScriptTarget.Latest, true);
    visit(tree, (node) => {
      // Check identifiers and computed string accesses, not explanatory comments.
      if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
        if (
          /^(?:__REBATE_BRIDGE__|localStorage|sessionStorage|indexedDB|cookie|install_secret)$/i.test(
            node.text,
          ) ||
          /hmac/i.test(node.text)
        ) {
          violations.push(`${file}: ${node.text}`);
        }
      }
    });
  }
  expect(violations).toEqual([]);
});

it('[AC-F1-01q-SOURCE#2] API 与媒体构建配置集中在 shared/env，不散落在客户端或入口', () => {
  buildEnv();
  expect(readAppApiEnv()).toEqual(ENV);
  const files = [
    'apps/h5/src/shared/env.ts',
    ...sources('apps/h5/src/shared/api'),
    ...sources('apps/h5/src/entries/app'),
  ];
  const readers: string[] = [];
  for (const file of files) {
    const tree = ts.createSourceFile(file, requiredText(file), ts.ScriptTarget.Latest, true);
    visit(tree, (node) => {
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        ts.isMetaProperty(node.expression) &&
        node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
      ) {
        const name = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : node.argumentExpression.getText(tree);
        if (/^['"]?env['"]?$/.test(name)) readers.push(file);
      }
    });
  }
  expect([...new Set(readers)]).toEqual(['apps/h5/src/shared/env.ts']);
});
