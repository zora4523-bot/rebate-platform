import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('[AC-F1-02s#20] getDict 去掉 planned，保留匿名、不签名及受限会话契约', async () => {
  const root = new URL('../../../../', import.meta.url);
  const apiRequire = createRequire(new URL('apps/api/package.json', root));
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      paths: Record<string, { get: Record<string, unknown> }>;
    }>;
  };
  const contract = await parser.dereference(
    fileURLToPath(new URL('contracts/openapi.yaml', root)),
    { resolve: { external: false } },
  );
  const operation = contract.paths['/v1/dict']?.get;
  expect(operation).toBeDefined();
  expect(operation?.['x-implementation']).not.toBe('planned');
  expect(operation).toMatchObject({
    operationId: 'getDict',
    'x-auth': 'none',
    'x-signed': false,
    'x-error-codes': [],
    'x-session-scopes': ['full', 'deletion_only'],
  });
});
