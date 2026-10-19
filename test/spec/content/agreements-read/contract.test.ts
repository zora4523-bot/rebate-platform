import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { PATH, ROOT, apiRequire } from './kit.ts';

it('[AC-F1-02n#20] getAgreements 去除 planned 并生成路由 schema，保持匿名与不签名契约', async () => {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      paths: Record<string, { get: Record<string, unknown> }>;
    }>;
  };
  const document = await parser.dereference(
    fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
    { resolve: { external: false } },
  );
  const operation = document.paths[PATH]!.get;
  expect(operation['x-implementation']).not.toBe('planned');
  expect(Object.hasOwn(CONTRACT_ROUTE_SCHEMAS, 'getAgreements')).toBe(true);
  expect(operation).toMatchObject({
    operationId: 'getAgreements',
    'x-auth': 'none',
    'x-signed': false,
    'x-error-codes': [],
    security: [],
  });
  expect(operation).not.toHaveProperty('x-session-scopes');
});
