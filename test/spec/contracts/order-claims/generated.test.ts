import { expect, it } from 'vitest';
import {
  at,
  claimPath,
  contract,
  endpoints,
  list,
  object,
  operation,
  read,
  resolve,
  text,
} from './kit.ts';
import { generated, namedInterface, property, source } from './source-kit.ts';

const platform = 'apps/api/src/modules/platform/';

it.each(endpoints)(
  '[CT-04f#13] %s %s 已生成鉴权、签名和版本策略，planned 不进入运行时 schema',
  (method, operationId) => {
    const expected = { method: method.toUpperCase(), path: claimPath };
    const tables = [
      [
        platform + 'http/auth-routes.gen.ts',
        'CONTRACT_AUTH_ROUTES',
        { ...expected, auth: 'login' },
      ],
      [
        platform + 'validation/signing-routes.gen.ts',
        'CONTRACT_SIGNING_ROUTES',
        { ...expected, signed: method === 'post' },
      ],
      [
        'apps/api/src/modules/risk/application/min-version-routes.gen.ts',
        'CONTRACT_MIN_VERSION_ROUTES',
        {
          ...expected,
          operationId,
          gate: method === 'post' ? true : null,
          idempotent: method === 'post',
          sessionScopes: ['full'],
        },
      ],
    ] as const;
    for (const [path, name, row] of tables) {
      const matches = list(generated(path, name))
        .map(object)
        .filter((entry) => entry['method'] === expected.method && entry['path'] === claimPath);
      expect(matches, `${name} 中必须唯一登记 ${method} ${claimPath}`).toHaveLength(1);
      expect(matches[0]).toEqual(row);
    }
    const implementation = operation(contract(), method)['x-implementation'];
    expect([undefined, 'planned']).toContain(implementation);
    // planned 跳过运行时 schema；后续实现并去掉标记时必须生成 schema。
    const schemas = object(
      generated(platform + 'validation/route-schemas.gen.ts', 'CONTRACT_ROUTE_SCHEMAS'),
    );
    if (implementation === 'planned') expect(schemas).not.toHaveProperty(operationId);
    else expect(schemas).toHaveProperty(operationId);
    const bridge = object(JSON.parse(read('contracts/bridge.schema.json')));
    const signedPaths = [{ method: 'POST', path: claimPath }];
    expect(bridge['signed_paths']).toEqual(signedPaths);
    expect(generated('packages/contracts-ts/src/bridge.gen.ts', 'signedPaths')).toEqual(
      signedPaths,
    );
  },
);

it.each(endpoints)('[CT-04f#14] contracts-ts 生成路径和 %s %s 的 operation 类型', (method, id) => {
  const file = source('packages/contracts-ts/src/openapi.gen.ts');
  const path = property(namedInterface(file, 'paths'), claimPath);
  const route = property(path, method);
  expect(route.questionToken).toBeUndefined();
  expect(route.type?.getText(file)).toMatch(new RegExp(`^operations\\[["']${id}["']\\]$`));
  const op = property(namedInterface(file, 'operations'), id);
  const success = property(op, '200');
  property(success, 'application/json');
});

it('[CT-04f#15] contracts-ts 的订单列表类型同步新增可选 boolean 字段', () => {
  const doc = contract();
  const response = resolve(doc, at(doc, 'paths', '/v1/orders', 'get', 'responses', '200'));
  const schema = resolve(doc, at(response, 'content', 'application/json', 'schema'));
  const ref = text(at(schema, 'properties', 'data')['$ref']);
  expect(ref.startsWith('#/components/schemas/')).toBe(true);
  const file = source('packages/contracts-ts/src/openapi.gen.ts');
  const schemas = property(namedInterface(file, 'components'), 'schemas');
  const data = property(schemas, ref.slice('#/components/schemas/'.length));
  const pinned = property(data, 'claim_entry_pinned');
  expect(pinned.questionToken).toBeDefined();
  expect(pinned.type?.getText(file)).toBe('boolean');
});
