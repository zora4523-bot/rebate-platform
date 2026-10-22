// @vitest-environment jsdom
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { ROOT, requiredText } from '../h5-app-api/kit.ts';

function sources(directory: string): string[] {
  return readdirSync(new URL(directory, ROOT), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory()
      ? sources(path)
      : /\.tsx?$/.test(path) && !/\.(?:test|d)\.tsx?$/.test(path)
        ? [path]
        : [];
  });
}

function walk(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  node.forEachChild((child) => walk(child, inspect));
}

function member(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text;
  return undefined;
}

/** A page may reset a named query, but empty/unfiltered resets clear the shell's data. */
function hasQueryScope(filters: ts.Expression | undefined): boolean {
  if (filters === undefined || !ts.isObjectLiteralExpression(filters)) return false;
  return filters.properties.some((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
      return false;
    const name = property.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) return false;
    const value = ts.isPropertyAssignment(property) ? property.initializer : name;
    if (ts.isIdentifier(value) && value.text === 'undefined') return false;
    return (
      name.text === 'predicate' ||
      (name.text === 'queryKey' &&
        !(ts.isArrayLiteralExpression(value) && value.elements.length === 0))
    );
  });
}

it('[AC-F1-01s-SOURCE#1] 全局换号订阅只有壳层一处，页面不重复清空全局缓存，取数不绕过 API 客户端', () => {
  const shell = 'apps/h5/src/entries/app/app-shell.tsx';
  const query = 'apps/h5/src/shared/query.ts';
  const apiDirectory = 'apps/h5/src/shared/api/';
  const pageDirectory = 'apps/h5/src/entries/app/pages/';
  const files = [
    shell,
    query,
    ...sources(apiDirectory.slice(0, -1)),
    ...sources(pageDirectory.slice(0, -1)),
  ];
  // Resolve literal types through real SDK imports/re-exports, including renamed and namespace
  // imports. This accepts an exported event constant without prescribing its identifier.
  const program = ts.createProgram(
    files.map((file) => fileURLToPath(new URL(file, ROOT))),
    {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      customConditions: ['couli-src'],
      jsx: ts.JsxEmit.ReactJSX,
      noEmit: true,
      skipLibCheck: true,
    },
  );
  const checker = program.getTypeChecker();
  const subscriptions: string[] = [];
  const violations: string[] = [];
  for (const file of files) {
    requiredText(file);
    const tree = program.getSourceFile(fileURLToPath(new URL(file, ROOT)));
    expect(tree, `source is available: ${file}`).toBeDefined();
    if (tree === undefined) continue;
    const constants = new Map<string, string>();
    const queryHooks = new Set(['useQueryClient']);
    const subscribeNames = new Set(['on']);
    const queryClients = new Set<string>();
    walk(tree, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isStringLiteralLike(node.initializer)
      )
        constants.set(node.name.text, node.initializer.text);
      if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'useQueryClient')
        queryHooks.add(node.name.text);
      if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'on')
        subscribeNames.add(node.name.text);
    });
    walk(tree, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        queryHooks.has(member(node.initializer.expression) ?? '')
      )
        queryClients.add(node.name.text);
    });
    walk(tree, (node) => {
      if (!ts.isCallExpression(node)) return;
      const called = member(node.expression);
      // Page-local auth handling may reset its own state, but cannot own global cleanup.
      if (!file.startsWith(pageDirectory) && subscribeNames.has(called ?? '')) {
        const event = node.arguments[0];
        const eventType = event === undefined ? undefined : checker.getTypeAtLocation(event);
        const eventName =
          event &&
          (ts.isStringLiteralLike(event)
            ? event.text
            : ts.isIdentifier(event)
              ? constants.get(event.text)
              : undefined);
        const resolvedEventName =
          eventName ?? (eventType?.isStringLiteral() ? eventType.value : undefined);
        if (resolvedEventName === 'auth.changed') subscriptions.push(file);
      }
      const transportFile =
        file === `${apiDirectory}index.ts` || file === `${apiDirectory}app-api.ts`;
      if (called === 'fetch' && !transportFile) violations.push(`${file}: direct fetch`);
      if (
        !file.startsWith(pageDirectory) ||
        !['clear', 'removeQueries', 'resetQueries'].includes(called ?? '')
      )
        return;
      const receiver =
        ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)
          ? node.expression.expression
          : undefined;
      if (
        receiver &&
        ((ts.isIdentifier(receiver) && queryClients.has(receiver.text)) ||
          (ts.isCallExpression(receiver) && queryHooks.has(member(receiver.expression) ?? '')) ||
          checker.getTypeAtLocation(receiver).getProperty('getQueryCache') !== undefined) &&
        (called === 'clear' || !hasQueryScope(node.arguments[0]))
      )
        violations.push(`${file}: page globally calls QueryClient.${called}`);
    });
  }
  // Positive presence is essential: the current shell has no subscription and must be red.
  // A shell-owned helper may live in shared/api or shared/query; no prescribed new export.
  expect(subscriptions, 'exactly one shell-level auth.changed subscription').toHaveLength(1);
  expect(violations).toEqual([]);
});
