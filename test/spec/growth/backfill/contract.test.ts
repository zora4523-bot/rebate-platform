import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);

it('[AC-B1-11e#13] bindInviter 取消 planned 并生成请求校验，保持 phone、签名和幂等且不进入 Agent 白名单', async () => {
  const parser = createRequire(new URL('apps/api/package.json', ROOT))(
    '@readme/openapi-parser',
  ) as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      paths: Record<string, { post: Record<string, unknown> }>;
    }>;
  };
  const document = await parser.dereference(
    fileURLToPath(new URL('contracts/openapi.yaml', ROOT)),
    {
      resolve: { external: false },
    },
  );
  const operation = document.paths['/v1/me/inviter']!.post;
  expect(operation['x-implementation']).toBeUndefined();
  expect(operation).toMatchObject({
    operationId: 'bindInviter',
    'x-auth': 'phone',
    'x-signed': true,
    'x-idempotent': true,
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['invite_code'],
            properties: { invite_code: { type: 'string', maxLength: 64 } },
          },
        },
      },
    },
  });
  const projection = (await import(
    new URL('apps/api/src/modules/platform/validation/route-schemas.gen.ts', ROOT).href
  )) as {
    CONTRACT_ROUTE_SCHEMAS: Record<string, { body?: { properties?: Record<string, unknown> } }>;
  };
  expect(projection.CONTRACT_ROUTE_SCHEMAS).toHaveProperty('bindInviter');
  expect(Object.keys(projection.CONTRACT_ROUTE_SCHEMAS['bindInviter']!.body!.properties!)).toEqual([
    'invite_code',
  ]);
  const allowlist = readFileSync(new URL('specs/agent-tools.allowlist', ROOT), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'));
  expect(allowlist.length).toBeGreaterThan(0);
  expect(
    allowlist.filter((name) =>
      /bind.?inviter|invite.*bind|bind.*invite|backfill|\/v1\/me\/inviter/i.test(name),
    ),
  ).toEqual([]);
});
