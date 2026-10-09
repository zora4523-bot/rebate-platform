import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { apiRequire } from '../auth/kit.ts';
import { ROOT } from '../permissions/expected.ts';

it.each([
  ['/admin/v1/auth/step-up/sms-codes', 'post', 'adminSendStepUpSms'],
  ['/admin/v1/auth/step-up', 'post', 'adminStepUp'],
  ['/admin/v1/me/permissions', 'get', 'adminGetMyPermissions'],
])(
  '[AC-F1-06l#32] %s 的契约保留 operationId，完成实现后去掉 planned',
  async (path, method, operationId) => {
    const parser = apiRequire('@readme/openapi-parser') as {
      parse(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<string, Record<string, { operationId: string; 'x-implementation'?: string }>>;
      }>;
    };
    const doc = await parser.parse(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    });
    const operation = doc.paths[path]?.[method];
    expect(operation).toBeDefined();
    expect(operation!.operationId).toBe(operationId);
    expect(operation).not.toHaveProperty('x-implementation', 'planned');
  },
);
