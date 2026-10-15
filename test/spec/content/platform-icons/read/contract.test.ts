import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { apiRequire } from '../../../admin/auth/kit.ts';

it.each([
  ['/admin/v1/platform-icons', 'adminListPlatformIcons'],
  ['/admin/v1/platform-icons/{key}/versions', 'adminListPlatformIconVersions'],
])('[AC-F1-06w#16] %s 保持 admin 鉴权并移除 planned 标记', async (path, operationId) => {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      paths: Record<string, { get: Record<string, unknown> }>;
    }>;
  };
  const doc = await parser.dereference(
    fileURLToPath(new URL('../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  expect(doc.paths[path]?.get).toMatchObject({ operationId, 'x-auth': 'admin' });
  expect(doc.paths[path]!.get).not.toHaveProperty('x-implementation');
});
