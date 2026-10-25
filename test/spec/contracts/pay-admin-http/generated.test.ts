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
  '[AC-CT-21e#17] %s %s（退款）已生成类型、后台鉴权和无签名策略，已实现（不再 planned）并挂载校验路由',
  (method, path, id, permission) => {
    // B2-15e：两条原路退款操作已实现，必须挂载与契约一致的运行时请求校验。
    const endpoint = endpoints.find((entry) => entry[2] === id)!;
    const op = operation(contract(), endpoint);
    expect(op).not.toHaveProperty('x-implementation');
    expect(op['x-implementation']).not.toBe('planned');
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
    // 形状与契约一致：头部含必填 Idempotency-Key，路径参数只有路径里那一个且必填，请求体为退款请求。
    expect(schemas, `route-schemas.gen.ts: ${id}`).toHaveProperty(id);
    const entry = object(schemas[id]);
    const headers = object(entry['headers']);
    expect(headers['type']).toBe('object');
    expect(object(headers['properties'])).toHaveProperty(['idempotency-key']);
    expect(list(headers['required'])).toContain('idempotency-key');
    const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    expect(names).toHaveLength(1);
    const params = object(entry['params']);
    expect(params['type']).toBe('object');
    expect(Object.keys(object(params['properties']))).toEqual(names);
    expect(list(params['required'])).toEqual(names);
    const body = object(entry['body']);
    expect(body['type']).toBe('object');
    expect(body['additionalProperties']).toBe(false);
    expect(list(body['required'])).toEqual(expect.arrayContaining(['amount_fen', 'reason_code']));
    expect(Object.keys(object(body['properties'])).sort()).toEqual([
      'amount_fen',
      'note',
      'reason_code',
    ]);
    expect(entry).not.toHaveProperty('querystring');
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
