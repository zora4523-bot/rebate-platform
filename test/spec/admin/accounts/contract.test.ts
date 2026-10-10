import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { apiRequire, SUPER } from '../auth/kit.ts';

it.each([
  [SUPER, 'adminListAdmins'],
  [`${SUPER}/{admin_id}`, 'adminGetAdmin'],
])('[AC-F1-06m#15] %s 保持 super 鉴权并移除 planned 标记', async (path, operationId) => {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      paths: Record<string, { get: Record<string, unknown> }>;
    }>;
  };
  const doc = await parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  expect(doc.paths[path]?.get).toMatchObject({ operationId, 'x-auth': 'super' });
  // Test-phase source stays unchanged; the implementer removes just these two markers.
  expect(doc.paths[path]!.get['x-implementation']).not.toBe('planned');
});
