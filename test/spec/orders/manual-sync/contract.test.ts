import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';

const ROOT = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));

interface Operation {
  operationId: string;
  'x-auth'?: string;
  'x-implementation'?: string;
  'x-error-codes'?: number[];
}

async function contract() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{ paths: Record<string, Record<string, Operation>> }>;
  };
  return parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
}

it.each([
  {
    path: '/admin/v1/order-syncs',
    method: 'post',
    operationId: 'adminCreateOrderSync',
    codes: [10001, 10403, 20001, 30156],
  },
  {
    path: '/admin/v1/order-syncs',
    method: 'get',
    operationId: 'adminListOrderSyncs',
    codes: [10001, 10403, 20001],
  },
  {
    path: '/admin/v1/order-syncs/limits',
    method: 'get',
    operationId: 'adminGetOrderSyncLimits',
    codes: [10001, 10403],
  },
])(
  '[AC-B1-09i#1] $operationId 去 planned，保留后台鉴权与错误码，路由校验随之生成',
  async ({ path, method, operationId, codes }) => {
    const operation = (await contract()).paths[path]?.[method];
    expect(operation).toBeDefined();
    expect(operation?.['x-implementation']).not.toBe('planned');
    expect(operation).toMatchObject({ operationId, 'x-auth': 'admin' });
    expect([...(operation?.['x-error-codes'] ?? [])].sort()).toEqual([...codes].sort());
    expect(Object.keys(CONTRACT_ROUTE_SCHEMAS)).toContain(operationId);
  },
);
