import ts from 'typescript';
import { expect, it } from 'vitest';
import { contract, endpoints, list, object, operation, read } from './kit.ts';

// 生成物只作文本/AST 读取，不 import、eval 或调用生成器。
function generated(path: string, name: string): unknown {
  const source = ts.createSourceFile(
    path,
    read(path),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations])
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === name);
  expect(declarations).toHaveLength(1);
  let value = declarations[0]!.initializer;
  expect(value).toBeDefined();
  while (
    value &&
    (ts.isAsExpression(value) ||
      ts.isSatisfiesExpression(value) ||
      ts.isParenthesizedExpression(value))
  )
    value = value.expression;
  let parsed: unknown;
  expect(() => {
    parsed = JSON.parse(value!.getText());
  }).not.toThrow();
  return parsed;
}

it.each(
  endpoints.filter(
    (e): boolean => e[2] !== 'createAdminPayRefund' && e[2] !== 'createAdminPayAnomalyRefund',
  ),
)(
  '[AC-CT-21e#17] %s %s 已生成类型、后台鉴权和无签名策略，planned 不挂载校验路由',
  (method, path, id, permission) => {
    const endpoint = endpoints.find((entry) => entry[2] === id)!;
    expect(operation(contract(), endpoint)['x-implementation']).toBe('planned');
    const route = { method: method.toUpperCase(), path: path.replace(/\{([^}]+)\}/g, ':$1') };
    const auth = list(
      generated('apps/api/src/modules/platform/http/auth-routes.gen.ts', 'CONTRACT_AUTH_ROUTES'),
    );
    expect(auth).toContainEqual({ ...route, auth: 'admin' });
    const signing = list(
      generated(
        'apps/api/src/modules/platform/validation/signing-routes.gen.ts',
        'CONTRACT_SIGNING_ROUTES',
      ),
    );
    expect(signing).toContainEqual({ ...route, signed: false });
    const minVersion = list(
      generated(
        'apps/api/src/modules/risk/application/min-version-routes.gen.ts',
        'CONTRACT_MIN_VERSION_ROUTES',
      ),
    );
    expect(minVersion).toContainEqual({
      ...route,
      operationId: id,
      gate: null,
      sessionScopes: ['full'],
      idempotent: permission === 'pay.refund',
    });
    const schemas = object(
      generated(
        'apps/api/src/modules/platform/validation/route-schemas.gen.ts',
        'CONTRACT_ROUTE_SCHEMAS',
      ),
    );
    expect(schemas).not.toHaveProperty(id);
    const source = ts.createSourceFile(
      'openapi.gen.ts',
      read('packages/contracts-ts/src/openapi.gen.ts'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const [name, key] of [
      ['paths', path],
      ['operations', id],
    ]) {
      const interfaces = source.statements.filter(
        (node): node is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(node) && node.name.text === name,
      );
      expect(interfaces).toHaveLength(1);
      const properties = interfaces[0]!.members
        .filter(ts.isPropertySignature)
        .map((member) =>
          member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
            ? member.name.text
            : '',
        );
      expect(properties).toContain(key);
    }
  },
);

it.each(
  endpoints.filter(
    (e): boolean => e[2] === 'createAdminPayRefund' || e[2] === 'createAdminPayAnomalyRefund',
  ),
)(
  '[AC-CT-21e#17] %s %s（退款）已生成类型、后台鉴权和无签名策略，planned 不挂载校验路由',
  (method, path, id, permission) => {
    const endpoint = endpoints.find((entry) => entry[2] === id)!;
    expect(operation(contract(), endpoint)['x-implementation']).toBe('planned');
    const route = { method: method.toUpperCase(), path: path.replace(/\{([^}]+)\}/g, ':$1') };
    const auth = list(
      generated('apps/api/src/modules/platform/http/auth-routes.gen.ts', 'CONTRACT_AUTH_ROUTES'),
    );
    expect(auth).toContainEqual({ ...route, auth: 'admin' });
    const signing = list(
      generated(
        'apps/api/src/modules/platform/validation/signing-routes.gen.ts',
        'CONTRACT_SIGNING_ROUTES',
      ),
    );
    expect(signing).toContainEqual({ ...route, signed: false });
    const minVersion = list(
      generated(
        'apps/api/src/modules/risk/application/min-version-routes.gen.ts',
        'CONTRACT_MIN_VERSION_ROUTES',
      ),
    );
    expect(minVersion).toContainEqual({
      ...route,
      operationId: id,
      gate: null,
      sessionScopes: ['full'],
      idempotent: permission === 'pay.refund',
    });
    const schemas = object(
      generated(
        'apps/api/src/modules/platform/validation/route-schemas.gen.ts',
        'CONTRACT_ROUTE_SCHEMAS',
      ),
    );
    expect(schemas).not.toHaveProperty(id);
    const source = ts.createSourceFile(
      'openapi.gen.ts',
      read('packages/contracts-ts/src/openapi.gen.ts'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const [name, key] of [
      ['paths', path],
      ['operations', id],
    ]) {
      const interfaces = source.statements.filter(
        (node): node is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(node) && node.name.text === name,
      );
      expect(interfaces).toHaveLength(1);
      const properties = interfaces[0]!.members
        .filter(ts.isPropertySignature)
        .map((member) =>
          member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
            ? member.name.text
            : '',
        );
      expect(properties).toContain(key);
    }
  },
);
