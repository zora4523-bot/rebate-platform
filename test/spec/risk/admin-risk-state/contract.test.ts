import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { apiRequire } from '../../admin/auth/kit.ts';
import { ROOT } from './kit.ts';

it('[AC-F1-07d#29] risk-state 去掉 planned，保留 admin、动态码及无幂等键契约', async () => {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      paths: Record<
        string,
        {
          put: {
            operationId: string;
            'x-auth': string;
            'x-implementation'?: string;
            parameters: { name: string }[];
          };
        }
      >;
    }>;
  };
  const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
  const op = doc.paths['/admin/v1/users/{user_id}/risk-state']?.put;
  expect(op).toBeDefined();
  expect(op!['x-implementation']).not.toBe('planned');
  expect(op!.operationId).toBe('adminUpdateUserRiskState');
  expect(op!['x-auth']).toBe('admin');
  expect(op!.parameters.map((p) => p.name.toLowerCase())).toContain('x-step-up-token');
  expect(op!.parameters.map((p) => p.name.toLowerCase())).not.toContain('idempotency-key');
});
