import { expect, it } from 'vitest';
import { contract, OPERATIONS, ROUTES } from './kit.ts';

it.each(OPERATIONS)(
  '[AC-F1-06x#23] %s 移除 planned，保持 admin 鉴权且无 step-up 或 Idempotency-Key',
  async (op) => {
    const doc = await contract();
    const operation = doc.paths[ROUTES[op]]!.post;
    expect(operation).not.toHaveProperty('x-implementation');
    expect(operation).toMatchObject({
      operationId: op === 'uploads' ? 'adminUploadPlatformIcon' : 'adminCreatePlatformIconVersion',
      'x-auth': 'admin',
      security: [{ adminBearerAuth: [] }],
      'x-error-codes': [10001, 10403, 20001],
    });
    expect(operation).not.toHaveProperty('x-step-up');
    expect(operation).not.toHaveProperty('x-idempotent', true);
    const headers = operation.parameters?.map((p) => p.name.toLowerCase()) ?? [];
    expect(headers).not.toContain('idempotency-key');
    expect(headers).not.toContain('x-step-up-token');
    if (op === 'uploads') {
      expect(operation.description).toMatch(/4096/);
      expect(operation.description).toContain('icon_format_invalid');
    }
  },
);
