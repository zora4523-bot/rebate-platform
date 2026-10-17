import { expect, it } from 'vitest';
import { CONTRACT_ROUTE_SCHEMAS } from '../../../../apps/api/src/modules/platform/validation/route-schemas.gen.ts';
import { contract, ROUTES } from './kit.ts';

it.each(Object.values(ROUTES))(
  '[AC-F1-09f#1] $id 去 planned、生成请求校验并保留 admin 鉴权且不加 step-up',
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
