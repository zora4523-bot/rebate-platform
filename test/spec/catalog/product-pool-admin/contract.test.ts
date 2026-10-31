import { expect, it } from 'vitest';
import { contract, ROUTES } from './kit.ts';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';

it.each(Object.values(ROUTES))(
  '[AC-B1-05q#1] $id 去 planned、有生成的请求校验，保留 admin 鉴权且不加 step-up',
  async (route) => {
    const doc = await contract();
    const operation = doc.paths[route.path]![route.method.toLowerCase()]!;
    expect(operation).toMatchObject({
      operationId: route.id,
      'x-auth': 'admin',
      security: [{ adminBearerAuth: [] }],
    });
    expect(operation).not.toHaveProperty('x-implementation');
    expect(operation).not.toHaveProperty('x-step-up');
    expect(operation.parameters?.map((p) => p.name.toLowerCase()) ?? []).not.toContain(
      'x-step-up-token',
    );
    expect(CONTRACT_ROUTE_SCHEMAS).toHaveProperty(route.id);
  },
);
