import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

function source(name: string): ts.SourceFile {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/admin/src', name);
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}

function imports(file: ts.SourceFile, module: string, name: string): string[] {
  const names: string[] = [];
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== module
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === name) names.push(binding.name.text);
      }
    }
  }
  return names;
}

it('[AC-F1-06zb#15] main 不再保留权限接口未接入的文字或 PermissionsProvider 拒绝占位', () => {
  const file = source('main.tsx');
  expect(file.text).not.toMatch(/not\s+wired/i);
  const providers = imports(file, './providers/access-control/index.ts', 'PermissionsProvider');
  const placeholders: string[] = [];
  visit(file, (node) => {
    const typedProvider =
      ts.isVariableDeclaration(node) &&
      node.type !== undefined &&
      ts.isTypeReferenceNode(node.type) &&
      providers.includes(node.type.typeName.getText(file));
    const inlineProvider =
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'permissionsProvider';
    if (!typedProvider && !inlineProvider) return;
    visit(node, (child) => {
      if (
        ts.isCallExpression(child) &&
        ts.isPropertyAccessExpression(child.expression) &&
        ts.isIdentifier(child.expression.expression) &&
        child.expression.expression.text === 'Promise' &&
        child.expression.name.text === 'reject'
      )
        placeholders.push(child.getText(file));
    });
  });
  expect(placeholders).toEqual([]);
});

it('[AC-F1-06zb#16] App 导入并调用统一 createAdminApi，不再直接组装 auth 与 data provider', () => {
  const file = source('App.tsx');
  const apiNames = imports(file, './providers/admin-api.ts', 'createAdminApi');
  expect(apiNames).toHaveLength(1);
  const oldNames = [
    'createAuthProvider',
    'createDataProvider',
    ...imports(file, './providers/auth/index.ts', 'createAuthProvider'),
    ...imports(file, './providers/data/index.ts', 'createDataProvider'),
  ];
  const calls: string[] = [];
  visit(file, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
      calls.push(node.expression.text);
  });
  expect(calls.some((name) => apiNames.includes(name))).toBe(true);
  expect(calls.filter((name) => oldNames.includes(name))).toEqual([]);
});
