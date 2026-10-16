import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { devProxy } from '../../../../apps/admin/src/dev-proxy.ts';

it('[AC-F1-06zb#13] 未配目标不代理，HTTP(S) 只代理原路径 /admin/v1，非法地址被拒绝', () => {
  expect(devProxy(undefined)).toBeUndefined();
  expect(devProxy('')).toBeUndefined();
  for (const target of ['http://127.0.0.1:3001', 'https://localhost:3001']) {
    expect(devProxy(target)).toEqual({ '/admin/v1': { target, changeOrigin: true } });
  }
  expect(() => devProxy('ftp://x')).toThrow();
  expect(() => devProxy('127.0.0.1:3001')).toThrow();
});

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const member = object.properties.find(
    (item) =>
      ts.isPropertyAssignment(item) &&
      (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) &&
      item.name.text === name,
  );
  return member && ts.isPropertyAssignment(member) ? member.initializer : undefined;
}

it('[AC-F1-06zb#14] Vite 导出的 server.proxy 调用导入的 devProxy 并传入 COULI_ADMIN_API_TARGET', () => {
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../apps/admin/vite.config.ts',
  );
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== './src/dev-proxy.ts' ||
      statement.importClause?.isTypeOnly
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (!binding.isTypeOnly && (binding.propertyName ?? binding.name).text === 'devProxy')
          names.push(binding.name.text);
      }
    }
  }
  expect(names).toHaveLength(1);
  const exported = file.statements.find(ts.isExportAssignment)?.expression;
  const config = exported && ts.isCallExpression(exported) ? exported.arguments[0] : exported;
  expect(config && ts.isObjectLiteralExpression(config)).toBe(true);
  const server =
    config && ts.isObjectLiteralExpression(config) ? property(config, 'server') : undefined;
  expect(server && ts.isObjectLiteralExpression(server)).toBe(true);
  const proxy =
    server && ts.isObjectLiteralExpression(server) ? property(server, 'proxy') : undefined;
  expect(proxy && ts.isCallExpression(proxy)).toBe(true);
  if (proxy && ts.isCallExpression(proxy)) {
    expect(ts.isIdentifier(proxy.expression) && names.includes(proxy.expression.text)).toBe(true);
    expect(proxy.arguments).toHaveLength(1);
    const target = proxy.arguments[0];
    expect(
      target &&
        ts.isPropertyAccessExpression(target) &&
        target.name.text === 'COULI_ADMIN_API_TARGET',
    ).toBe(true);
    const env = target && ts.isPropertyAccessExpression(target) ? target.expression : undefined;
    expect(env && ts.isPropertyAccessExpression(env) && env.name.text === 'env').toBe(true);
    const process = env && ts.isPropertyAccessExpression(env) ? env.expression : undefined;
    expect(process && ts.isIdentifier(process) && process.text === 'process').toBe(true);
  }
});
