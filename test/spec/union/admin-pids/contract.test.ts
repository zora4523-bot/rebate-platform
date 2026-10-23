import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { apiRequire } from '../../admin/auth/kit.ts';

const operations = [
  ['get', '/admin/v1/union-pids', 'adminListUnionPids'],
  ['post', '/admin/v1/union-pids', 'adminCreateUnionPid'],
  ['patch', '/admin/v1/union-pids/{pid_id}', 'adminUpdateUnionPid'],
  ['post', '/admin/v1/union-pids/{pid_id}/activate', 'adminActivateUnionPid'],
  ['post', '/admin/v1/union-pids/{pid_id}/retire', 'adminRetireUnionPid'],
] as const;

it.each(operations)(
  '[AC-B1-22h#40] %s %s 上线移除 planned，保留 admin 身份与无幂等键契约',
  async (method, path, operationId) => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<
          string,
          Record<
            string,
            {
              operationId: string;
              'x-implementation'?: string;
              'x-auth': string;
              parameters: { name: string }[];
            }
          >
        >;
      }>;
    };
    const doc = await parser.dereference(
      fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
      { resolve: { external: false } },
    );
    const operation = doc.paths[path]?.[method];
    expect(operation).toBeDefined();
    expect(operation!['x-implementation']).not.toBe('planned');
    expect(operation!.operationId).toBe(operationId);
    expect(operation!['x-auth']).toBe('admin');
    const parameters = operation!.parameters.map((p) => p.name.toLowerCase());
    expect(parameters).not.toContain('idempotency-key');
    if (method === 'get') expect(parameters).not.toContain('x-step-up-token');
    else expect(parameters).toContain('x-step-up-token');
    expect(doc.paths[path]).not.toHaveProperty('delete');
  },
);
