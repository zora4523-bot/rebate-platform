import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { apiRequire } from '../../../admin/auth/kit.ts';
import { OPERATIONS, ROUTES } from './kit.ts';

async function contract() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      info: { description: string };
      paths: Record<
        string,
        Record<
          string,
          {
            operationId: string;
            parameters?: { name: string }[];
            responses: Record<
              string,
              { content: Record<string, { example: { data: { latest_version: number } } }> }
            >;
          }
        >
      >;
    }>;
  };
  return parser.dereference(
    fileURLToPath(new URL('../../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
}

it.each(OPERATIONS)(
  '[AC-F1-06y#24] %s 去除 planned，保留 admin 鉴权且不要求 step-up 或 Idempotency-Key',
  async (op) => {
    const doc = await contract();
    const route = ROUTES[op];
    const operation = doc.paths[route.path]![route.method.toLowerCase()]!;
    expect(operation).toMatchObject({
      operationId: {
        source: 'adminUpdatePlatformIconVersion',
        publish: 'adminPublishPlatformIcon',
        restore: 'adminRestoreBuiltinPlatformIcon',
      }[op],
      'x-auth': 'admin',
      security: [{ adminBearerAuth: [] }],
      'x-error-codes': [10001, 10403, 20001, 20902],
    });
    expect(operation).not.toHaveProperty('x-implementation');
    expect(operation).not.toHaveProperty('x-step-up');
    expect(operation).not.toHaveProperty('x-idempotent', true);
    expect(operation.parameters?.map((p) => p.name.toLowerCase()) ?? []).not.toContain(
      'idempotency-key',
    );
    expect(operation.parameters?.map((p) => p.name.toLowerCase()) ?? []).not.toContain(
      'x-step-up-token',
    );
  },
);

it('[AC-F1-06y#25] 回滚响应示例保存的最新版本仍为 3，不被当前版本 2 覆盖', async () => {
  const doc = await contract();
  expect(
    doc.paths[ROUTES.publish.path]!.post!.responses['200']!.content['application/json']!.example
      .data.latest_version,
  ).toBe(3);
});

it('[AC-F1-06y#26] 总述说明后台原路退款是 Idempotency-Key 例外', async () => {
  const doc = await contract();
  expect(doc.info.description).toMatch(
    /(?:except|excluding)[^.\n]*(?:refund)|(?:refund)[^.\n]*(?:except|exception)|除原路退款外/i,
  );
});
